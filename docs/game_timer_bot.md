# ゲーム時間記録ボット（Discord × GAS × Vercel中継）ナレッジ

> 作成日：2026年9月30日
> 更新：2026年10月1日（子ども2人に対応、週の上限表示をやめた、中継のチャンネル制限を撤廃）
> 目的：子どものゲーム開始・終了をDiscordで記録し、制限時間を過ぎたら通知する。週ごとの合計も自動で出す。

---

## 1. 背景・方針

- これまでGoogleチャットで開始・終了を報告していたが、「送ったのに届いていない」「打ち忘れた」などの言い訳・勘違いが発生していた
- Googleチャットは**個人アカウントではボット作成・API利用ができない**（Chat APIはGoogle Workspaceアカウント専用。公式ドキュメントで確認済み）
- そのため**Discord**に移行。GASは常時接続できないので、**1分ごとにチャンネルを読みに行く方式（ポーリング）**を採用
- **GASから直接Discordのボット通信はできない**（2026年9月に検証）
  - GASはUser-Agentを変更できず「Mozilla/5.0 (compatible; Google-Apps-Script…)」で固定される
  - Discordはこの名乗り＋ボット認証の通信を `403 / 40333 internal network error` で拒否する（デタラメなトークンでも同じ結果＝トークンを見る前に拒否）
  - 認証なしの通信は200で通るので、GoogleのIPブロックではない
  - Webhookでの投稿も `429 / error code 1015`（Cloudflareのレート制限）で不安定
  - Glitchは2025年7月にホスティング終了、GitHub Actionsは遅延が大きく不向き
- そのため **Vercelに中継Function（リポジトリ `hachi-bit/game-timer-relay`）を置き**、GAS → Vercel → Discord の順で通信する
  - GAS：1分ごとのトリガー、判定、スプレッドシート記録
  - Vercel：ボット用のUser-Agentを付けてDiscordへ転送。ボットのトークンはVercelだけに置く
  - GAS→Vercelは合言葉（RELAY_SECRET）で認証。中継が許可するのはメッセージの取得・投稿、ボット自身のリアクションの付け外し、リアクションした人の一覧の取得だけ
  - 中継は**チャンネルを制限しない**（2026年10月〜）。触れるチャンネルは「Discordでボットに見せるチャンネル」で決まる。チャンネルを増やしてもVercelの再デプロイは不要
- 同じチャンネル（一般）を、お手伝いおこづかい用の別GASと共用している。反応する言葉が別なので混ざらない
- 子どもの端末：Androidタブレット
- 将来の拡張候補：NFCタグでの自動検知、週ごとのスレッド作成

---

## 2. 仕様

### 子ども複数人への対応

- スクリプトプロパティ `CHILDREN` に登録した子ども（ユーザーID）の発言だけに反応する
- 書き込んだ人のユーザーIDで子どもを見分け、**開始中・取消・取消の取消・通知・週の合計をすべて子どもごとに独立**させる
- 2人同時に開始してもよい。取消できるのは自分の記録だけ
- 返信ではメンション形式（`<@ID>`）で名前を出す（Discordが表示名に変換する。通知は飛ばさない）
- 判定・集計はユーザーIDで行う。名前を変えても記録はずれない

### コマンド（登録した子どもの発言だけに反応）

空白（半角・全角）を取り除いたあと、メッセージが**以下と完全一致**したときだけ反応する。会話中の「開始」「終了」には反応しない。

| 書き込み | 動作 |
|---|---|
| `開始` | 開始（制限2時間） |
| `開始3時間` / `3時間開始` | 開始（制限3時間）。3は半角・全角・漢数字「三」どれでもOK |
| `終了` | 終了 |
| `取消` / `取り消し` / `取消し` | 直前の開始または終了を取り消す |
| `取消の取消` / `取り消しの取り消し` | 直前の取消をなかったことにする |

- 受け付けたら元のメッセージに✅をつけ、返信する
- 時刻は**Discordに書き込んだ時刻**を使う（GASの確認が1分遅れても時刻はずれない）
- 1分の間に複数のメッセージがあっても、**書かれた順に1件ずつ処理**し、それぞれに返信する

### 開始

- 返信例：「@たろうの開始を受け付けたで（11:50）。今回は2時間、13:50までやで」
- すでに開始中なら：「もう開始中やで（11:50から、13:50まで）」
- 前回の終了がないまま、前回の2回目の通知時刻（制限時間＋10分）を過ぎていたら、前回を「終了忘れ」として閉じて新しく開始する

### 終了

- 返信例：「@たろうの終了を受け付けたで（13:25）。今回は1時間35分。今週の合計は8時間20分」
- 開始していないのに終了が来たら：「@たろうの開始の記録がないで」

### 通知

