# お手伝いおこづかいボット（Discord × GAS × Vercel中継）ナレッジ

> 作成日：2026年10月1日
> 目的：子どものお手伝いをDiscordで報告→親の✅で承認→月ごとにおこづかいを集計する。

---

## 1. 方針

- ゲーム時間ボット（`game_timer_bot.md`）と**同じボット・同じ中継（Vercel）・同じチャンネル（一般）**を使い、**GASとスプレッドシートは別**にする
- 2つのGASは反応する言葉が完全に別なので、同じチャンネルでも混ざらない
  - ゲーム：`開始` `終了` `取消` など
  - おこづかい：`ゴミ捨て` `布団しき` `布団たたみ` `水やり`
  - おこづかい側に「取消」などゲームとかぶる言葉を足さないこと
- GASは常時接続できないので、1分ごとにチャンネルとリアクションを確認する（承認の反映は最大1〜2分遅れる）
- お金が絡むので、**親の✅で確定**する承認制。ゲーム時間は承認なし
- 子ども2人に対応。金額・ゴミ捨ての数え方・月の合計はすべて子どもごと

---

## 2. 仕様

### 報告（子どもの発言だけに反応）

| お手伝い | 金額 | 書き方の例 |
|---|---|---|
| ゴミ捨て | その日1個目15円、2個目以降1個10円 | `ゴミ捨て` `ゴミ捨て2` `ごみすて２` `ゴミ出し` `ゴミ捨て×3` |
| 布団しき | 10円 | `布団しき` `ふとん敷き` `布団敷` |
| 布団たたみ | 10円 | `布団たたみ` `ふとん畳み` `布団畳` |
| 水やり | 15円 | `水やり` `みずやり` `水遣り` |

- 空白を除いて、上の言葉＋個数（なしなら1）に**完全一致**したときだけ反応する
- ひらがな・カタカナ・漢字、全角数字、漢数字、「×2」「2個」「2回」はOK
- 個数は1〜10まで（打ち間違い防止）
- **書き方が違うときは無反応**。ボットが返事しなかったら書き方がおかしい合図
- 金額や言葉はコード先頭の `CHORES` で変えられる

### 受付

- ボットが報告に返信し、その返信に自分で✅と❌を付ける
  - 例：「@たろうのゴミ捨て×2を受け付けたで（25円の予定）／親が✅で承認、❌で却下やで」
- 予定金額は、その日の承認済み＋未承認の分を先に数えた金額（目安）

### 承認・却下

- `PARENTS` に登録した親が、**ボットの返信**の✅を押したら承認、❌なら却下
- 子どもやボット自身のリアクションは無視（押した人の一覧をユーザーIDで確認する）
- 親が✅と❌を両方押しているときは、どちらかが外されるまで保留
- 一度確定したら、あとでリアクションを外しても取り消さない（直したいときはシートを直接編集）
- 確定したらボットが返信する
  - 承認：「@たろうのゴミ捨てを承認したで +15円（10月の合計 120円）」
  - 却下：「@たろうのゴミ捨て×2は却下されたで」

### ゴミ捨ての金額の決め方

- **承認された分だけ**で、その子のその日（0時区切り）の個数を数える
- 例：朝「ゴミ捨て2」→ 夜「ゴミ捨て1」
  - 両方承認：朝 15＋10＝25円、夜 10円
  - 朝が却下：夜が1個目扱いで15円
- 承認した順に数える。合計（その日 n 個なら 15＋10×(n−1) 円）はどの順でも同じ

### 月まとめ

- 毎月1日の8時台に、前月の承認済み合計を子どもごとに投稿（未承認があれば件数も）
- 月またぎの報告は**報告した月**に入れる
- 月まとめのあとに前月分が承認されたら「前月分の追加承認やで：…（9月の合計 ○円）」と知らせる
- 支払い済みの記録は今はしない

### 深夜の動き

- 23時〜6時は、未承認がなければ10分ごとの確認に落とす（GASの1日の実行時間の上限対策）

### スプレッドシート（シート名「記録」）

