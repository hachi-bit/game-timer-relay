/**
 * ゲーム時間記録ボット（Discord × GAS × Vercel中継）
 * 1分ごとのトリガーで main() を実行する
 *
 * 子ども複数人に対応（書き込んだ人のユーザーIDで子どもを見分け、記録・取消・通知・集計を子どもごとに分ける）
 *
 * 初回の手順:
 *   1. setupProperties() を実行（スクリプトプロパティの枠が「未設定」で作られる）
 *   2. プロジェクトの設定 → スクリプト プロパティで値を入力し、checkProperties() で確認
 *   3. testRelay() を実行して、中継経由でDiscordと通信できるか確認
 *   4. setup() を実行（シート作成・トリガー登録）
 *
 * 勉強の確認:
 *   - 子どもが「勉強終了」と書くと、勉強おわりとして記録し、確認の投稿をする
 *   - その日（0時区切り）の「勉強終了」がないまま「ゲーム開始」が来たら、開始は受け付けたうえで親にメンションで知らせる
 *
 * 1人用から移行するとき:
 *   1. setupProperties() を実行（CHILDREN の枠ができ、今の CHILD_USER_ID が自動でコピーされる）
 *   2. スクリプト プロパティで CHILDREN の後ろに「,2人目のID」を書き足す
 *   3. migrateToMultiChild() を1回だけ実行（既存の記録に子どもの列を埋める）
 *
 * CHILDREN の書き方: ユーザーIDをカンマ区切り。固定の呼び名を使うなら「ID:呼び名」
 *   例) 111111111111111111,222222222222222222
 *   例) 111111111111111111:たろう,222222222222222222:じろう
 *   呼び名を書かないときは、Discordの表示名（なければユーザー名）をシートに記録する
 */

// ===== 設定 =====
const SHEET_NAME = '記録';
const STUDY_SHEET_NAME = '勉強';
const SECOND_NOTICE_MIN = 10;       // 1回目の通知から2回目までの分数
// 寝る時間（この時刻までにゲームを終える）。曜日は 1=月 … 7=日
const BEDTIME_DEFAULT = '22:00';                    // 日〜木
const BEDTIME_BY_DAY = { 5: '22:30', 6: '22:30' };  // 金・土
const EARLY_MORNING_HOUR = 5;                       // この時刻より前（深夜0時〜）は、寝る時間を過ぎている扱い

// 列番号
const C = { START: 1, LIMIT: 2, END: 3, MIN: 4, STATUS: 5, N1: 6, N2: 7, MSGID: 8, NOTE: 9, NAME: 10, UID: 11 };
const HEADER = ['開始日時', '制限時間(h)', '終了日時', 'プレイ時間(分)', '状態', '通知1', '通知2', '開始メッセージID', '備考', '子ども', 'ユーザーID'];
const ST = { ACTIVE: '開始中', DONE: '終了', FORGOT: '終了忘れ', CANCEL: '取消' };

// ===== スクリプトプロパティの枠を作る（最初に1回だけ実行） =====
// 値はコードに書かず、実行後に「プロジェクトの設定 → スクリプト プロパティ」で入力する。
// すでに値が入っている項目は上書きしない。
const PROP_DEFAULTS = {
  RELAY_URL: 'https://game-timer-relay.vercel.app/api/discord',
  RELAY_SECRET: '未設定',
  CHANNEL_ID: '未設定',
  CHILDREN: '未設定',
  PARENTS: '未設定',   // 親のユーザーID（カンマ区切り）。勉強おわりなしで開始したときの通知先
};

