### Server（API / Visualizer Gateway）の実装計画

Server はビジュアライザと Runner 群の間に立つ制御プロセスである。HTTP API、観戦 WebSocket、履歴保存、勝率集計を担当し、ゲームループそのものは1試合1プロセスの Runner（`docs/game/runner.md`）へ委譲する。

#### 🛠️ コア実装スペック (Bun)

- **パッケージ:** `apps/server`
- **使用API:** `Hono`（HTTPルーティング／CORS）+ `Bun.serve()`（観戦 WebSocket）+ `Bun.spawn()`（Runner / Adaptor 起動）+ `Bun.file`（対戦履歴 JSON 保存）
- **主な責務:**

1. **対戦開始 API:** `POST /api/matches` で `count`（省略時1）とエージェントの `duckLevel` / `sphinxLevel`（1〜10、省略時10）を受け取り、同時実行上限内で Runner プロセスを複数 spawn する。上限を超えた分は Server 内のキューで待機させる。
2. **Runner 管理:** Runner ごとに localhost の空きポートと `matchId` を払い出す。Runner の `/health` が応答した後、その Runner の `/ws/agent/duck`・`/ws/agent/sphinx` へ接続する Adaptor を spawn する。Adaptor の環境変数 `AGENT_INTELLIGENCE_LEVEL` で C++ エージェントへ賢さレベルを渡す。
3. **観戦配信:** 各 Runner の stdout から受け取った frame event を `/api/ws/view` の観戦者へブロードキャストする。複数 Runner が並列に動く場合、frame には `matchId` を含める。
4. **履歴保存:** Runner の result event を受け取り、行動トレースと telemetry を含む全 `PublicFrame`、終了結果、エージェント設定を試合単位の JSON ログへ保存する。
5. **履歴 API / 勝率集計:** 保存済み履歴を一覧・取得・削除・集計できる HTTP API を提供し、賢さレベルの組み合わせごとの勝率マトリクスも返す。

#### API

- `POST /api/matches`: `{ "count": number, "duckLevel": number, "sphinxLevel": number, "seed": number }` 件の試合をキューへ投入する。`duckLevel` / `sphinxLevel` は1〜10で、省略時は10。成功時は `{ ok: true, accepted }` を返す。不正な `count` / レベルまたはキュー上限超過は409、Runner 起動失敗は500。
- `POST /api/matches/intelligence-matrix`: `{ "duckLevels": number[], "sphinxLevels": number[], "trialsPerCell": number, "seed": number }` を受け取り、全組み合わせをキューへ投入する。各試合の履歴には同一の `matrixRunId` と連番の `matrixTrial` が保存され、レスポンスにも `matrixRunId` が含まれる。
- `GET /api/matches`: 完了した対戦の概要を終了日時の降順で返す。
- `GET /api/matches/stats`: 保存済み対戦全体から総試合数、二号勝数、スフィンクス勝数、引き分け数、各割合を返す。
- `GET /api/matches/intelligence-matrix`: 保存済み対戦を `duckLevel` × `sphinxLevel` ごとに集計し、各セルの試合数・勝数・勝率を返す。`matrixRunId` クエリを指定すると、その実験の対戦だけを集計する。
- `GET /api/matches/status`: Server の実行状態、起動中試合数、実行中試合数、キュー待ち試合数、同時実行上限を返す。
- `PUT /api/matches/concurrency`: `{ "maxConcurrentMatches": number }` を受け取り、Server の同時実行上限を更新する。更新後、待機中キューがあれば新しい上限まで開始する。
- `GET /api/matches/:id`: 概要と全フレームを含むリプレイを返す。存在しない ID は404。
- `DELETE /api/matches`: 保存済み JSON ログを全削除し、削除件数を返す。
- `GET /api/ws/view`: Runner から集約した status / frame を観戦者へ配信する。

#### 対戦履歴

既定の保存先は `data/matches/`、`MATCH_HISTORY_DIR` で変更可能とする。書き込み途中のログを API が読むことを防ぐため、一時ファイルへの書き込み後に rename する。履歴保存に失敗しても Server は Runner の終了処理を行い、次の対戦開始を妨げない。

#### 動作モード

- **リアルタイム観戦:** Server が Runner の frame event を受け取り、観戦 WebSocket へ中継する。
- **複数試合実行:** Server は論理CPUコア数を基準にした上限まで複数 Runner を並列 spawn し、超過分はキューから順次開始する。それぞれの result event を履歴へ保存する。ビジュアライザのライブ盤面はフレーム混在を避けるため最初に届いた `matchId` を追跡し、全試合の結果は履歴一覧・勝率集計に反映する。
- **バッチ実験:** 可視化クライアントを開かない場合でも、同じ `POST /api/matches` と Runner / Adaptor 経路を使って複数試行を実行する。
