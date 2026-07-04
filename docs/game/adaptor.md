# AIエージェント通信アダプター仕様書

## 1. システム概要と責務

本アダプターは、ゲームサーバー（WebSocket）とAIエージェント（コンソールアプリケーション）の間に介在し、双方向のプロトコル・ストリーム変換を行うプロキシプロセスである。

```
+-------------------+                 +---------------------+                 +-------------------+
|  Game Server      | --(WebSocket)-->|  ws-stdio-adaptor   | --(stdin \n)--> |  C++ Agent        |
|  (Bun.serve)      | <-- (JSON) -----|  (Bun / Node / Py)  | <-- (stdout)--- |  (AI Engine)      |
+-------------------+                 +---------------------+                 +-------------------+
                                                 |
                                                 +-- (stderr) --------------> [コンソールログ出力]

```

### コア責務

1. **プロセス管理:** 指定されたC++エージェントの実行バイナリを子プロセスとして起動・監視し、終了時にはリソースを安全に解放する。
2. **下り変換 (Server $\rightarrow$ Agent):** サーバーからWebSocket経由で受信したJSONデータフレームに改行コード (`\n`) を付与し、C++プロセスの**標準入力 (`stdin`)** へストリーミングする。
3. **上り変換 (Agent $\rightarrow$ Server):** C++プロセスの**標準出力 (`stdout`)** から改行コード (`\n`) 区切りで文字列（行動コマンド等）を読み取り、WebSocketメッセージとしてサーバーへ送信する。
4. **デバッグ分離:** C++プロセスの**標準エラー出力 (`stderr`)** は、通信プロトコルに混ぜず、アダプター実行環境のコンソールへそのまま転送（透過）する。

---

## 2. 起動仕様とCLIインターフェース

アダプターはターミナル等からCLIコマンドとして起動可能にし、接続先や実行するバイナリを引数で指定できるようにする。

### 起動構文（例: Bunで実装する場合）

```bash
bun run adaptor.ts --url <WEBSOCKET_URL> --exec "<COMMAND_TO_RUN>"

```

| 引数・オプション | 必須/任意 | 説明                                                         | 例                               |
| ---------------- | --------- | ------------------------------------------------------------ | -------------------------------- |
| `--url` / `-u`   | 必須      | ゲームマスター（WebSocketサーバー）の接続先URL               | `ws://localhost:3000/agent/duck` |
| `--exec` / `-e`  | 必須      | 起動するC++エージェントの実行コマンド・パス                  | `./build/wheelduck_agent`        |
| `--token` / `-t` | 任意      | 認証やプレイヤー識別用のトークン（クエリパラメータ等で使用） | `duck_player_01`                 |

---

## 3. データ通信フローと変換ルール

### ① 下りストリーム（観測データの受信：Server $\rightarrow$ C++）

1. アダプターは WebSocket でサーバーからデータフレーム（基本的に文字列 / JSON）を受信する。
2. 受信した文字列の末尾に改行コード (`\n`) がない場合は自動補完する。
3. C++プロセスの `stdin` に書き込み、即座にバッファをフラッシュ（`flush`）する。
4. **【C++側の要件】** C++エージェントは `std::getline(std::cin, line)` またはこれに準ずる方法で1行読み取るだけで、サーバーからの観測 JSON を完全に取得できる。

### ② 上りストリーム（行動コマンドの送信：C++ $\rightarrow$ Server）

1. C++エージェントが決定した行動文字列またはJSONを `std::cout << "ACTION: RIGHT" << std::endl;` のように改行付きで出力する。
2. アダプターは C++の `stdout` を非同期で監視し、改行コード (`\n` または `\r\n`) をトリガーとして1行分の文字列を切り出す。
3. 切り出した文字列の前後空白・改行（トリム処理）を行い、WebSocketの `send()` メソッドでサーバーへ送信する。
4. **【C++側の要件】** データの書き出し後、必ず `std::endl` を使うか `std::cout.flush()` を呼び出し、バッファリングによる遅延（デッドロック）を防ぐこと。