function setupProperties() {
  const p = PropertiesService.getScriptProperties();
  const created = [];
  for (const [k, v] of Object.entries(PROP_DEFAULTS)) {
    if (!p.getProperty(k)) { p.setProperty(k, v); created.push(k); }
  }
  p.deleteProperty('DISCORD_BOT_TOKEN'); // トークンはVercel側だけに置く
  // 1人用からの移行：CHILD_USER_ID があれば CHILDREN の初期値に使う
  const old = p.getProperty('CHILD_USER_ID');
  if (old && old !== '未設定' && p.getProperty('CHILDREN') === '未設定') p.setProperty('CHILDREN', old);
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
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
    sh.getRange(2, C.UID, sh.getMaxRows() - 1, 1).setNumberFormat('@');
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

// ===== 1人用から複数人への移行（1回だけ実行） =====
// 子どもの列がない記録を、CHILDREN の1人目の分として埋める。取消用の控えも1人目の分に移す。
function migrateToMultiChild() {
  const kids = children();
  const first = Object.keys(kids)[0];
  const sh = sheet();
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sh.getRange(2, C.UID, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  const last = sh.getLastRow();
  let n = 0;
  if (last >= 2) {
    const rng = sh.getRange(2, C.NAME, last - 1, 2);
    const vals = rng.getValues();
    vals.forEach(r => {
      if (!r[1]) { r[0] = kids[first] || ''; r[1] = first; n++; }
    });
    rng.setValues(vals);
  }
  const p = PropertiesService.getScriptProperties();
  ['LAST_ACTION', 'LAST_UNDO'].forEach(k => {
    const v = p.getProperty(k);
    if (v) { p.setProperty(`${k}_${first}`, v); p.deleteProperty(k); }
  });
  Logger.log(`移行完了：${n}行を ${kids[first] || first} の記録にしたで`);
}

// ===== メイン処理 =====
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
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
  const kids = children();
  // 古い順に並べる
  msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  for (const m of msgs) {
    // 二重処理を防ぐため、先に既読位置を進める
    props.setProperty('LAST_MESSAGE_ID', m.id);
    if (m.author.bot || !(m.author.id in kids)) continue;
    const cmd = parseCommand(m.content);
    if (!cmd) continue;
    try {
      if (cmd.type === 'study') handleStudy(m);
      else if (cmd.type === 'start') handleStart(m, cmd.hours);
      else if (cmd.type === 'end') handleEnd(m);
      else if (cmd.type === 'ask') handleAsk(m, cmd.word);
      else if (cmd.type === 'undo') handleUndo(m);
      else if (cmd.type === 'redo') handleRedo(m);
    } catch (e) {
      console.error(`処理エラー (${m.id}): ${e}`);
    }
  }
}

// 書き込みをコマンドに変換（完全一致のみ）
function parseCommand(text) {
  // 書き方のルール：開始と終了があるもの（ゲーム・勉強）は、最後が「開始」か「終了」で終わる。
  // 受け付けるのはルール通りの形だけ（ひらがな・全角数字・空白の違いは吸収する）。
  // 「開始」「終了」だけのときは、何のことか聞き返す。それ以外の書き方には反応しない
  const s = String(text || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/三/g, '3')
    .replace(/げーむ/g, 'ゲーム').replace(/べんきょう/g, '勉強')
    .replace(/かいし/g, '開始').replace(/しゅうりょう/g, '終了').replace(/じかん/g, '時間');

  if (s === 'ゲーム開始') return { type: 'start', hours: 2 };
  if (s === 'ゲーム3時間開始') return { type: 'start', hours: 3 };
  if (s === 'ゲーム終了') return { type: 'end' };
  if (s === '勉強終了') return { type: 'study' };
  if (s === '開始' || s === '3時間開始') return { type: 'ask', word: '開始' };
  if (s === '終了') return { type: 'ask', word: '終了' };
  if (s === '取消' || s === '取り消し' || s === '取消し') return { type: 'undo' };
  if (s === '取消の取消' || s === '取り消しの取り消し' || s === '取消しの取消し') return { type: 'redo' };
  return null;
}

// ===== 勉強おわり =====
function handleStudy(m) {
  const uid = m.author.id;
  const t = new Date(m.timestamp);
  studySheet().appendRow([t, childName(m.author), "'" + uid, "'" + m.id]);
  react(m);
  reply(m, `<@${uid}>の勉強おわりを受け付けたで（${fmtTime(t)}）\n・やるべき勉強は全部解いた？\n・答え合わせも全部おわった？`);
}

// その子どもの、その日（0時区切り）の「勉強終了」があるか
function hasStudyOn(uid, t) {
  const sh = studySheet();
  const last = sh.getLastRow();
  if (last < 2) return false;
  const day = dayKey(t);
  return sh.getRange(2, 1, last - 1, 3).getValues()
    .some(r => String(r[2]) === uid && r[0] instanceof Date && dayKey(r[0]) === day);
}

// ===== 開始 =====
function handleStart(m, hours) {
  const sh = sheet();
  const t = new Date(m.timestamp);
  const uid = m.author.id;
  const active = findActiveRow(uid);
  let prevRow = null;

  if (active) {
    const start = sh.getRange(active, C.START).getValue();
    const limitH = sh.getRange(active, C.LIMIT).getValue();
    const limitEnd = addMin(start, limitH * 60);
    const forgotAt = addMin(limitEnd, SECOND_NOTICE_MIN);
    if (t < forgotAt) {
      reply(m, `もうゲーム開始中やで（${fmtTime(start)}から、${fmtTime(limitEnd)}まで）`);
      return;
    }
    // 前回を「終了忘れ」で閉じる
    sh.getRange(active, C.END).setValue(forgotAt);
    sh.getRange(active, C.MIN).setValue(limitH * 60 + SECOND_NOTICE_MIN);
    sh.getRange(active, C.STATUS).setValue(ST.FORGOT);
    prevRow = active;
  }

  // 今日の「勉強終了」がなければ、開始は受け付けたうえで親に知らせる
  const studied = hasStudyOn(uid, t);
  if (!studied) {
    const parents = parentIds();
    const mention = parents.map(id => `<@${id}>`).join(' ');
    replyPing(m, parents, `${mention ? mention + ' ' : ''}<@${uid}>は今日まだ「勉強終了」が出てないで。ちゃんと勉強した？`);
  }

  sh.appendRow([t, hours, '', '', ST.ACTIVE, '', '', "'" + m.id, studied ? '' : '勉強おわりなし', childName(m.author), "'" + uid]);
  const row = sh.getLastRow();
  setLastAction(uid, { type: 'start', row: row, prevRow: prevRow });
  setLastUndo(uid, null);

  let msg = `<@${uid}>のゲーム開始を受け付けたで（${fmtTime(t)}）。今回は${hours}時間、${fmtTime(addMin(t, hours * 60))}までやで`;
  msg += bedtimeNote(t, addMin(t, hours * 60));
  if (prevRow) msg += '\n前回は終了がなかったから「終了忘れ」で記録したで';
  react(m);
  reply(m, msg);
}

// ===== 「開始」「終了」だけのとき：何のことか聞き返す（記録はしない） =====
function handleAsk(m, word) {
  const uid = m.author.id;
  if (word === '開始') reply(m, `<@${uid}> なんの開始？ ゲームなら「ゲーム開始」と書いてな`);
  else reply(m, `<@${uid}> なんの終了？ 「ゲーム終了」か「勉強終了」と書いてな`);
}

// 終了の目安が寝る時間を過ぎるときに、開始の返信の最後に付ける一言（過ぎないときは空文字）
function bedtimeNote(start, limitEnd) {
  const dow = Number(Utilities.formatDate(start, 'Asia/Tokyo', 'u'));
  const hm = BEDTIME_BY_DAY[dow] || BEDTIME_DEFAULT;
  const label = hm.replace(/^(\d+):00$/, '$1時').replace(/^(\d+):(\d+)$/, '$1時$2分');
  const bed = new Date(`${Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy-MM-dd')}T${hm}:00+09:00`);
  const hour = Number(Utilities.formatDate(start, 'Asia/Tokyo', 'H'));
  if (start >= bed || hour < EARLY_MORNING_HOUR) return `。ただ、もう寝る時間を過ぎてるで`;
  if (limitEnd > bed) return `。ただ、寝る時間やから${label}までやで`;
  return '';
}

// ===== 終了 =====
function handleEnd(m) {
  const sh = sheet();
  const uid = m.author.id;
  const active = findActiveRow(uid);
  if (!active) {
    reply(m, `<@${uid}>のゲーム開始の記録がないで`);
    return;
  }
  const t = new Date(m.timestamp);
  const start = sh.getRange(active, C.START).getValue();
  const min = Math.max(0, Math.round((t - start) / 60000));
  sh.getRange(active, C.END).setValue(t);
  sh.getRange(active, C.MIN).setValue(min);
  sh.getRange(active, C.STATUS).setValue(ST.DONE);
  setLastAction(uid, { type: 'end', row: active });
  setLastUndo(uid, null);

  const total = weeklyTotal(new Date(), uid);
  react(m);
  reply(m, `<@${uid}>のゲーム終了を受け付けたで（${fmtTime(t)}）。今回は${fmtDur(min)}。今週の合計は${fmtDur(total)}`);
}

// ===== 取消 =====
function handleUndo(m) {
  const sh = sheet();
  const uid = m.author.id;
  const la = getLastAction(uid);
  if (!la) {
    reply(m, '取り消せるものがないで');
    return;
  }
  // 取消の取消で元に戻せるよう、書き換える前の値を控えておく
  const undo = { action: la };
  if (la.type === 'start') {
    if (la.prevRow) {
      undo.prevEnd = sh.getRange(la.prevRow, C.END).getValue().getTime();
      undo.prevMin = sh.getRange(la.prevRow, C.MIN).getValue();
    }
    sh.getRange(la.row, C.STATUS).setValue(ST.CANCEL);
    // 備考（「勉強おわりなし」など）は残して、取消の印を足す
    const note = String(sh.getRange(la.row, C.NOTE).getValue() || '');
    sh.getRange(la.row, C.NOTE).setValue((note ? note + ' / ' : '') + `取消 ${fmtTime(new Date(m.timestamp))}`);
    let msg = `<@${uid}>のゲーム開始を取り消したで`;
    if (la.prevRow) {
      sh.getRange(la.prevRow, C.END).clearContent();
      sh.getRange(la.prevRow, C.MIN).clearContent();
      sh.getRange(la.prevRow, C.STATUS).setValue(ST.ACTIVE);
      msg += '\n前回の記録を開始中に戻したで';
    }
    react(m);
    reply(m, msg);
  } else if (la.type === 'end') {
    undo.end = sh.getRange(la.row, C.END).getValue().getTime();
    undo.min = sh.getRange(la.row, C.MIN).getValue();
    sh.getRange(la.row, C.END).clearContent();
    sh.getRange(la.row, C.MIN).clearContent();
    sh.getRange(la.row, C.STATUS).setValue(ST.ACTIVE);
    const start = sh.getRange(la.row, C.START).getValue();
    const limitH = sh.getRange(la.row, C.LIMIT).getValue();
    react(m);
    reply(m, `<@${uid}>のゲーム終了を取り消したで。開始中に戻したで（${fmtTime(addMin(start, limitH * 60))}まで）`);
  }
  setLastAction(uid, null);
  setLastUndo(uid, undo);
}

// ===== 取消の取消 =====
function handleRedo(m) {
  const sh = sheet();
  const uid = m.author.id;
  const undo = getLastUndo(uid);
  if (!undo) {
    reply(m, '取り消せるものがないで');
    return;
  }
  const la = undo.action;
  if (la.type === 'start') {
    if (la.prevRow) {
      sh.getRange(la.prevRow, C.END).setValue(new Date(undo.prevEnd));
      sh.getRange(la.prevRow, C.MIN).setValue(undo.prevMin);
      sh.getRange(la.prevRow, C.STATUS).setValue(ST.FORGOT);
    }
    sh.getRange(la.row, C.STATUS).setValue(ST.ACTIVE);
    // 取消の印だけ消す
    const note = String(sh.getRange(la.row, C.NOTE).getValue() || '').replace(/( \/ )?取消 [^/]*$/, '');
    sh.getRange(la.row, C.NOTE).setValue(note);
    const start = sh.getRange(la.row, C.START).getValue();
    const limitH = sh.getRange(la.row, C.LIMIT).getValue();
    react(m);
    reply(m, `<@${uid}>の取消を取り消したで。${fmtTime(start)}からの開始中に戻したで（${fmtTime(addMin(start, limitH * 60))}まで）`);
  } else if (la.type === 'end') {
    sh.getRange(la.row, C.END).setValue(new Date(undo.end));
    sh.getRange(la.row, C.MIN).setValue(undo.min);
    sh.getRange(la.row, C.STATUS).setValue(ST.DONE);
    const total = weeklyTotal(new Date(), uid);
    react(m);
    reply(m, `<@${uid}>の取消を取り消したで。${fmtTime(new Date(undo.end))}に終了した記録に戻したで（今回は${fmtDur(undo.min)}、今週の合計は${fmtDur(total)}）`);
  }
  setLastAction(uid, la);
  setLastUndo(uid, null);
}

// ===== 通知チェック =====
function checkNotices(now) {
  activeRows().forEach(r => checkNotice(now, r));
}

function checkNotice(now, active) {
  const sh = sheet();
  const start = sh.getRange(active, C.START).getValue();
  const limitH = sh.getRange(active, C.LIMIT).getValue();
  const n1 = sh.getRange(active, C.N1).getValue();
  const n2 = sh.getRange(active, C.N2).getValue();
  const limitEnd = addMin(start, limitH * 60);
  const child = String(sh.getRange(active, C.UID).getValue());

  if (now >= limitEnd && !n1) {
    post(child, `<@${child}> ${limitH}時間たったで！そろそろ「ゲーム終了」してな（${fmtTime(start)}開始）`);
    sh.getRange(active, C.N1).setValue(now);
  } else if (n1 && !n2 && now >= addMin(limitEnd, SECOND_NOTICE_MIN)) {
    post(child, `<@${child}> まだ「ゲーム終了」の記録がないで！${limitH}時間${SECOND_NOTICE_MIN}分たったで（${fmtTime(start)}開始）`);
    sh.getRange(active, C.N2).setValue(now);
  }
}

// ===== 集計 =====
function weeklyTotal(now, uid) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const rows = sh.getRange(2, 1, last - 1, C.UID).getValues();
  return rows
    .filter(r => String(r[C.UID - 1]) === uid &&
                 r[C.START - 1] instanceof Date && r[C.START - 1] >= monday &&
                 (r[C.STATUS - 1] === ST.DONE || r[C.STATUS - 1] === ST.FORGOT))
    .reduce((sum, r) => sum + (Number(r[C.MIN - 1]) || 0), 0);
}

