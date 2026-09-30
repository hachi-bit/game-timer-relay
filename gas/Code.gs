/**
 * ゲーム時間記録ボット（Discord × GAS × Vercel中継）
 * 1分ごとのトリガーで main() を実行する
 *
 * 初回の手順:
 *   1. setupProperties() を実行（スクリプトプロパティの枠が「未設定」で作られる）
 *   2. プロジェクトの設定 → スクリプト プロパティで値を入力し、checkProperties() で確認
 *   3. testRelay() を実行して、中継経由でDiscordと通信できるか確認
 *   4. setup() を実行（シート作成・トリガー登録）
 */

// ===== 設定 =====
const SHEET_NAME = '記録';
const WEEKLY_LIMIT_MIN = 21 * 60;   // 週の上限（分）
const SECOND_NOTICE_MIN = 10;       // 1回目の通知から2回目までの分数
const NIGHT_START = 23;             // 深夜の開始（時）
const NIGHT_END = 6;                // 深夜の終了（時）
const NIGHT_INTERVAL_MIN = 10;      // 深夜・開始中でないときの確認間隔（分）

// 列番号
const C = { START: 1, LIMIT: 2, END: 3, MIN: 4, STATUS: 5, N1: 6, N2: 7, MSGID: 8, NOTE: 9 };
const ST = { ACTIVE: '開始中', DONE: '終了', FORGOT: '終了忘れ', CANCEL: '取消' };

// ===== スクリプトプロパティの枠を作る（最初に1回だけ実行） =====
// 値はコードに書かず、実行後に「プロジェクトの設定 → スクリプト プロパティ」で入力する。
// すでに値が入っている項目は上書きしない。
const PROP_DEFAULTS = {
  RELAY_URL: 'https://game-timer-relay.vercel.app/api/discord',
  RELAY_SECRET: '未設定',
  CHANNEL_ID: '未設定',
  CHILD_USER_ID: '未設定',
};

function setupProperties() {
  const p = PropertiesService.getScriptProperties();
  const created = [];
  for (const [k, v] of Object.entries(PROP_DEFAULTS)) {
    if (!p.getProperty(k)) { p.setProperty(k, v); created.push(k); }
  }
  p.deleteProperty('DISCORD_BOT_TOKEN'); // トークンはVercel側だけに置く
  Logger.log(created.length ? '作成したで：' + created.join(', ') : '全部そろってたで');
  checkProperties();
}

// 値が入っているか確認する
function checkProperties() {
  const p = PropertiesService.getScriptProperties();
  const missing = Object.keys(PROP_DEFAULTS).filter(k => !p.getProperty(k) || p.getProperty(k) === '未設定');
  if (missing.length) {
    Logger.log('「未設定」のままの項目：' + missing.join(', ') + '\nプロジェクトの設定 → スクリプト プロパティで値を入れてな');
  } else {
    Logger.log('プロパティは全部入ってるで');
  }
}

// 合言葉を作る（VercelとGASの両方に同じ値を入れる）
function makeSecret() {
  Logger.log(Utilities.getUuid() + Utilities.getUuid());
}

// 中継経由でDiscordと通信できるか確認
function testRelay() {
  const ch = prop('CHANNEL_ID');
  const msgs = api('get', `/channels/${ch}/messages?limit=1`);
  Logger.log('取得OK：' + msgs.length + '件');
  api('post', `/channels/${ch}/messages`, { content: '中継テストやで' });
  Logger.log('投稿OK：チャンネルを確認してな');
}

// ===== 初期設定（最初に1回だけ実行） =====
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['開始日時', '制限時間(h)', '終了日時', 'プレイ時間(分)', '状態', '通知1', '通知2', '開始メッセージID', '備考']);
    sh.setFrozenRows(1);
  }
  // 既存メッセージは処理しない
  const msgs = api('get', `/channels/${prop('CHANNEL_ID')}/messages?limit=1`);
  PropertiesService.getScriptProperties().setProperty('LAST_MESSAGE_ID', msgs.length ? msgs[0].id : '0');
  // トリガーを登録し直す
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'main')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyMinutes(1).create();
  Logger.log('セットアップ完了');
}

// ===== メイン処理 =====
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const now = new Date();
    const h = now.getHours();
    const isNight = (h >= NIGHT_START || h < NIGHT_END);
    if (isNight && !findActiveRow() && now.getMinutes() % NIGHT_INTERVAL_MIN !== 0) return;

    processMessages();
    checkNotices(new Date());
  } finally {
    lock.releaseLock();
  }
}

