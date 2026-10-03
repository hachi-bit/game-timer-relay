/**
 * お手伝いおこづかいボット（Discord × GAS × Vercel中継）
 * 1分ごとのトリガーで main() を、毎月1日の朝に monthlyReport() を実行する
 *
 * しくみ:
 *   1. 子どもがチャンネルに「ゴミ捨て2完了」「水やり完了」などと書く
 *   2. ボットが「受け付けたで」と返信し、その返信に自分で✅と❌を付ける
 *   3. 親が✅を押したら承認（金額が確定）、❌なら却下
 *   4. 毎朝8時30分に、前日までの未承認・保留（✅❌両方）の報告をリストにして親に知らせる
 *   5. 毎月1日の朝に、前月の承認済み合計を子どもごとに通知する
 *
 * 初回の手順:
 *   1. setupProperties() を実行（スクリプトプロパティの枠が「未設定」で作られる）
 *   2. プロジェクトの設定 → スクリプト プロパティで値を入力し、checkProperties() で確認
 *   3. testRelay() を実行して、中継経由でDiscordと通信できるか確認
 *   4. setup() を実行（シート作成・トリガー登録）
 *
 * CHILDREN / PARENTS の書き方: ユーザーIDをカンマ区切り
 *   CHILDREN は固定の呼び名も書ける（例: 111111111111111111:たろう,222222222222222222:じろう）
 */

// ===== 設定 =====
const SHEET_NAME = '記録';
const MAX_COUNT = 10;               // 1回の報告で受け付ける最大の個数
const REPORT_HOUR = 8;              // 月まとめを通知する時（毎月1日）
const DIGEST_TIME = '08:30';        // 未承認・保留のまとめを知らせる時刻（毎日）
const DIGEST_PER_POST = 12;         // まとめ1投稿あたりの件数（Discordの文字数上限対策）
const OK = '✅';
const NG = '❌';

// お手伝いの種類と金額
//   first: その日（0時区切り）の1個目の金額、next: 2個目以降の1個あたりの金額
//   words: 報告で受け付ける書き方（ひらがな・カタカナ・漢字の違いは自動で吸収する）
const CHORES = [
  { name: 'ゴミ捨て',   first: 15, next: 10, words: ['ごみすて'] },
  { name: '布団しき',   first: 10, next: 10, words: ['ふとんしき', 'ふとんし'] },
  { name: '布団たたみ', first: 10, next: 10, words: ['ふとんたたみ', 'ふとんたた'] },
  { name: '水やり',     first: 15, next: 15, words: ['みずやり'] },
];

// 列番号
const C = { AT: 1, NAME: 2, UID: 3, CHORE: 4, COUNT: 5, YEN: 6, STATUS: 7, MSGID: 8, BOTID: 9, DONEAT: 10, BY: 11, NOTE: 12 };
const HEADER = ['報告日時', '子ども', 'ユーザーID', 'お手伝い', '個数', '金額', '状態', '報告メッセージID', 'ボット返信ID', '確定日時', '確定した人', '備考'];
const ST = { WAIT: '未承認', OK: '承認', NG: '却下' };

// ===== スクリプトプロパティの枠を作る（最初に1回だけ実行） =====
const PROP_DEFAULTS = {
  RELAY_URL: 'https://game-timer-relay.vercel.app/api/discord',
  RELAY_SECRET: '未設定',
  CHANNEL_ID: '未設定',
  CHILDREN: '未設定',
  PARENTS: '未設定',
  GUILD_ID: '未設定',
};

function setupProperties() {
  const p = PropertiesService.getScriptProperties();
  const created = [];
  for (const [k, v] of Object.entries(PROP_DEFAULTS)) {
    if (!p.getProperty(k)) { p.setProperty(k, v); created.push(k); }
  }
  Logger.log(created.length ? '作成したで：' + created.join(', ') : '全部そろってたで');
  checkProperties();
}