- 制限時間ちょうど：その子どもだけに@メンションで1回目の通知
- その10分後もまだ終了がなければ：@メンションで2回目の通知
- 通知はこの2回まで

### 取消

- 直前の1回（開始または終了）だけ取り消せる。時間制限なし（チャットに履歴が残るため）
- 開始の取消：その記録を「取消」にする（プレイ時間に数えない）。その開始で前回を「終了忘れ」にしていた場合は、前回を「開始中」に戻す
- 終了の取消：終了をなかったことにして「開始中」に戻す。制限時間・通知はそのまま続く
- 取り消せるものがないとき：「取り消せるものがないで」
- 終了を取り消したあとに「終了」と書くと、**最初の開始時刻から**その時点までで記録される（週の合計からもいったん外れ、再度の終了で足される）

### 取消の取消

- 直前の取消をなかったことにして、取消する前の状態に戻す
  - 開始の取消 → 元の開始時刻のまま「開始中」に戻す（制限時間・通知もそのまま。前回を終了忘れにしていた場合はそれも戻す）
  - 終了の取消 → 元の終了時刻・プレイ時間の「終了」に戻す
- 使えるのは取消の直後だけ。間に「開始」「終了」が入ったら「取り消せるものがないで」
- 取消の取消のあと、もう一度「取消」も可能（行ったり来たりできる）

### 終了を書き忘れたとき

- 通知のあとも「開始中」のまま残る
- あとから「終了」が来たら、その時点までの実際の時間で記録する
- 終了がないまま次の「開始」が来たら、前回を「終了忘れ」として閉じ、**制限時間＋10分**を使ったことにする

### 週の合計

- 月曜0時始まり、子どもごとに集計
- 状態が「終了」「終了忘れ」の記録を合計する
- 上限（残り時間・オーバー）の表示はしない（2026年10月に廃止）

### 深夜の動き

- 23時〜6時は、開始中でなければ**10分ごと**の確認に落として実行時間を節約する
- 開始中のときは深夜も1分ごとに確認する

### スプレッドシート（シート名「記録」）

| 列 | 内容 |
|---|---|
| A | 開始日時 |
| B | 制限時間（時間） |
| C | 終了日時 |
| D | プレイ時間（分） |
| E | 状態（開始中／終了／終了忘れ／取消） |
| F | 1回目の通知日時 |
| G | 2回目の通知日時 |
| H | 開始メッセージID |
| I | 備考 |
| J | 子ども（記録した時点の呼び名。表示用） |
| K | ユーザーID（判定・集計に使う本体） |

親が手で直したいときは、この表を直接編集すればよい（状態が「開始中」の行は**子ども1人につき**1行以下にすること。K列のユーザーIDは消さない）。

J列の名前は、`CHILDREN` に固定の呼び名を書いていればそれ、なければDiscordの表示名（なければユーザー名）。

---

## 3. セットアップ手順

### 3-1. Discordのボットを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) を開き、「New Application」で新しいアプリを作る（名前は例：ゲーム記録）
2. 左メニュー「Bot」を開く
   - 「Reset Token」でトークンを発行してコピー（**他人に見せない**。漏れたら再発行）
   - 「Privileged Gateway Intents」の **MESSAGE CONTENT INTENT をオン**にして保存（これがないとメッセージの中身が読めない）
3. 左メニュー「OAuth2」→「URL Generator」
   - Scopes：`bot`
   - Bot Permissions：`View Channels`、`Send Messages`、`Read Message History`、`Add Reactions`
   - 連携タイプ（Integration Type）は「ギルドインストール（Guild Install）」
   - 一番下の「生成されたURL」をコピーする
   - **ボットをサーバーに追加する**
     1. コピーしたURLをブラウザのアドレス欄に貼り付けて開く（Discordにログインしている状態で）
     2. 「サーバーに追加」のプルダウンで家族のサーバーを選び、「はい」または「続ける」
     3. 権限の一覧が出るので、そのまま「認証」
     4. ロボットでないことの確認が出たら答える
     5. サーバーのメンバー一覧にボットが表示されたら完了
   - プルダウンにサーバーが出ないときは、そのサーバーの「サーバー管理」権限がない（サーバーを作った本人ならある）
4. ゲーム記録用のチャンネルを作る（例：#ゲーム記録）。ボットがそのチャンネルを見られることを確認する

### 3-2. Vercelに中継を置く

1. Vercelに **GitHubでログイン**し、`hachi-bit/game-timer-relay` をImportしてDeploy
   - リポジトリが出ない／「GitHub integrationが必要」と出るときは、GitHubの設定 → Applications → Vercel の「Repository access」で `game-timer-relay` を追加して Save
2. Vercelのプロジェクト → Settings → Environment Variables に2つ追加（Environmentsは全部のままでOK）