### ③ デバッグストリーム（ログ出力：C++ $\rightarrow$ コンソール）

- C++コード内で `std::cerr << "[DEBUG] Danger map peak at (3, 4)" << std::endl;` と出力した内容は、すべてアダプターを起動しているターミナル画面に表示される。
- これにより、「ゲームサーバーの通信プロトコルを汚すことなく、自由にC++コードのデバッグ出力を行うこと」が可能になる。

---

## 4. ライフサイクル・異常系処理仕様

通信切断やプロセス異常終了が発生した際のフェイルセーフ動作を規定する。

| イベント・異常状態                   | アダプターの処理仕様                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **接続確立前 (起動直後)**            | WebSocketの接続 (`open` イベント) が完了するまで、C++プロセスの起動を待機するか、起動しても入力流し込みを保留する。                                                         |
| **C++プロセスの自然終了/クラッシュ** | C++プロセスが終了(`exit`)、または異常終了(`SIGSEGV`等)した場合、エラーログを出力し、即座にWebSocket切断 (`close(1011, "Agent crashed")`) を行ってアダプター自身も終了する。 |
| **WebSocketサーバーからの切断**      | サーバー側から切断(`close`)された場合、C++プロセスの `stdin` を閉じ、プロセスに `SIGTERM` を送信して優しく終了させる。一定時間応答がなければ `SIGKILL` で強制終了する。     |
| **サーバーへの再接続 (オプション)**  | 今回の対戦用途では**再接続は行わず**、1エピソード（または1セッション）終了とともにアダプターも終了する潔い設計とする。                                                      |

---

## 5. 参考実装スクリプト (Bun / TypeScript)

上記仕様を充たす最小限のアダプターの実装スケッチです。これ1枚（約50行）あればすぐに動作します。

```typescript
// adaptor.ts
import { spawn } from "bun";

// 引数簡易パース (本来は util/parseArgs を推奨)
const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const execIndex = args.indexOf("--exec");

if (urlIndex === -1 || execIndex === -1) {
    console.error("Usage: bun run adaptor.ts --url <WS_URL> --exec <BINARY_PATH>");
    process.exit(1);
}

const wsUrl = args[urlIndex + 1];
const execCmd = args[execIndex + 1];

console.log(`[Adapter] Connecting to ${wsUrl}...`);
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
    console.log(`[Adapter] Connected! Spawning agent: ${execCmd}`);

    // C++ プロセスの起動
    const proc = spawn(execCmd.split(" "), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit", // stderrはそのままターミナルへ透過
    });

    // ① 上り: C++ (stdout) -> WebSocket
    const sendStdoutToWs = async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split(/\r?\n/);

                // 最後の要素は次のパケットの不完全な断片かもしれないので残す
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (line.trim().length > 0 && ws.readyState === WebSocket.OPEN) {
                        ws.send(line.trim());
                    }
                }
            }
        } catch (e) {
            console.error("[Adapter] Stdout read error:", e);
        }
    };

    sendStdoutToWs();

    // ② 下り: WebSocket -> C++ (stdin)
    ws.onmessage = event => {
        const data = typeof event.data === "string" ? event.data : event.data.toString();
        const payload = data.endsWith("\n") ? data : data + "\n";

        try {
            proc.stdin.write(payload);
            proc.stdin.flush();
        } catch (e) {
            console.error("[Adapter] Failed to write to agent stdin:", e);
        }
    };

    // 終了処理
    ws.onclose = () => {
        console.log("[Adapter] WebSocket closed. Terminating agent...");
        proc.kill();
        process.exit(0);
    };

    proc.exited.then(code => {
        console.log(`[Adapter] Agent exited with code ${code}. Closing WebSocket...`);
        ws.close(1000, "Agent exited");
        process.exit(code);
    });
};

ws.onerror = err => {
    console.error("[Adapter] WebSocket Error:", err);
    process.exit(1);
};
```