// ===== メッセージ処理 =====
function processMessages() {
  const props = PropertiesService.getScriptProperties();
  const last = props.getProperty('LAST_MESSAGE_ID') || '0';
  const msgs = api('get', `/channels/${prop('CHANNEL_ID')}/messages?after=${last}&limit=100`) || [];
  // 古い順に並べる
  msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  for (const m of msgs) {
    // 二重処理を防ぐため、先に既読位置を進める
    props.setProperty('LAST_MESSAGE_ID', m.id);
    if (m.author.bot || m.author.id !== prop('CHILD_USER_ID')) continue;
    const cmd = parseCommand(m.content);
    if (!cmd) continue;
    try {
      if (cmd.type === 'start') handleStart(m, cmd.hours);
      else if (cmd.type === 'end') handleEnd(m);
      else if (cmd.type === 'undo') handleUndo(m);
    } catch (e) {
      console.error(`処理エラー (${m.id}): ${e}`);
    }
  }
}

// 書き込みをコマンドに変換（完全一致のみ）
function parseCommand(text) {
  const s = String(text || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/三/g, '3');
  if (s === '開始') return { type: 'start', hours: 2 };
  if (s === '開始3時間' || s === '3時間開始') return { type: 'start', hours: 3 };
  if (s === '終了') return { type: 'end' };
  if (s === '取消' || s === '取り消し' || s === '取消し') return { type: 'undo' };
  return null;
}

// ===== 開始 =====
function handleStart(m, hours) {
  const sh = sheet();
  const t = new Date(m.timestamp);
  const active = findActiveRow();
  let prevRow = null;

  if (active) {
    const start = sh.getRange(active, C.START).getValue();
    const limitH = sh.getRange(active, C.LIMIT).getValue();
    const limitEnd = addMin(start, limitH * 60);
    const forgotAt = addMin(limitEnd, SECOND_NOTICE_MIN);
    if (t < forgotAt) {
      reply(m, `もう開始中やで（${fmtTime(start)}から、${fmtTime(limitEnd)}まで）`);
      return;
    }
    // 前回を「終了忘れ」で閉じる
    sh.getRange(active, C.END).setValue(forgotAt);
    sh.getRange(active, C.MIN).setValue(limitH * 60 + SECOND_NOTICE_MIN);
    sh.getRange(active, C.STATUS).setValue(ST.FORGOT);
    prevRow = active;
  }

  sh.appendRow([t, hours, '', '', ST.ACTIVE, '', '', "'" + m.id, '']);
  const row = sh.getLastRow();
  setLastAction({ type: 'start', row: row, prevRow: prevRow });

  let msg = `開始を受け付けたで（${fmtTime(t)}）。今回は${hours}時間、${fmtTime(addMin(t, hours * 60))}までやで`;
  if (prevRow) msg += '\n前回は終了がなかったから「終了忘れ」で記録したで';
  react(m);
  reply(m, msg);
}

// ===== 終了 =====
function handleEnd(m) {
  const sh = sheet();
  const active = findActiveRow();
  if (!active) {
    reply(m, '開始の記録がないで');
    return;
  }
  const t = new Date(m.timestamp);
  const start = sh.getRange(active, C.START).getValue();
  const min = Math.max(0, Math.round((t - start) / 60000));
  sh.getRange(active, C.END).setValue(t);
  sh.getRange(active, C.MIN).setValue(min);
  sh.getRange(active, C.STATUS).setValue(ST.DONE);
  setLastAction({ type: 'end', row: active });

  const total = weeklyTotal(new Date());
  const rest = WEEKLY_LIMIT_MIN - total;
  const restText = rest >= 0 ? `残り${fmtDur(rest)}` : `${fmtDur(-rest)}オーバー`;
  react(m);
  reply(m, `終了を受け付けたで（${fmtTime(t)}）。今回は${fmtDur(min)}。今週の合計は${fmtDur(total)}（${restText}）`);
}

// ===== 取消 =====
function handleUndo(m) {
  const sh = sheet();
  const la = getLastAction();
  if (!la) {
    reply(m, '取り消せるものがないで');
    return;
  }
  if (la.type === 'start') {
    sh.getRange(la.row, C.STATUS).setValue(ST.CANCEL);
    sh.getRange(la.row, C.NOTE).setValue(`取消 ${fmtTime(new Date(m.timestamp))}`);
    let msg = '開始を取り消したで';
    if (la.prevRow) {
      sh.getRange(la.prevRow, C.END).clearContent();
      sh.getRange(la.prevRow, C.MIN).clearContent();
      sh.getRange(la.prevRow, C.STATUS).setValue(ST.ACTIVE);
      msg += '\n前回の記録を開始中に戻したで';
    }
    react(m);
    reply(m, msg);
  } else if (la.type === 'end') {
    sh.getRange(la.row, C.END).clearContent();
    sh.getRange(la.row, C.MIN).clearContent();
    sh.getRange(la.row, C.STATUS).setValue(ST.ACTIVE);
    const start = sh.getRange(la.row, C.START).getValue();
    const limitH = sh.getRange(la.row, C.LIMIT).getValue();
    react(m);
    reply(m, `終了を取り消したで。開始中に戻したで（${fmtTime(addMin(start, limitH * 60))}まで）`);
  }
  setLastAction(null);
}