| Key | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | ボットのトークン |
| `RELAY_SECRET` | 合言葉（GASの `makeSecret` で作る長い文字列） |

3. Deployments から **Redeploy**（環境変数は再デプロイで反映される）
4. `https://game-timer-relay.vercel.app/api/discord` をブラウザで開いて `{"error":"method not allowed"}` なら中継は動いている（`relay not configured` なら環境変数が未反映）

### 3-3. IDを調べる

1. Discordの「ユーザー設定」→「詳細設定」→「開発者モード」をオン
2. ゲーム記録チャンネルを右クリック（長押し）→「チャンネルIDをコピー」
3. 子どもそれぞれのアカウントを右クリック（長押し）→「ユーザーIDをコピー」

### 3-4. GASを設定する

1. 親のGoogleアカウントで新しいスプレッドシートを作る（例：ゲーム時間記録）
2. 「拡張機能」→「Apps Script」を開く
3. 左の歯車「プロジェクトの設定」
   - タイムゾーンを **(GMT+09:00) 日本標準時 - 東京** にする
4. エディタの `コード.gs` の中身を消して、後述の「4. コード全文」を貼り付けて保存
5. 関数 `setupProperties` を実行し、権限を許可する
   - スクリプトプロパティ `RELAY_URL` / `RELAY_SECRET` / `CHANNEL_ID` / `CHILDREN` の枠が作られる（`RELAY_URL` 以外は「未設定」）
   - `CHILDREN` は子どものユーザーIDをカンマ区切りで入れる（例：`111…,222…`）。固定の呼び名を使うなら `111…:たろう,222…:じろう`
   - すでに値が入っている項目は上書きしない。古い `DISCORD_BOT_TOKEN` は自動で消える（トークンはVercelだけに置く）
   - 「プロジェクトの設定 → スクリプト プロパティ」で「未設定」の3つに値を入れて保存
   - `checkProperties` を実行し「全部入ってる」と出ればOK
6. `testRelay` を実行 → 「取得OK」「投稿OK」と出て、チャンネルに「中継テストやで」が投稿されればOK
7. 関数 `setup` を実行する
   - シート「記録」が作られる
   - 1分ごとのトリガーが登録される
   - 実行前のチャンネルのメッセージは処理しない（ここから記録開始）
8. テスト中は `CHILDREN` に自分のIDを入れておき、本番前に子どものIDに書き換える（setupの再実行は不要）

### 3-4b. 1人用（CHILD_USER_ID）から移行するとき

1. `コード.gs` を新しいコードに貼り替えて保存
2. 関数 `setupProperties` を実行
   - `CHILDREN` の枠が作られ、今の `CHILD_USER_ID` の値が自動でコピーされる（今までの子どもが1人目になる）
3. 「スクリプト プロパティ」で `CHILDREN` の後ろに `,2人目のID` を書き足して保存
4. 関数 `migrateToMultiChild` を1回だけ実行
   - J・K列の見出しが付き、今までの記録が1人目の分として埋まる（J列の名前は固定の呼び名を書いたときだけ入る。空なら手で入れてもよい）
   - 取消用の控えも1人目の分に移る
5. 古い `CHILD_USER_ID` は消してよい

### 3-5. 動作確認

1. 子どものアカウントで「開始」と書く → 1分以内に✅と返信が来る
2. 「取消」と書く → 取消の返信が来て、シートの状態が「取消」になる
3. 「開始」→「終了」で、プレイ時間と週の合計が返ってくる
4. もう1人のアカウントでも「開始」と書き、1人目と別々に記録されることを確認する
5. 通知の確認をしたいときは、シートの開始日時を2時間前に書き換えると1分以内に通知が来る

### 3-6. 子どもへのルール説明

- ゲームを始めるときは「開始」、終わるときは「終了」だけを書く
- 3時間の日は「開始3時間」
- 間違えたら「取消」、取消を間違えたら「取消の取消」
- ✅と返信が来たら受け付け完了。来なかったら（1分以上待っても）親に言う

---

## 4. コード全文