function checkProperties() {
  const p = PropertiesService.getScriptProperties();
  const missing = Object.keys(PROP_DEFAULTS).filter(k => !p.getProperty(k) || p.getProperty(k) === '未設定');
  if (missing.length) {
    Logger.log('「未設定」のままの項目：' + missing.join(', ') + '\nプロジェクトの設定 → スクリプト プロパティで値を入れてな');
  } else {
    Logger.log('プロパティは全部入ってるで');
  }
}

// 中継経由でDiscordと通信できるか確認
function testRelay() {
  const ch = prop('CHANNEL_ID');
  const msgs = api('get', `/channels/${ch}/messages?limit=1`);
  Logger.log('取得OK：' + msgs.length + '件');
  api('post', `/channels/${ch}/messages`, { content: 'おこづかいボットの中継テストやで' });
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
  }
  // ID列は文字列で持つ（数値にすると桁が丸められるため）
  [C.UID, C.MSGID, C.BOTID].forEach(c => sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@'));
  // 既存メッセージは処理しない
  const msgs = api('get', `/channels/${prop('CHANNEL_ID')}/messages?limit=1`);
  PropertiesService.getScriptProperties().setProperty('LAST_MESSAGE_ID', msgs.length ? msgs[0].id : '0');
  // トリガーを登録し直す
  ScriptApp.getProjectTriggers()
    .filter(t => ['main', 'monthlyReport'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('monthlyReport').timeBased().onMonthDay(1).atHour(REPORT_HOUR).inTimezone('Asia/Tokyo').create();
  Logger.log('セットアップ完了');
}

// ===== メイン処理 =====
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    processMessages();
    checkReactions();
    maybeDailyDigest(new Date());
  } finally {
    lock.releaseLock();
  }
}

// ===== 報告の受付 =====
function processMessages() {
  const props = PropertiesService.getScriptProperties();
  const last = props.getProperty('LAST_MESSAGE_ID') || '0';
  const msgs = api('get', `/channels/${prop('CHANNEL_ID')}/messages?after=${last}&limit=100`) || [];
  msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const kids = children();

  for (const m of msgs) {
    props.setProperty('LAST_MESSAGE_ID', m.id);
    if (m.author.bot || !(m.author.id in kids)) continue;
    const cmd = parseReport(m.content);
    if (!cmd) continue; // 書き方が違うときは無反応
    try {
      if (cmd.ask) reply(m, `<@${m.author.id}> なにが完了？ 「ゴミ捨て完了」みたいに書いてな`);
      else handleReport(m, cmd);
    } catch (e) {
      console.error(`処理エラー (${m.id}): ${e}`);
    }
  }
}

// 書き込みを報告に変換。書き方のルール：お手伝いは最後が「完了」で終わる
//   例：ゴミ捨て完了 / ゴミ捨て2完了 / 布団しき完了 / 水やり完了
// 受け付けるのはルール通りの形だけ（ひらがな・カタカナ・漢字、全角数字、空白の違いは吸収する）。
// 「完了」だけのときは、何のことか聞き返す。それ以外の書き方には反応しない
function parseReport(text) {
  let s = String(text || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)); // カタカナ → ひらがな
  // 漢字の書き方をひらがなにそろえる
  [['捨', 'す'], ['布団', 'ふとん'], ['敷', 'し'], ['畳', 'たた'], ['水', 'みず'], ['遣', 'や']]
    .forEach(([a, b]) => { s = s.split(a).join(b); });
  // 漢数字
  const kan = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  s = s.replace(/[一二三四五六七八九十]/g, c => String(kan[c]));
  s = s.replace(/かんりょう/g, '完了');

  if (s === '完了') return { ask: true };
  // 形：お手伝い ＋ 個数（省略可）＋「完了」
  const m = s.match(/^(.+?)(\d+)?完了$/);
  if (!m) return null;
  const chore = CHORES.find(c => c.words.includes(m[1]));
  if (!chore) return null;
  const count = m[2] ? Number(m[2]) : 1;
  if (count < 1 || count > MAX_COUNT) return null;
  return { chore: chore, count: count };
}