| 列 | 内容 |
|---|---|
| A | 報告日時（Discordに書き込んだ時刻） |
| B | 子ども（記録した時点の呼び名。表示用） |
| C | ユーザーID（判定・集計に使う本体） |
| D | お手伝い |
| E | 個数 |
| F | 金額（確定したときに入る。却下は0） |
| G | 状態（未承認／承認／却下） |
| H | 報告メッセージID |
| I | ボット返信ID（✅❌を確認するメッセージ） |
| J | 確定日時 |
| K | 確定した人（親のユーザーID） |
| L | 備考 |

---

## 3. セットアップ手順

### 3-1. 前提

- ゲーム時間ボットのボット・Vercel中継がすでに動いていること
- 中継が最新版（チャンネル制限なし・リアクション一覧の取得を許可）であること
- ボットのロールに `チャンネルを見る` `メッセージを送信` `メッセージ履歴を読む` `リアクションの追加` があること（公開チャンネルならロールの権限だけでOK）

### 3-2. IDを調べる（開発者モードをオンにして右クリック／長押し）

- 一般チャンネルのID
- 子ども2人のユーザーID（ゲーム時間GASの `CHILDREN` と同じ）
- 親2人のユーザーID

### 3-3. GASを設定する

1. 親のGoogleアカウントで**新しいスプレッドシート**を作る（例：おこづかい記録）
2. 「拡張機能」→「Apps Script」を開く
3. 歯車「プロジェクトの設定」でタイムゾーンを **(GMT+09:00) 日本標準時 - 東京** にする
4. `コード.gs` の中身を消して、後述の「4. コード全文」を貼り付けて保存
5. 関数 `setupProperties` を実行し、権限を許可する
6. 「スクリプト プロパティ」で「未設定」に値を入れる

| プロパティ | 値 |
|---|---|
| `RELAY_URL` | 最初から入っている（ゲームと同じ中継） |
| `RELAY_SECRET` | ゲーム時間GASと同じ値をコピー |
| `CHANNEL_ID` | 一般チャンネルのID |
| `CHILDREN` | 子どものユーザーIDをカンマ区切り（`ID:呼び名` も可） |
| `PARENTS` | 親のユーザーIDをカンマ区切り |

7. `checkProperties` で「全部入ってる」と出ればOK
8. `testRelay` を実行 → チャンネルに「おこづかいボットの中継テストやで」が出ればOK
9. 関数 `setup` を実行
   - シート「記録」が作られる
   - 1分ごとの `main` と、毎月1日8時台の `monthlyReport` のトリガーが登録される
   - 実行前のチャンネルのメッセージは処理しない

GASが自分で使うプロパティ：`LAST_MESSAGE_ID`（どこまで読んだかのしおり。消さない）

### 3-4. 動作確認

1. 子どものアカウントで `ゴミ捨て2` → 1分以内に返信と✅❌が付く
2. 親のアカウントで返信の✅を押す → 1〜2分以内に「承認したで +25円」
3. もう一度 `ゴミ捨て` → ❌を押す → 「却下されたで」
4. 子どものアカウントで✅を押しても承認されないことを確認
5. 月まとめを試すときは、エディタから `monthlyReport` を手動実行（前月分が投稿される）
6. テスト用に自分のIDを `CHILDREN` に足してもよい。終わったら外し、テストの行を消す

### 3-5. 子どもへのルール説明

- お手伝いをしたら一般チャンネルに「ゴミ捨て2」「水やり」のように書く
- ボットから「受け付けたで」が来たらOK。来なかったら書き方が違う
- 親が✅を押したらおこづかい確定

---

## 4. コード全文