```javascript
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
const SECOND_NOTICE_MIN = 10;       // 1回目の通知から2回目までの分数
const NIGHT_START = 23;             // 深夜の開始（時）
const NIGHT_END = 6;                // 深夜の終了（時）
const NIGHT_INTERVAL_MIN = 10;      // 深夜・開始中でないときの確認間隔（分）

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
    const now = new Date();
    const h = now.getHours();
    const isNight = (h >= NIGHT_START || h < NIGHT_END);
    if (isNight && activeRows().length === 0 && now.getMinutes() % NIGHT_INTERVAL_MIN !== 0) return;

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
      if (cmd.type === 'start') handleStart(m, cmd.hours);
      else if (cmd.type === 'end') handleEnd(m);
      else if (cmd.type === 'undo') handleUndo(m);
      else if (cmd.type === 'redo') handleRedo(m);
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
  if (s === '取消の取消' || s === '取り消しの取り消し' || s === '取消しの取消し') return { type: 'redo' };
  return null;
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
      reply(m, `もう開始中やで（${fmtTime(start)}から、${fmtTime(limitEnd)}まで）`);
      return;
    }
    // 前回を「終了忘れ」で閉じる
    sh.getRange(active, C.END).setValue(forgotAt);
    sh.getRange(active, C.MIN).setValue(limitH * 60 + SECOND_NOTICE_MIN);
    sh.getRange(active, C.STATUS).setValue(ST.FORGOT);
    prevRow = active;
  }

  sh.appendRow([t, hours, '', '', ST.ACTIVE, '', '', "'" + m.id, '', childName(m.author), "'" + uid]);
  const row = sh.getLastRow();
  setLastAction(uid, { type: 'start', row: row, prevRow: prevRow });
  setLastUndo(uid, null);

  let msg = `<@${uid}>の開始を受け付けたで（${fmtTime(t)}）。今回は${hours}時間、${fmtTime(addMin(t, hours * 60))}までやで`;
  if (prevRow) msg += '\n前回は終了がなかったから「終了忘れ」で記録したで';
  react(m);
  reply(m, msg);
}

// ===== 終了 =====
function handleEnd(m) {
  const sh = sheet();
  const uid = m.author.id;
  const active = findActiveRow(uid);
  if (!active) {
    reply(m, `<@${uid}>の開始の記録がないで`);
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
  reply(m, `<@${uid}>の終了を受け付けたで（${fmtTime(t)}）。今回は${fmtDur(min)}。今週の合計は${fmtDur(total)}`);
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
    sh.getRange(la.row, C.NOTE).setValue(`取消 ${fmtTime(new Date(m.timestamp))}`);
    let msg = `<@${uid}>の開始を取り消したで`;
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
    reply(m, `<@${uid}>の終了を取り消したで。開始中に戻したで（${fmtTime(addMin(start, limitH * 60))}まで）`);
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
    sh.getRange(la.row, C.NOTE).clearContent();
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
    post(child, `<@${child}> ${limitH}時間たったで！そろそろ「終了」してな（${fmtTime(start)}開始）`);
    sh.getRange(active, C.N1).setValue(now);
  } else if (n1 && !n2 && now >= addMin(limitEnd, SECOND_NOTICE_MIN)) {
    post(child, `<@${child}> まだ「終了」の記録がないで！${limitH}時間${SECOND_NOTICE_MIN}分たったで（${fmtTime(start)}開始）`);
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
```

---

## 5. 制限・注意点

- **反応は最大1分遅れる**（ポーリング方式のため）。深夜で開始中でなければ最大10分
- GASの無料枠：トリガーの合計実行時間は1日90分まで。1回の実行は1秒前後なので、1分ごとでも収まる見込み
- ボットのトークンが漏れたら、Developer Portalで「Reset Token」し、Vercelの環境変数を更新してRedeployする
- 合言葉を変えるときは、VercelとGASのスクリプトプロパティの両方を変え、VercelはRedeployする
- Vercelの無料（Hobby）プランは個人・非商用向け。この用途の通信量は無料枠に収まる見込み
- Discordは利用規約で13歳以上が条件

## 6. トラブルシューティング

| 症状 | 確認すること |
|---|---|
| `Discord API 500` `relay not configured` | Vercelの環境変数が3つあるか。追加後にRedeployしたか |
| 反応がない | トリガーが登録されているか（Apps Script左の時計アイコン）。「実行数」でエラーが出ていないか |
| 「合言葉がVercelと一致していない」 | GASの `RELAY_SECRET` とVercelの `RELAY_SECRET` が同じか。Vercelを変えたらRedeployしたか |
| 「中継に拒否された」 | Vercelの中継が最新か（チャンネル制限撤廃・リアクション一覧取得の許可が入った版か） |
| `Discord API 401` | Vercelの `DISCORD_BOT_TOKEN` が正しいか |
| `Discord API 403` / `40333` | GASから直接Discordに通信している。`RELAY_URL` 経由になっているか確認 |
| `Discord API 403` / `50001` | ボットがチャンネルを見られるか、権限（View Channels / Send Messages / Read Message History / Add Reactions）があるか |
| 開始と書いても無反応だがエラーもない | MESSAGE CONTENT INTENT がオンか。`CHILDREN` に子どものIDが入っているか。「開始」以外の文字が入っていないか |
| 時刻が9時間ずれる | プロジェクトのタイムゾーンが東京になっているか |
| 状態がおかしくなった | シートを直接直す。「開始中」の行が2行以上ないようにする |

---

*このドキュメントは2026年9月時点の情報をもとに作成。DiscordやGASの仕様は変わる可能性がある。*