function handleReport(m, cmd) {
  const sh = sheet();
  const uid = m.author.id;
  const at = new Date(m.timestamp);
  // 表示用の予定金額（その日の承認済み＋未承認を先に数えたとき）
  const before = countOfDay(uid, cmd.chore.name, at, [ST.OK, ST.WAIT]);
  const yen = amount(cmd.chore, before + cmd.count) - amount(cmd.chore, before);
  const label = cmd.count > 1 ? `${cmd.chore.name}×${cmd.count}` : cmd.chore.name;

  const bot = reply(m, `<@${uid}>の${label}を受け付けたで（${yen}円の予定）\n親が${OK}で承認、${NG}で却下やで`);
  sh.appendRow([at, childName(m.author), "'" + uid, cmd.chore.name, cmd.count, '', ST.WAIT, "'" + m.id, "'" + bot.id, '', '', '']);
  react(bot.id, OK);
  react(bot.id, NG);
}

// ===== 承認・却下の確認 =====
function checkReactions() {
  const sh = sheet();
  const parents = parentIds();
  for (const row of waitingRows()) {
    const botId = String(sh.getRange(row, C.BOTID).getValue());
    try {
      const st = reactionState(botId, parents);
      if (!st) continue;
      if (st.okBy && st.ngBy) continue;     // 両方押されているときは保留（朝のまとめで知らせる）
      if (st.okBy) approve(row, st.okBy);
      else if (st.ngBy) reject(row, st.ngBy);
    } catch (e) {
      console.error(`リアクション確認エラー (行${row}): ${e}`);
    }
  }
}

// ボットの返信に付いた親の✅❌を調べる。{ okBy, ngBy }（押した親のID、いなければ null）
// まず返信を取得してリアクションの数を見て、ボット自身の1つより増えていたら押した人の一覧を調べる
function reactionState(botId, parents) {
  const msgs = api('get', `/channels/${prop('CHANNEL_ID')}/messages?around=${botId}&limit=1`) || [];
  const msg = msgs.find(x => x.id === botId);
  if (!msg) return null;
  return { okBy: reactedParent(msg, botId, OK, parents), ngBy: reactedParent(msg, botId, NG, parents) };
}

// その絵文字を押した親のIDを返す（いなければ null）
function reactedParent(msg, botId, emoji, parents) {
  const r = (msg.reactions || []).find(x => x.emoji && x.emoji.name === emoji);
  if (!r || r.count <= (r.me ? 1 : 0)) return null; // ボット以外が押していない
  const users = api('get', `/channels/${prop('CHANNEL_ID')}/messages/${botId}/reactions/${encodeURIComponent(emoji)}?limit=100`) || [];
  const u = users.find(x => parents.includes(x.id));
  return u ? u.id : null;
}

function approve(row, parentId) {
  const sh = sheet();
  const v = sh.getRange(row, 1, 1, HEADER.length).getValues()[0];
  const uid = String(v[C.UID - 1]);
  const at = v[C.AT - 1];
  const chore = CHORES.find(c => c.name === v[C.CHORE - 1]);
  const count = Number(v[C.COUNT - 1]);
  // 金額はその日に承認済みの個数のあとに数える（却下された分は数えない）
  const before = countOfDay(uid, chore.name, at, [ST.OK]);
  const yen = amount(chore, before + count) - amount(chore, before);
  const now = new Date();
  sh.getRange(row, C.YEN).setValue(yen);
  sh.getRange(row, C.STATUS).setValue(ST.OK);
  sh.getRange(row, C.DONEAT).setValue(now);
  sh.getRange(row, C.BY).setValue("'" + parentId);

  const label = count > 1 ? `${chore.name}×${count}` : chore.name;
  const ym = ymKey(at);
  const total = monthTotal(uid, ym);
  const late = ym !== ymKey(now);
  const head = late ? `前月分の追加承認やで：` : '';
  replyTo(String(v[C.BOTID - 1]), `${head}<@${uid}>の${label}を承認したで +${yen}円（${monthLabel(ym)}の合計 ${fmtYen(total)}円）`);
}

