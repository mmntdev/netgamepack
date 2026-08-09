# NET GAME PACK 🕹️

ブラウザだけで、みんなで遊べるオンラインミニゲーム集。
トップページでゲームを選び、4文字のルームコード(または招待リンク)を友だちに共有して一緒に遊べます。

## 収録ゲーム

| ゲーム | 人数 | 内容 |
| --- | --- | --- |
| 🧱 みんなでブロック崩し | 1〜4人(協力) | ライフ共有・スコア個人戦。パワーアップ(マルチボール / パドル拡大 / スロー / 残機+1)つき。途中参加OK |
| 🏓 対戦 PONG | 2人(対戦) | 先に7点取ったほうが勝ち。3人目以降は観戦モード |

サーバー権威(server-authoritative)方式で、物理演算はすべてサーバー(60Hz)で行い、
クライアントには 20Hz でスナップショットを配信して補間描画します。

## ローカルで動かす

```bash
npm install
npm start
# → http://localhost:3000
```

テスト(サーバーを起動して2クライアントで実際にプレイするスモークテスト):

```bash
npm install          # devDependencies も入れる
npm test
```

## Render にデプロイする

このリポジトリは [Render](https://render.com) の Blueprint(`render.yaml`)に対応しています。

### 方法1: Blueprint(推奨)

1. このリポジトリを自分の GitHub にプッシュ
2. Render ダッシュボード → **New +** → **Blueprint**
3. リポジトリを選択すると `render.yaml` が読み込まれ、Web Service が自動作成される
4. デプロイ完了後に発行される URL にアクセス

### 方法2: 手動で Web Service を作成

1. Render ダッシュボード → **New +** → **Web Service** → リポジトリを選択
2. 設定:
   - **Runtime**: Node
   - **Build Command**: `npm ci --omit=dev`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/healthz`
3. **Create Web Service** で完了

ポートは環境変数 `PORT` から自動で読み取ります(Render が自動設定)。
WebSocket(Socket.IO)は Render の Web Service でそのまま動作します。

> **無料プランの注意**: Free プランのサービスは15分間アクセスがないとスリープし、
> 次のアクセス時の起動に数十秒かかります。スリープするとルーム状態(メモリ上)は消えます。

## アーキテクチャ

```
server/
  index.js        # Express + Socket.IO エントリポイント(/healthz, /api/games, /api/stats)
  roomManager.js  # ルーム作成/参加/観戦/ホスト移譲/ゲームループ(60Hz tick, 20Hz 配信)
  games/
    index.js      # ゲームレジストリ
    breakout.js   # ブロック崩しのサーバーロジック
    pong.js       # PONG のサーバーロジック
public/
  index.html      # ゲーム選択画面
  css/style.css   # 共通スタイル
  js/lobby.js     # 共通クライアント(ルームUI・スナップショット補間・入力送信)
  breakout/       # ブロック崩しクライアント
  pong/           # PONG クライアント
```

## 新しいゲームの追加方法

1. `server/games/<id>.js` を作成し、`{ meta, Game }` をエクスポートする
   - `meta`: `{ id, name, description, minPlayers, maxPlayers, allowJoinInProgress, path }`
   - `Game` クラス: `constructor(players)` / `addPlayer` / `removePlayer` /
     `handleInput(id, data)` / `tick(dt)` / `serialize()` / `finished` / `result` / `playerCount`
2. `server/games/index.js` のリストに追加
3. `public/<id>/` にクライアントページを作成(`js/lobby.js` の `NetGame.createClient()` を利用)

ゲーム選択画面は `/api/games` から自動生成されるため、上記だけで新ゲームが一覧に並びます。