// ===== 通知チェック =====
function checkNotices(now) {
  const sh = sheet();
  const active = findActiveRow();
  if (!active) return;
  const start = sh.getRange(active, C.START).getValue();
  const limitH = sh.getRange(active, C.LIMIT).getValue();
  const n1 = sh.getRange(active, C.N1).getValue();
  const n2 = sh.getRange(active, C.N2).getValue();
  const limitEnd = addMin(start, limitH * 60);
  const child = prop('CHILD_USER_ID');

  if (now >= limitEnd && !n1) {
    post(`<@${child}> ${limitH}時間たったで！そろそろ「終了」してな（${fmtTime(start)}開始）`);
    sh.getRange(active, C.N1).setValue(now);
  } else if (n1 && !n2 && now >= addMin(limitEnd, SECOND_NOTICE_MIN)) {
    post(`<@${child}> まだ「終了」の記録がないで！${limitH}時間${SECOND_NOTICE_MIN}分たったで（${fmtTime(start)}開始）`);
    sh.getRange(active, C.N2).setValue(now);
  }
}

// ===== 集計 =====
function weeklyTotal(now) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const rows = sh.getRange(2, 1, last - 1, C.STATUS).getValues();
  return rows
    .filter(r => r[C.START - 1] instanceof Date && r[C.START - 1] >= monday &&
                 (r[C.STATUS - 1] === ST.DONE || r[C.STATUS - 1] === ST.FORGOT))
    .reduce((sum, r) => sum + (Number(r[C.MIN - 1]) || 0), 0);
}

// ===== シート・状態 =====
function sheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

function findActiveRow() {
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const st = sh.getRange(2, C.STATUS, last - 1, 1).getValues();
  for (let i = st.length - 1; i >= 0; i--) {
    if (st[i][0] === ST.ACTIVE) return i + 2;
  }
  return null;
}

function setLastAction(obj) {
  const p = PropertiesService.getScriptProperties();
  if (obj) p.setProperty('LAST_ACTION', JSON.stringify(obj));
  else p.deleteProperty('LAST_ACTION');
}

function getLastAction() {
  const v = PropertiesService.getScriptProperties().getProperty('LAST_ACTION');
  return v ? JSON.parse(v) : null;
}

function prop(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v || v === '未設定') throw new Error(`スクリプトプロパティ ${key} が未設定`);
  return v;
}

// ===== Discord API（Vercel中継経由） =====
function api(method, path, body) {
  const opt = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-relay-secret': prop('RELAY_SECRET') },
    payload: JSON.stringify({ method: method, path: path, body: body === undefined ? null : body }),
    muteHttpExceptions: true,
  };
  for (let i = 0; i < 3; i++) {
    const res = UrlFetchApp.fetch(prop('RELAY_URL'), opt);
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code === 429) {
      let wait = 1;
      try { wait = JSON.parse(text).retry_after || 1; } catch (e) {}
      Utilities.sleep(Math.ceil(wait * 1000) + 100);
      continue;
    }
    if (code === 401) throw new Error('中継の合言葉（RELAY_SECRET）がVercelと一致していないで');
    if (code === 400) throw new Error('中継に拒否されたで（CHANNEL_IDがVercelと同じか確認してな）');
    if (code >= 300) throw new Error(`Discord API ${code}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Discord APIのレート制限が続いています');
}

function post(content) {
  api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    allowed_mentions: { users: [prop('CHILD_USER_ID')] },
  });
}

function reply(m, content) {
  api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    message_reference: { message_id: m.id, fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  });
}

function react(m) {
  try {
    api('put', `/channels/${prop('CHANNEL_ID')}/messages/${m.id}/reactions/${encodeURIComponent('✅')}/@me`);
  } catch (e) {
    console.error('リアクション失敗: ' + e);
  }
}

// ===== 表示用 =====
function addMin(d, min) {
  return new Date(d.getTime() + min * 60000);
}

function fmtTime(d) {
  const now = new Date();
  const sameDay = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd') === Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
  return Utilities.formatDate(d, 'Asia/Tokyo', sameDay ? 'HH:mm' : 'M/d HH:mm');
}

function fmtDur(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}