function reject(row, parentId) {
  const sh = sheet();
  const v = sh.getRange(row, 1, 1, HEADER.length).getValues()[0];
  sh.getRange(row, C.YEN).setValue(0);
  sh.getRange(row, C.STATUS).setValue(ST.NG);
  sh.getRange(row, C.DONEAT).setValue(new Date());
  sh.getRange(row, C.BY).setValue("'" + parentId);
  const count = Number(v[C.COUNT - 1]);
  const label = count > 1 ? `${v[C.CHORE - 1]}×${count}` : v[C.CHORE - 1];
  replyTo(String(v[C.BOTID - 1]), `<@${String(v[C.UID - 1])}>の${label}は却下されたで`);
}

// ===== 毎朝のまとめ（未承認・保留） =====
// 毎分の確認の中で、その日の DIGEST_TIME を過ぎていてまだ出していなければ出す
function maybeDailyDigest(now) {
  const today = dayKey(now);
  if (Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm') < DIGEST_TIME) return;
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('DIGEST_DATE') === today) return;
  p.setProperty('DIGEST_DATE', today); // 失敗しても同じ日に何度も出さない
  dailyDigest(now);
}

// 前日までに報告されて、まだ確定していないものをリストにして親に知らせる
function dailyDigest(now) {
  const today = dayKey(now || new Date());
  const sh = sheet();
  const parents = parentIds();
  const held = [];
  const waiting = [];
  for (const row of waitingRows()) {
    const v = sh.getRange(row, 1, 1, HEADER.length).getValues()[0];
    if (!(v[C.AT - 1] instanceof Date) || dayKey(v[C.AT - 1]) >= today) continue; // 今日の報告はまだ出さない
    const botId = String(v[C.BOTID - 1]);
    let st = null;
    try { st = reactionState(botId, parents); } catch (e) { console.error(`まとめの確認エラー (行${row}): ${e}`); }
    const count = Number(v[C.COUNT - 1]);
    const label = count > 1 ? `${v[C.CHORE - 1]}×${count}` : v[C.CHORE - 1];
    const link = msgLink(botId);
    const line = `・${Utilities.formatDate(v[C.AT - 1], 'Asia/Tokyo', 'M/d HH:mm')} <@${String(v[C.UID - 1])}> ${label}` + (link ? `　[→投稿へ](${link})` : '');
    (st && st.okBy && st.ngBy ? held : waiting).push(line);
  }
  if (!held.length && !waiting.length) return;

  const mention = parents.map(id => `<@${id}>`).join(' ');
  const sections = [];
  if (held.length) sections.push({ title: `保留になってる報告が${held.length}件あるで（${OK}と${NG}の両方が押されてる。どっちか外してな）`, lines: held });
  if (waiting.length) sections.push({ title: `まだ承認されてない報告が${waiting.length}件あるで`, lines: waiting });
  // 1投稿に収まるよう分けて投稿する。メンション通知は最初の投稿だけ
  let first = true;
  for (const sec of sections) {
    for (let i = 0; i < sec.lines.length; i += DIGEST_PER_POST) {
      const head = (first ? mention + '\n' : '') + (i === 0 ? sec.title : `${sec.title}（つづき）`);
      postTo(first ? parents : [], [head].concat(sec.lines.slice(i, i + DIGEST_PER_POST)).join('\n'));
      first = false;
    }
  }
}

// メッセージへのリンク（GUILD_ID が未設定なら null）
function msgLink(messageId) {
  const g = PropertiesService.getScriptProperties().getProperty('GUILD_ID');
  if (!g || g === '未設定') return null;
  return `https://discord.com/channels/${g}/${prop('CHANNEL_ID')}/${messageId}`;
}

