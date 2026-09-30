/**
 * GAS → Discord の中継（Vercel Serverless Function）
 *
 * GASはUser-Agentを変更できず、Discordのボット通信がブロック（40333）されるため、
 * このFunctionがボット用の正しいUser-Agentを付けてDiscord APIへ転送する。
 *
 * リクエスト（GASから）:
 *   POST /api/discord
 *   Header: x-relay-secret: <RELAY_SECRET>
 *   Body(JSON): { "method": "get|post|put|delete", "path": "/channels/...", "body": {...} }
 * レスポンス: Discordのステータスコードと本文をそのまま返す
 *
 * 環境変数（Vercelで設定）:
 *   DISCORD_BOT_TOKEN : Discordボットのトークン
 *   RELAY_SECRET      : GASと共有する合言葉（長いランダム文字列）
 *   （チャンネル制限なし。ボットに見せるチャンネルはDiscord側の権限で絞る）
 */
const crypto = require('crypto');

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/hachi-bit/game-timer-relay, 1.0)';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// 許可するパス：メッセージ取得・投稿・リアクションのみ（チャンネルは問わない）
// どのチャンネルを触れるかは、Discord側でボットに見せるチャンネルで制御する
function isAllowedPath(method, path) {
  const m = path.match(/^\/channels\/\d+\/messages(.*)$/);
  if (!m) return false;
  const rest = m[1];
  if (rest === '' || rest.startsWith('?')) return method === 'GET' || method === 'POST';
  // ボット自身のリアクションを付ける・外す
  if (/^\/\d+\/reactions\/[^/?]+\/@me$/.test(rest)) return method === 'PUT' || method === 'DELETE';
  // リアクションした人の一覧を取る（承認判定用）
  if (/^\/\d+\/reactions\/[^/?]+(\?.*)?$/.test(rest)) return method === 'GET';
  return false;
}

module.exports = async (req, res) => {
  const { DISCORD_BOT_TOKEN, RELAY_SECRET } = process.env;
  if (!DISCORD_BOT_TOKEN || !RELAY_SECRET) {
    return res.status(500).json({ error: 'relay not configured' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!safeEqual(req.headers['x-relay-secret'], RELAY_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = null; }
  }
  const method = String((payload && payload.method) || '').toUpperCase();
  const path = String((payload && payload.path) || '');
  if (!METHODS.includes(method) || !isAllowedPath(method, path)) {
    return res.status(400).json({ error: 'bad request' });
  }

  const init = {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'User-Agent': USER_AGENT,
    },
  };
  if (payload.body !== undefined && payload.body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload.body);
  }

  try {
    const r = await fetch(API + path, init);
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: 'upstream fetch failed' });
  }
};
