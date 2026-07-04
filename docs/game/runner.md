### Runner（1試合実行プロセス）の実装計画

Runner は1プロセスにつき1試合だけを担当する独立プロセスである。Server（`apps/server`）は `POST /api/matches` を受けると、試合数ぶんの Runner を並列に spawn し、各 Runner の標準出力から frame / result event を受け取る。Runner は HTTP API や履歴保存を持たず、試合実行に必要な WebSocket endpoint と `GameLoop` だけを持つ。

#### 🛠️ コア実装スペック (Bun)

- **パッケージ:** `apps/runner`
- **主な責務:**

1. `GameLoop`、`AgentSession`、マップ・センサー・観測生成 engine を保持する。
2. 起動時に `--port` / `--match-id` / `--t-max` / `--height` / `--width` / `--seed` を受け取り、指定ポートで1試合専用の WebSocket server を開く。
3. `/ws/agent/duck` と `/ws/agent/sphinx` で Adaptor（`docs/game/adaptor.md`）の接続を待ち、両者が揃ったら `GameLoop` を開始する。
4. 各フレームを stdout の JSON line event として Server へ返す。
5. 決着時は全 frame と `EpisodeResult` を含む result event を stdout に出力し、agent 接続を閉じてプロセスを終了する。

#### Runner event

Runner は stdout に JSON Lines を出力する。ログ用途の文字列は stdout へ出さず、stderr へ出す。

```json
{ "type": "status", "matchId": "...", "state": "running" }
```

```json
{ "type": "frame", "matchId": "...", "frame": { "type": "frame" } }
```

```json
{
    "type": "result",
    "matchId": "...",
    "id": "...",
    "startedAt": "2026-07-06T00:00:00.000Z",
    "finishedAt": "2026-07-06T00:00:05.000Z",
    "result": { "status": "WIN", "winner": "DUCK" },
    "frames": []
}
```

Server は `result` event を受け取って履歴保存と勝率集計に反映する。Runner 側は履歴ストレージを知らない。エージェントの賢さレベルやマトリクス実験IDは Server が Runner 終了結果へ付与して保存するため、Runner の event schema には含めない。

#### 並列実行

- Server は論理CPUコア数を基準にした同時実行上限内で複数 Runner を spawn し、上限を超える開始要求は内部キューに積む。
- 同時実行枠が空いたら、Server はキューの先頭から順に Runner を spawn する。
- Runner ごとに localhost の空きポートを払い出す。
- Server は各 Runner の `/health` を待ってから、duck/sphinx の Adaptor をその Runner の `/ws/agent/...` へ向けて spawn する。
- Runner 間で `AgentSession` / `GameLoop` / frame buffer は共有しない。

#### Adaptor との関係

旧ドキュメントで `AgentRunner` と呼んでいた「C++ エージェントを spawn して標準入出力を WebSocket に変換する層」は、現在は Adaptor（`apps/adaptor`）と呼ぶ。Runner は C++ バイナリを直接 spawn しない。Runner はあくまで WebSocket 接続済みの duck/sphinx Adaptor と通信して試合を進める。