// ===== 月まとめ（毎月1日の朝） =====
function monthlyReport() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym = ymKey(prev);
  const lines = [`${monthLabel(ym)}のおこづかいやで`];
  for (const uid of Object.keys(children())) {
    const total = monthTotal(uid, ym);
    const wait = rowsOf(uid, ym).filter(r => r[C.STATUS - 1] === ST.WAIT).length;
    lines.push(`<@${uid}>：${fmtYen(total)}円` + (wait ? `（未承認 ${wait}件）` : ''));
  }
  lines.push('未承認の分は、あとで承認されたら追加で知らせるで');
  post(lines.join('\n'));
}

// ===== 金額・集計 =====
// その日の n 個目までの合計金額
function amount(chore, n) {
  return n <= 0 ? 0 : chore.first + chore.next * (n - 1);
}

// その子どもの、その日（0時区切り）の指定状態の個数
function countOfDay(uid, choreName, at, statuses) {
  const day = dayKey(at);
  return allRows()
    .filter(r => String(r[C.UID - 1]) === uid && r[C.CHORE - 1] === choreName &&
                 r[C.AT - 1] instanceof Date && dayKey(r[C.AT - 1]) === day &&
                 statuses.includes(r[C.STATUS - 1]))
    .reduce((s, r) => s + Number(r[C.COUNT - 1] || 0), 0);
}

// その子どもの、報告した月の承認済み合計
function monthTotal(uid, ym) {
  return rowsOf(uid, ym)
    .filter(r => r[C.STATUS - 1] === ST.OK)
    .reduce((s, r) => s + Number(r[C.YEN - 1] || 0), 0);
}

function rowsOf(uid, ym) {
  return allRows().filter(r => String(r[C.UID - 1]) === uid && r[C.AT - 1] instanceof Date && ymKey(r[C.AT - 1]) === ym);
}

// ===== シート =====
function sheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

function allRows() {
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADER.length).getValues();
}

// 未承認の行番号
function waitingRows() {
  const rows = [];
  allRows().forEach((r, i) => { if (r[C.STATUS - 1] === ST.WAIT) rows.push(i + 2); });
  return rows;
}

// ===== 設定の読み込み =====
function prop(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v || v === '未設定') throw new Error(`スクリプトプロパティ ${key} が未設定`);
  return v;
}

function idList(v) {
  return String(v).split(/[,、，]/).map(x => x.trim()).filter(x => x);
}

// CHILDREN を { ユーザーID: 固定の呼び名（なければ空文字） } に変換
function children() {
  const map = {};
  idList(prop('CHILDREN')).forEach(x => {
    const i = x.search(/[:：]/);
    const id = (i < 0 ? x : x.slice(0, i)).trim();
    if (/^\d+$/.test(id)) map[id] = i < 0 ? '' : x.slice(i + 1).trim();
  });
  if (!Object.keys(map).length) throw new Error('CHILDREN にユーザーIDが入っていないで');
  return map;
}

function parentIds() {
  const ids = idList(prop('PARENTS')).filter(x => /^\d+$/.test(x));
  if (!ids.length) throw new Error('PARENTS にユーザーIDが入っていないで');
  return ids;
}

function childName(author) {
  return children()[author.id] || author.global_name || author.username || author.id;
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

// 名前はメンション形式で出すが、通知は飛ばさない
function post(content) {
  return postTo([], content);
}

// 指定したユーザーにだけメンション通知を飛ばす投稿（リンクのプレビューは出さない）
function postTo(pingIds, content) {
  return api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    allowed_mentions: { users: pingIds },
    flags: 4, // SUPPRESS_EMBEDS
  });
}

function reply(m, content) {
  return replyTo(m.id, content);
}

function replyTo(messageId, content) {
  return api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    message_reference: { message_id: messageId, fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  });
}

function react(messageId, emoji) {
  try {
    api('put', `/channels/${prop('CHANNEL_ID')}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  } catch (e) {
    console.error('リアクション失敗: ' + e);
  }
}

// ===== 表示用 =====
function dayKey(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd'); }
function ymKey(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMM'); }
function monthLabel(ym) { return `${Number(ym.slice(4))}月`; }
function fmtYen(n) { return Number(n).toLocaleString('ja-JP'); }