// ===== シート・状態 =====
function sheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

// 勉強おわりの記録シート（なければ作る）
function studySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(STUDY_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(STUDY_SHEET_NAME);
    sh.appendRow(['日時', '子ども', 'ユーザーID', 'メッセージID']);
    sh.setFrozenRows(1);
    sh.getRange(2, 3, sh.getMaxRows() - 1, 2).setNumberFormat('@');
  }
  return sh;
}

// 開始中の行（全員分）を返す
function activeRows() {
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const st = sh.getRange(2, C.STATUS, last - 1, 1).getValues();
  const rows = [];
  st.forEach((r, i) => { if (r[0] === ST.ACTIVE) rows.push(i + 2); });
  return rows;
}

// その子どもの開始中の行を返す（なければ null）
function findActiveRow(uid) {
  const sh = sheet();
  const rows = activeRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(sh.getRange(rows[i], C.UID).getValue()) === uid) return rows[i];
  }
  return null;
}

// 取消・取消の取消の控えは子どもごとに持つ
function setLastAction(uid, obj) { setJsonProp(`LAST_ACTION_${uid}`, obj); }
function setLastUndo(uid, obj) { setJsonProp(`LAST_UNDO_${uid}`, obj); }
function getLastAction(uid) { return getJsonProp(`LAST_ACTION_${uid}`); }
function getLastUndo(uid) { return getJsonProp(`LAST_UNDO_${uid}`); }