```javascript
/**
 * お手伝いおこづかいボット（Discord × GAS × Vercel中継）
 * 1分ごとのトリガーで main() を、毎月1日の朝に monthlyReport() を実行する
 *
 * しくみ:
 *   1. 子どもがチャンネルに「ゴミ捨て2」「水やり」などと書く
 *   2. ボットが「受け付けたで」と返信し、その返信に自分で✅と❌を付ける
 *   3. 親が✅を押したら承認（金額が確定）、❌なら却下
 *   4. 毎月1日の朝に、前月の承認済み合計を子どもごとに通知する
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
const NIGHT_START = 23;             // 深夜の開始（時）
const NIGHT_END = 6;                // 深夜の終了（時）
const NIGHT_INTERVAL_MIN = 10;      // 深夜・未承認がないときの確認間隔（分）
const OK = '✅';
const NG = '❌';

// お手伝いの種類と金額
//   first: その日（0時区切り）の1個目の金額、next: 2個目以降の1個あたりの金額
//   words: 報告で受け付ける書き方（ひらがな・カタカナ・漢字の違いは自動で吸収する）
const CHORES = [
  { name: 'ゴミ捨て',   first: 15, next: 10, words: ['ごみすて', 'ごみだし'] },
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
    const now = new Date();
    const h = now.getHours();
    const isNight = (h >= NIGHT_START || h < NIGHT_END);
    if (isNight && waitingRows().length === 0 && now.getMinutes() % NIGHT_INTERVAL_MIN !== 0) return;

    processMessages();
    checkReactions();
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
      handleReport(m, cmd);
    } catch (e) {
      console.error(`処理エラー (${m.id}): ${e}`);
    }
  }
}

// 書き込みを報告に変換（完全一致のみ）。例: ゴミ捨て2 / ごみすて２ / ゴミ捨て×2 / 水やり
function parseReport(text) {
  let s = String(text || '')
    .replace(/[\s　]/g, '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)); // カタカナ → ひらがな
  // 漢字の書き方をひらがなにそろえる
  [['捨', 'す'], ['出', 'だ'], ['布団', 'ふとん'], ['敷', 'し'], ['畳', 'たた'], ['水', 'みず'], ['遣', 'や']]
    .forEach(([a, b]) => { s = s.split(a).join(b); });
  // 漢数字
  const kan = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  s = s.replace(/[一二三四五六七八九十]/g, c => String(kan[c]));

  const m = s.match(/^(.+?)(?:[x×*]?(\d+)(?:こ|個|かい|回)?)?$/i);
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
      // ボットの返信を取得して、リアクションの数を見る（ボット自身の1つを除いて増えていたら中身を調べる）
      const msgs = api('get', `/channels/${prop('CHANNEL_ID')}/messages?around=${botId}&limit=1`) || [];
      const msg = msgs.find(x => x.id === botId);
      if (!msg) continue;
      const okBy = reactedParent(msg, botId, OK, parents);
      const ngBy = reactedParent(msg, botId, NG, parents);
      if (okBy && ngBy) continue;           // 両方押されているときは保留
      if (okBy) approve(row, okBy);
      else if (ngBy) reject(row, ngBy);
    } catch (e) {
      console.error(`リアクション確認エラー (行${row}): ${e}`);
    }
  }
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
  return api('post', `/channels/${prop('CHANNEL_ID')}/messages`, {
    content: content,
    allowed_mentions: { parse: [] },
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
```

---

## 5. 制限・注意点

- 承認の反映は最大1〜2分遅れる（1分ごとの確認のため）
- 未承認が多いほど、1回の確認でDiscordに問い合わせる回数が増える（1件につき1回、親が押していれば＋1〜2回）
- GASの無料枠はトリガーの合計実行時間が1日90分。ゲーム時間GASと合わせても通常は収まる見込みだが、「実行数」画面でときどき確認する
- 金額を直したいときはシートのF列（金額）とG列（状態）を直接編集してよい。月の合計は「承認」のF列を足したもの

## 6. トラブルシューティング

| 症状 | 確認すること |
|---|---|
| 報告に返事がない | 書き方が表の通りか。`CHILDREN` にその子のIDがあるか。個数が1〜10か |
| ✅を押しても承認されない | 押したのがボットの**返信**か（子どもの報告のほうではない）。`PARENTS` に親のIDがあるか。✅と❌を両方押していないか |
| 「中継に拒否された」 | Vercelの中継が最新版か |
| 月まとめが来ない | トリガー一覧に `monthlyReport` があるか。タイムゾーンが東京か |
