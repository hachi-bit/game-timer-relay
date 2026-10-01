# game-timer-relay

GAS（Google Apps Script）から Discord API へのリクエストを中継する Vercel Function。

GAS は User-Agent を変更できず、Discord のボット通信がブロック（`40333 internal network error`）されるため、
このFunctionがボット用の User-Agent を付けて転送する。

## エンドポイント

`POST /api/discord`

- Header: `x-relay-secret: <RELAY_SECRET>`
- Body: `{ "method": "get", "path": "/channels/<CHANNEL_ID>/messages?limit=1", "body": null }`
- Discord のステータスコードと本文をそのまま返す

## 環境変数（Vercel の Settings → Environment Variables）

| 名前 | 内容 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord ボットのトークン |
| `RELAY_SECRET` | GAS と共有する合言葉（長いランダム文字列） |

許可しているのは、メッセージの取得・投稿、ボット自身のリアクションの付け外し、リアクションした人の一覧の取得だけ。
チャンネルは制限しない（触れるチャンネルはDiscord側でボットに見せる範囲で決まる）。