function setJsonProp(key, obj) {
  const p = PropertiesService.getScriptProperties();
  if (obj) p.setProperty(key, JSON.stringify(obj));
  else p.deleteProperty(key);
}

function getJsonProp(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? JSON.parse(v) : null;
}

// CHILDREN を { ユーザーID: 固定の呼び名（なければ空文字） } に変換
function children() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('CHILDREN');
  if (!v || v === '未設定') v = p.getProperty('CHILD_USER_ID'); // 1人用の設定がまだ残っている場合
  if (!v || v === '未設定') throw new Error('スクリプトプロパティ CHILDREN が未設定');
  const map = {};
  v.split(/[,、，]/).map(x => x.trim()).filter(x => x).forEach(x => {
    const i = x.search(/[:：]/);
    const id = (i < 0 ? x : x.slice(0, i)).trim();
    const name = i < 0 ? '' : x.slice(i + 1).trim();
    if (/^\d+$/.test(id)) map[id] = name;
  });
  if (!Object.keys(map).length) throw new Error('CHILDREN にユーザーIDが入っていないで');
  return map;
}

// 親のユーザーID（PARENTS が未設定なら空。その場合はメンションなしで知らせる）
function parentIds() {
  const v = PropertiesService.getScriptProperties().getProperty('PARENTS');
  if (!v || v === '未設定') return [];
  return v.split(/[,、，]/).map(x => x.trim()).filter(x => /^\d+$/.test(x));
}

// シートに記録する名前：固定の呼び名 → Discordの表示名 → ユーザー名
function childName(author) {
  return children()[author.id] || author.global_name || author.username || author.id;
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
    if (code === 400) throw new Error('中継に拒否されたで（許可されていない操作か、中継が古いかもしれへん）');
    if (code >= 300) throw new Error(`Discord API ${code}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Discord APIのレート制限が続いています');
}

// 通知用：指定した子どもにだけメンションの通知を飛ばす
function post(uid, content) {
  api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    allowed_mentions: { users: [uid] },
  });
}

function reply(m, content) {
  api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    message_reference: { message_id: m.id, fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  });
}

// 返信しつつ、指定したユーザーにだけメンション通知を飛ばす
function replyPing(m, pingIds, content) {
  api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    message_reference: { message_id: m.id, fail_if_not_exists: false },
    allowed_mentions: { users: pingIds, replied_user: false },
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
function dayKey(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd');
}

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
