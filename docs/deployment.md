### Docker Compose 構成

`overview.md` 3章の「競技AIコンテスト方式（プロセス分離型）」を、Server コンテナ内の複数プロセス（Server / Runner / Adaptor / C++ agent）と Visualizer コンテナへ対応付けている。

Dockerfile は開発用（`docker/dev/`）と本番用（`docker/prod/`）に分かれている。

#### 開発用（`docker-compose.yml`）

| コンテナ     | Dockerfile                         | 役割                                                                                                                                                           |
| ------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`     | `docker/dev/server.Dockerfile`     | API、観戦 WebSocket、履歴保存、勝率集計、Runner / Adaptor プロセス管理を担当する。C++エージェントもビルド済みで保持し、試合開始ごとに Adaptor 経由で起動する。 |
| `visualizer` | `docker/dev/visualizer.Dockerfile` | React ビジュアライザ（`apps/visualizer`）を Vite dev server で配信する。ブラウザは `server` の公開ポート（3000）へ直接 API / WebSocket 通信する。              |

ソースは `apps/` を bind mount しており、ホスト側の変更がコンテナに反映される。

```bash
docker compose up --build
```

#### 本番用（`docker-compose.prod.yml`）

`server` と `client` の2コンテナで構成する。ソースは image に焼き込まれ、bind mount は行わない。プロジェクト名の衝突を避けるため `docker-compose.prod.yml` には `name: univ-2026-csc-t272-project-prod` を明示している（未指定だと開発用 `docker-compose.yml` とコンテナ名・イメージ名が衝突し、互いのコンテナを上書きしてしまう）。

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

##### `server`（`docker/prod/server.Dockerfile`）

マルチステージビルドで次の3段階に分離し、実行に必要な最小限のファイルのみを含む軽量イメージにしている。

1. `agents`: C++ エージェント（duck/sphinx）をビルド
2. `deps` → `build`: production 依存関係のみをインストールし、Server / Runner / Adaptor の各エントリポイント（`src/main.ts`）を `bun build` で単一の JS ファイル（`dist/main.js`）にバンドル。TS を都度トランスパイルせず、ビルド済み JS を実行することで起動・実行速度を稼ぐ
3. `runtime`: 各 `dist/main.js` とビルド済みエージェントバイナリのみを含む最終イメージ。ソースや `node_modules` は含まない

Runner / Adaptor の起動コマンドは `--runner-entry` / `--adaptor-entry` で切り替え可能（既定は開発時と同じ `apps/*/src/main.ts`）。本番イメージの `CMD` はこれらを `apps/runner/dist/main.js` / `apps/adaptor/dist/main.js` に向けている。

Server 自体のホストポート公開は行わない。`client` コンテナ（nginx）から compose 内部ネットワーク経由の `server:3000` としてのみ到達可能にし、外部には晒さない。

##### `client`（`docker/prod/visualizer.Dockerfile`、`client` ターゲット）

`build` ステージでビジュアライザの静的ファイルをビルドし、`nginx:alpine` ベースの `client` ステージへ配置して配信する。設定は `docker/prod/nginx.conf`。

パスオーバーライディングにより、単一オリジン（例: `https://example.com/`）を次のように振り分ける。

- `/api/`（HTTP API と `/api/ws/view` の観戦 WebSocket）: 内部ネットワークの `server:3000` へリバースプロキシ（パスは書き換えない。Server 自身のルートがすでに `/api` 配下にあるため）
- それ以外: ビジュアライザの静的ファイル（SPA のため未知パスは `index.html` にフォールバック）

ビジュアライザのビルド時、`VITE_SERVER_ORIGIN` は既定で `/`（＝配信元と同一オリジン）を指す。API を別オリジンで動かす場合のみ、`docker-compose.prod.yml` の `client.build.args.VITE_SERVER_ORIGIN` を変更する。

`artifact` ターゲット（`FROM scratch`）は静的ファイルのみを取り出したい場合向けに残している。

```bash
docker build -f docker/prod/visualizer.Dockerfile --target artifact --output type=local,dest=./dist/visualizer .
```

`server` の `ALLOWED_ORIGINS` は `client` が配信される実際のオリジン（既定値は `https://example.com` のプレースホルダー）に合わせて変更する。

Server 自身のルートはすべて `/api` 配下にある（`/api/matches`、`/api/health`、`/api/ws/view` の観戦 WebSocket）。開発用構成ではビジュアライザから直接 Server の公開ポートへアクセスするため URL にも `/api` が現れる（例: `http://localhost:3000/api/matches`）が、本番用構成ではさらに `client` のリバースプロキシがこのパスをそのまま `server:3000` へ転送する。

### 起動方法（共通）

- 開発用構成では `server` コンテナが `http://localhost:3000` に、ビジュアライザが `http://localhost:8080` で公開される。
- ビジュアライザは既定で表示ページと同じプロトコルを使って `localhost:3000` の Server へ接続する（開発用のみ有効なフォールバック）。HTTPS で配信する場合は Server 側も HTTPS / WSS で到達できるようにし、別 origin やリバースプロキシを使う場合はビルドまたは起動時に `VITE_SERVER_ORIGIN=https://...` を指定する。本番用構成（`docker-compose.prod.yml`）は既定でこの値を `/`（配信元と同一オリジン）に設定済み。
- 「試合の実行」ボタン（またはAPI呼び出し）をトリガーに、Server が Runner と duck/sphinx Adaptor を spawn して試合を開始する。
- 完了した対戦ログは `./data:/app/data` の bind mount により、リポジトリ直下の `data/matches/` に保存される。

### ローカル（Dockerなし）での起動手順

```bash
bun run build:agents
bun run start:server
bun run dev:visualizer
```

Server は試合開始要求ごとに Runner / Adaptor を自動起動するため、手動で Adaptor や Orchestrator を起動する必要はない。

ビルド済み JS で動作確認したい場合は次のようにする。

```bash
bun run build:agents
bun run build:server
bun run apps/server/dist/main.js --port 3000 --runner-entry apps/runner/dist/main.js --adaptor-entry apps/adaptor/dist/main.js
```
