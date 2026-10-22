// node test.js — 実際のメッセージハンドラーと取得処理を、通信・ダウンロードなしで確認する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

(async () => {
  const local = { slackToken: 'xoxb-test', slackChannel: 'C1', webhook: 'https://discord.com/api/webhooks/example', history: [{ text: '旧履歴' }], importQueue: ['old'], importTotal: 1 };
  const session = {}, downloads = [], tabs = [], sent = [];
  let listener, onRemoved, state = 'complete', nextId = 1, rateLimited = 0, blockedUpload, uploadStarted;
  const removed = [];
  const storage = (data) => ({
    get: async (keys) => Object.fromEntries([].concat(keys).map((key) => [key, copy(data[key])])),
    set: async (values) => Object.assign(data, copy(values)),
    remove: async (keys) => { for (const key of [].concat(keys)) delete data[key]; },
  });
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      create: async (options) => { const tab = { ...options, id: nextId++ }; tabs.push(tab); return tab; },
      update: async (id, options) => Object.assign(tabs.find((tab) => tab.id === id), options),
      onRemoved: { addListener: (fn) => { onRemoved = fn; } },
      remove: async (id) => { removed.push(id); await onRemoved(id); },
    },
    downloads: {
      download: async (options) => { downloads.push(options); return downloads.length; },
      search: async () => [{ state, error: state === 'interrupted' ? 'DISK_FULL' : undefined }],
    },
  };
  const fetch = async (url, options) => {
    sent.push({ url, ...options, body: options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : new TextDecoder().decode(options.body) });
    if (url.startsWith('https://files.slack.com/') && blockedUpload) { uploadStarted(); await blockedUpload; }
    if (rateLimited && rateLimited--) return { status: 429, headers: { get: () => '0' } };
    return { ok: true, json: async () => url.endsWith('getUploadURLExternal') ? { ok: true, upload_url: 'https://files.slack.com/upload/' + sent.length, file_id: 'F' + sent.length } : { ok: true, ts: 'ts' + sent.length } };
  };
  vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), { chrome, URL, URLSearchParams, TextEncoder, setTimeout, fetch });
  const message = (msg, sender = {}) => new Promise((resolve) => assert.equal(listener(msg, sender, resolve), true));
  assert.deepEqual(Object.keys(local), ['slackToken', 'slackChannel'], '旧履歴と Discord 設定を削除し、Slack 設定だけを保持する');
  // 新規会話の質問 2 件を同時に送っても親投稿は 1 つで、残りはそのスレッドへ入る
  await Promise.all([
    message({ type: 'prompt', conversation: 'abc', text: '新しい質問 <!channel>', account: 'test account' }),
    message({ type: 'answer', conversation: 'abc', text: '回答 & 補足' }),
  ]);
  await message({ type: 'prompt', conversation: 'xyz', text: '別の会話', account: 'test account' });
  assert.equal(sent[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(sent[0].headers.Authorization, 'Bearer xoxb-test');
  assert.deepEqual(sent.map(({ body }) => body.thread_ts), [undefined, 'ts1', undefined], '会話ごとに最初の投稿を親にし、以降はスレッドへ返信する');
  assert.equal(sent[0].body.text, '新しい質問 &lt;!channel&gt;', '本文に名前の見出しを付けず、メンションなどの Slack 記法を無効化する');
  assert.equal(sent[1].body.text, '回答 &amp; 補足', 'Gemini の本文にも名前の見出しを付けない');
  assert.deepEqual(sent.map(({ body }) => body.icon_emoji), [':bust_in_silhouette:', ':robot_face:', ':bust_in_silhouette:'], '親投稿・返信とも、ユーザーは人間、Gemini はロボットのアイコンで送る');
  assert.deepEqual(sent.map(({ body }) => body.username), ['test account', 'Gemini', 'test account'], 'ユーザーと Gemini の投稿者名を使い分ける');
  sent.length = 0;
  await message({ type: 'prompt', conversation: 'abc', text: '分析して', account: 'me', attachments: ['Scripts', 'a<b>.png'] });
  assert.equal(sent[0].body.text, '分析して\n📎 添付: Scripts, a&lt;b&gt;.png', '添付は名前だけを知らせる');
  local.nickname = 'サンプル<3';
  await message({ type: 'prompt', conversation: 'abc', text: 'こんにちは', account: 'Sample User (user@example.com)' });
  assert.equal(sent[1].body.text, 'こんにちは', '名前とメールを本文に追加しない');
  assert.equal(sent[1].body.username, 'サンプル<3', 'ニックネームを投稿者名に使い、メールは追加しない');
  await message({ type: 'prompt', conversation: 'abc', text: 'メールなし', account: 'me' });
  assert.equal(sent[2].body.username, 'サンプル<3', 'メールなしでもニックネームを使う');
  await message({ type: 'answer', conversation: 'abc', text: '回答' });
  assert.equal(sent.at(-1).body.username, 'Gemini', 'ユーザーのニックネームを Gemini に使わない');
  delete local.nickname;
  for (const account of ['Sample User (user@example.com)', 'Sample User（user@example.com）']) {
    await message({ type: 'prompt', conversation: 'abc', text: '質問', account });
    assert.equal(sent.at(-1).body.username, 'Sample User', 'ニックネーム未設定ならメールを除いた Google アカウント名を使う');
  }
  await message({ type: 'prompt', conversation: 'abc', text: '質問' });
  assert.equal(sent.at(-1).body.username, 'ユーザー', 'アカウント名も取得できなければユーザーと表示する');
  assert.ok((await message({ type: 'prompt', conversation: '../x', text: 'x' })).error);
  assert.equal(JSON.stringify(local).includes('新しい質問'), false, 'Slack 転送で本文を蓄積しない');
  sent.length = 0;
  await message({ type: 'answer', conversation: 'abc', text: '📎 code-1.html', files: [{ name: 'code-1.html', content: '<p>あ</p>' }] });
  assert.deepEqual(sent.map(({ url }) => url.split('/').pop()), ['chat.postMessage', 'files.getUploadURLExternal', '2', 'files.completeUploadExternal'], 'コードは同じスレッドへファイルとして添付する');
  assert.equal(sent[1].body.length, '10', 'ファイル長はバイト数で送る');
  assert.equal(sent[2].body, '<p>あ</p>', 'ファイルの中身はエスケープせずそのまま上げる');
  assert.deepEqual(sent[3].body, { files: JSON.stringify([{ id: 'F2', title: 'code-1.html' }]), channel_id: 'C1', thread_ts: 'ts1', username: 'Gemini 添付', icon_emoji: ':paperclip:' });
  assert.ok((await message({ type: 'answer', conversation: 'abc', text: 'x', files: [{ name: '../x', content: 'x' }] })).error);
  sent.length = 0;
  await message({ type: 'canvas', conversation: 'abc', files: [{ name: 'canvas-1.html', content: '<html></html>' }] });
  assert.deepEqual(sent.map(({ url }) => url.split('/').pop()), ['files.getUploadURLExternal', '1', 'files.completeUploadExternal'], 'Canvas は本文なしでファイルだけを添付する');
  assert.equal(sent[2].body.thread_ts, 'ts1', 'Canvas も同じスレッドへ添付する');
  assert.equal(sent[2].body.username, 'Gemini 添付', 'Canvas もファイル添付用の名前を使う');
  assert.equal(sent[2].body.icon_emoji, ':paperclip:', 'Canvas の添付アイコンはクリップにする');
  sent.length = 0;
  let releaseUpload;
  blockedUpload = new Promise((resolve) => { releaseUpload = resolve; });
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  const slowCanvas = message({ type: 'canvas', conversation: 'abc', files: [{ name: 'canvas-1.html', content: '<html>slow</html>' }] });
  await started;
  let textDone = false;
  const fastAnswer = message({ type: 'answer', conversation: 'abc', text: '添付の完了を待たない回答' }).then((result) => { textDone = true; return result; });
  try {
    await new Promise(setImmediate);
    assert.equal(textDone, true, 'ファイル転送中でも、後から来た回答本文は送信を完了できる');
    assert.equal(sent.at(-1).body.text, '添付の完了を待たない回答');
  } finally {
    releaseUpload();
    await Promise.all([slowCanvas, fastAnswer]);
    blockedUpload = null;
  }
  assert.equal(sent.at(-1).body.thread_ts, 'ts1', '本文を先に送っても、遅れて完了した添付は元のスレッドに入る');
  await message({ type: 'attachments', conversation: 'abc', account: 'me (me@example.com)', attachments: ['a<b>.png'] });
  assert.equal(sent.at(-1).body.text, '📎 添付: a&lt;b&gt;.png', '後から届いた添付名も Slack 記法をエスケープして追記する');
  assert.equal(sent.at(-1).body.thread_ts, 'ts1', '後追いの添付名は本文と同じスレッドへ入る');
  assert.equal(sent.at(-1).body.icon_emoji, ':bust_in_silhouette:', 'ユーザーの添付名の追記も人間のアイコンで送る');
  assert.equal(sent.at(-1).body.username, 'me', 'ユーザーの添付名の追記もユーザーの名前で送る');
  sent.length = 1;
  await message({ type: 'startExport' });
  assert.equal(tabs[0].url, 'https://gemini.google.com/app');
  const sender = { tab: { id: tabs[0].id }, url: 'https://gemini.google.com/app/one' };
  assert.equal(await message({ type: 'getExportJob' }, { tab: { id: 99 } }), null);
  await message({ type: 'startExport' });
  assert.equal(tabs.length, 1, '二重開始しない');
  assert.ok((await message({ type: 'exportQueue', queue: [{ href: 'https://example.com/app/one', title: 'invalid' }] }, sender)).error);
  const queue = [{ href: sender.url, title: '会話 / 1' }, { href: 'https://gemini.google.com/app/two', title: '会話 2' }];
  assert.equal((await message({ type: 'exportQueue', queue }, sender)).next, queue[0].href);
  assert.ok((await message({ type: 'exportConversation', texts: [] }, sender)).error);
  assert.equal(downloads.length, 0, '空の本文を保存成功として扱わない');
  assert.equal((await message({ type: 'exportConversation', texts: ['同じ質問', '同じ質問'] }, sender)).next, queue[1].href);
  assert.equal(decodeURIComponent(downloads[0].url).match(/同じ質問/g).length, 2, '同じ質問も送信回数分を残す');
  assert.equal(session.exportJob.saved, 1);
  assert.equal(JSON.stringify(session).includes('同じ質問'), false, '作業メモリにも本文を蓄積しない');
  state = 'interrupted';
  sender.url = queue[1].href;
  assert.match((await message({ type: 'exportConversation', texts: ['最後の質問'] }, sender)).error, /DISK_FULL/);
  assert.equal(session.exportJob.saved, 1, '保存失敗時は次へ進めない');
  assert.equal(session.exportJob.queue.length, 1);
  state = 'complete';
  await message({ type: 'exportConversation', texts: ['最後の質問'] }, sender);
  assert.equal(session.exportJob.done, true);
  assert.equal(session.exportJob.saved, 2);
  assert.equal(sent.length, 1, '履歴の保存で Slack に送信しない');
  await onRemoved(sender.tab.id);
  assert.equal(session.exportJob, undefined, '専用タブを閉じたら作業情報を消す');
  const update = chrome.tabs.update;
  chrome.tabs.update = async () => { throw new Error('タブを開けません'); };
  assert.match((await message({ type: 'startExport' })).error, /タブを開けません/);
  assert.equal(session.exportJob, undefined, '起動失敗時も再試行できる');
  chrome.tabs.update = update;

  // 全チャット取得: 一覧だけを控えて専用タブを閉じる
  const downloaded = downloads.length;
  await message({ type: 'startExport', mode: 'list' });
  const listTab = { tab: { id: tabs.at(-1).id }, url: 'https://gemini.google.com/app' };
  assert.equal(tabs.at(-1).url, 'https://gemini.google.com/app');
  await message({ type: 'exportQueue', queue: [{ href: 'https://gemini.google.com/app/abc', title: 'ブロック崩し' }] }, listTab);
  assert.deepEqual(session.chatList, [{ href: 'https://gemini.google.com/app/abc', title: 'ブロック崩し' }], '取得した一覧をプルダウン用に控える');
  assert.deepEqual([removed.at(-1), session.exportJob, session.lastResult], [listTab.tab.id, undefined, '1 件の会話を取得しました'], '取得後は専用タブを閉じて結果を残す');
  assert.equal(downloads.length, downloaded, '一覧の取得ではダウンロードしない');
  assert.ok((await message({ type: 'startExport', mode: 'send', chat: { href: 'https://example.com/app/abc', title: 'x' } })).error, 'Gemini 以外の URL は送信対象にしない');

  // チャット送信: 選んだ会話を開き、最初の質問で既存スレッドとは別の新しいスレッドを作る
  sent.length = 5;
  await message({ type: 'startExport', mode: 'send', chat: session.chatList[0] });
  const sendTab = { tab: { id: tabs.at(-1).id }, url: 'https://gemini.google.com/app/abc' };
  assert.equal(tabs.at(-1).url, 'https://gemini.google.com/app/abc', '選んだ会話を専用タブで開く');
  assert.equal(local.threads.abc, 'ts1', '送信前は既存のスレッドがある');
  await message({ type: 'prompt', conversation: 'abc', text: '最初の質問', account: 'me', newThread: true }, sendTab);
  await message({ type: 'answer', conversation: 'abc', text: '最初の回答' }, sendTab);
  assert.deepEqual(sent.slice(5).map(({ body }) => body.thread_ts), [undefined, 'ts6'], '既存スレッドに足さず、新しい親投稿の下へ続ける');
  assert.equal(local.threads.abc, 'ts6', '対応表を新しいスレッドに置き換える');
  await message({ type: 'prompt', conversation: 'abc', text: '', account: 'me', attachments: ['画像'] }, sendTab);
  assert.equal(sent[7].body.text, '\n📎 添付: 画像', '本文のない添付だけの質問も送る');
  const before429 = sent.length;
  rateLimited = 2;
  await message({ type: 'answer', conversation: 'abc', text: '混雑時の回答' }, sendTab);
  assert.equal(sent.length - before429, 3, '429 が返ったら待って送り直す');
  assert.equal(sent.at(-1).body.text, '混雑時の回答');
  await message({ type: 'exportSent' }, sendTab);
  assert.deepEqual([removed.at(-1), session.lastResult], [sendTab.tab.id, '「ブロック崩し」を Slack に送信しました'], '送信後は専用タブを閉じて結果を残す');

  let now = 0, tick = () => {}, busy = false, links = [];
  const query = { getClientRects: () => [{}], innerText: 'fallback', querySelectorAll: () => [] };
  const scroller = { parentElement: null, scrollHeight: 10, scrollTop: 0 };
  const domHandlers = {};
  const document = {
    addEventListener: (type, fn) => { domHandlers[type] = fn; },
    querySelector: () => links[0],
    querySelectorAll: (selector) => selector === 'user-query .query-text' ? [query] : selector === '[data-test-id="conversation"] a' ? links : [],
  };
  scroller.querySelectorAll = () => busy ? [query] : [];
  const context = vm.createContext({
    document, location: { pathname: '/app' }, URL, console,
    chrome: { runtime: { sendMessage: async () => null } },
    getComputedStyle: (element) => ({ visibility: 'visible', overflowY: element === scroller ? 'auto' : 'visible' }),
    Date: { now: () => now },
    setTimeout: (fn, ms) => { now += ms; tick(now); queueMicrotask(fn); },
  });
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), context);
  const settle = vm.runInContext('settle', context);
  const root = { querySelectorAll: () => busy ? [query] : [] };
  await settle(() => 'ready', () => {}, root);
  assert.equal(now, 800, '更新のない会話は固定 5.5 秒を待たない');
  now = 0;
  busy = true;
  tick = (time) => { busy = time < 2200; };
  await settle(() => now < 1800 ? 'partial' : 'complete', () => {}, root);
  assert.ok(now >= 2900, '本文の変化と読み込み中表示が終わるまで待つ');
  now = 0;
  busy = false;
  tick = () => {};
  let pages = 0;
  await settle(() => String(pages), () => { if (pages < 12) pages++; }, root);
  assert.equal(pages, 12, '追加読み込みを 5 回で打ち切らない');
  assert.deepEqual(copy(vm.runInContext('scrapeQueries()', context)), ['fallback']);
  const link = (id) => ({ href: 'https://gemini.google.com/app/' + id, innerText: id, parentElement: scroller });
  links = [link('initial')];
  now = 0;
  tick = (time) => { if (time >= 300) links = [link('later')]; };
  const conversations = await vm.runInContext('collectConversations()', context);
  assert.deepEqual(copy(conversations).map((item) => item.title), ['initial', 'later'], '仮想化で消えた最初の会話も残す');
  assert.equal(scroller.scrollTop, scroller.scrollHeight, '一覧末尾へスクロールする');
  const exported = [];
  context.location.pathname = '/app/one';
  document.querySelector = () => scroller;
  context.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'getExportJob') return { queue: [{ href: 'https://gemini.google.com/app/one' }] };
    exported.push(msg);
    return { next: 'https://gemini.google.com/app/two' };
  };
  await vm.runInContext('exportCurrentPage()', context);
  assert.deepEqual(copy(exported), [{ type: 'exportConversation', texts: ['fallback'] }], '実際のページ処理から本文をダウンロードへ渡す');
  assert.equal(context.location.href, 'https://gemini.google.com/app/two', '保存成功後に次の会話を開く');
  const relayed = [];
  let stopping = true;
  context.chrome.runtime.sendMessage = async (msg) => { relayed.push(msg); return {}; };
  const el = (tagName, props, ...childNodes) => {
    const node = { nodeType: 1, tagName, childNodes, children: childNodes.filter((child) => child.nodeType === 1), className: '', getAttribute: (name) => props?.[name] ?? null, ...props };
    const matches = (child, selector) => selector === child.tagName.toLowerCase() || selector === '.' + child.className;
    node.querySelector = (selector) => node.children.map((child) => matches(child, selector) ? child : child.querySelector(selector)).find(Boolean) || null;
    node.querySelectorAll = (selector) => node.children.flatMap((child) => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    node.textContent = node.innerText ??= childNodes.map((child) => child.textContent).join('');
    return node;
  };
  const t = (textContent) => ({ nodeType: 3, textContent });
  const answer = el('MESSAGE-CONTENT', {},
    el('H3', {}, t('主な仕様')),
    el('OL', {},
      el('LI', {}, el('P', {}, el('STRONG', {}, t('操作性')), t(':')), el('UL', {}, el('LI', {}, t('マウス '), el('CODE', {}, t('A/D'))))),
      el('LI', {}, el('P', {}, t('見た目')))),
    el('CODE-BLOCK', {}, el('DIV', { className: 'code-block-decoration' }, t('HTML'), el('BUTTON', {}, t('コピー'))), el('PRE', {}, el('CODE', { className: 'language-html', innerText: '<p>\n  x\n</p>\n' }))),
    el('IMMERSIVE-ENTRY-CHIP', {}, el('SPAN', {}, t('Neon Breakout Game')), el('BUTTON', {}, t('コード')), el('XAP-CODE-EDITOR', {}, t('見えている行だけ'))),
    el('P', {}, t('以上')));
  assert.deepEqual(copy(vm.runInContext('toMrkdwn', context)(answer)), {
    text: '\u200B*主な仕様*\u200B\n\n1. \u200B*操作性*\u200B:\n    ◦ マウス `A/D`\n2. 見た目\n\n📎 code-1.html\nNeon Breakout Game\n以上',
    files: [{ name: 'code-1.html', content: '<p>\n  x\n</p>' }],
  }, '見出し・番号・入れ子の箇条書き・太字・コードを Slack 記法へ変換し、コードブロックは別投稿に回す。Canvas はタイトルだけ残し、描画途中のエディタは含めない');
  const preview_ = (props, ...children) => el('USER-QUERY-FILE-PREVIEW', props, ...children);
  const pick = (type, files) => domHandlers[type]({ target: { type: 'file', files }, dataTransfer: { files }, clipboardData: { files } });
  pick('change', [{ name: 'Block.cs.meta', type: '' }]);
  pick('drop', [{ name: 'Bar.png', type: 'image/png' }]);
  pick('paste', [{ name: 'image.png', type: 'image/png' }]);
  assert.deepEqual(copy(vm.runInContext('attachments', context)(el('USER-QUERY', {},
    preview_({}, el('BUTTON', { 'aria-label': 'Bar.png.meta' }, el('DIV', { className: 'filename-label', innerText: 'Bar.png' }))),
    preview_({}, el('BUTTON', { 'aria-label': 'アップロードした画像をライトボックスに表示' }, el('IMG', { alt: '' }))),
    preview_({}, el('BUTTON', {}, el('IMG', { alt: '' }))),
    preview_({}, el('BUTTON', {}, el('IMG', { alt: '' })))))), ['Bar.png.meta', 'Bar.png', 'image.png', '画像'], 'ファイルは aria-label の完全な名前、画像は添付時に控えた名前を順に当て、足りなければ「画像」とする');
  assert.deepEqual(copy(vm.runInContext('attachments', context)(el('USER-QUERY', {}, preview_({}, el('IMG', {}))))), ['画像'], '控えた名前は送信ごとに使い切り、次の質問に持ち越さない');
  assert.deepEqual(copy(vm.runInContext('attachments', context)(undefined)), [], '質問が描画されなければ添付なし');
  let previewListener;
  const posted = [];
  const injected = '<script data-bard-client-injected="true">(function(){ window.__initial_auth_token = "secret"; })()</script>\n'
    + '<script ws-interception-config="{&quot;parentOrigin&quot;:&quot;https://gemini.google.com&quot;}" data-bard-client-injected="true">document.querySelectorAll("[data-bard-client-injected]")</script>\n';
  // 読み込み役 (https:) と遷移後の blob: フレームは同じオリジンなので sessionStorage を共有する
  let previewStorage = {};
  const preview = (protocol, { dom = '<html></html>', title = 'x', window = {} } = {}) => {
    class NativeBlob { constructor(parts) { this.parts = parts; } }
    vm.runInNewContext(fs.readFileSync('preview.js', 'utf8'), {
      window, Blob: NativeBlob, TextDecoder,
      sessionStorage: { getItem: (key) => previewStorage[key] ?? null, setItem: (key, value) => { previewStorage[key] = value; } },
      location: { protocol, href: protocol + 'preview' },
      document: { title, documentElement: { outerHTML: dom } },
      addEventListener: (type, fn) => { previewListener = fn; },
    });
    return window;
  };
  const ask = async (origin) => {
    await previewListener({ origin, data: { type: 'morn-gemini-relay:get-canvas', id: 'req' }, source: { postMessage: (msg) => posted.push(msg) } });
  };
  const page = '<!DOCTYPE html><html><head>' + injected + '<title>x</title></head><body><canvas></canvas></body></html>';
  const clean = '<!DOCTYPE html><html><head><title>x</title></head><body><canvas></canvas></body></html>';
  const loader = preview('https:');
  await ask('https://gemini.google.com');
  assert.equal(posted.length, 0, 'HTML を持たない読み込み役のフレームは答えない');
  const blob = new loader.Blob([new TextEncoder().encode(page)], { type: 'text/html' });
  assert.equal(blob.parts.length, 1, 'Blob の作成は本来どおり行う');
  new loader.Blob(['console.log(1)']);
  preview('blob:', { dom: '<html><head><title>x</title></head><body>描画後</body></html>' });
  await ask('https://evil.example');
  assert.equal(posted.length, 0, 'Gemini 以外からの問い合わせには答えない');
  await ask('https://gemini.google.com');
  assert.deepEqual(copy(posted), [{ type: 'morn-gemini-relay:canvas', id: 'req', html: clean, error: '', source: 'blob', url: 'blob:preview' }], '遷移前に Blob にされた元の HTML を、差し込みを除いて返す (HTML 以外の Blob では上書きしない)');
  posted.length = 0;
  preview('blob:', { title: '別の Canvas', dom: '<html>' + injected + '<body>描画後</body></html>' });
  await ask('https://gemini.google.com');
  assert.deepEqual(copy(posted), [{ type: 'morn-gemini-relay:canvas', id: 'req', html: '<!DOCTYPE html>\n<html><body>描画後</body></html>', error: '', source: 'dom', url: 'blob:preview' }], 'タイトルの合わない控えは使わず、表示中の DOM で代用する');
  posted.length = 0;
  previewStorage = {};
  preview('blob:', { dom: '<html><head><script data-bard-client-injected="true">window.__initial_auth_token = "secret";' });
  await ask('https://gemini.google.com');
  assert.deepEqual(copy(posted[0]), { type: 'morn-gemini-relay:canvas', id: 'req', html: '', error: '差し込みスクリプトを除去できませんでした', source: 'dom', url: 'blob:preview' }, '差し込みを取り切れない HTML は渡さず、理由を返す');
  posted.length = 0;
  const token = 'ya29.token-value-123';
  preview('blob:', { dom: '<html><body data-note="' + token + '">', window: { __initial_auth_token: token, __firebase_config: '{"apiKey":"AIzaKEY12345"}' } });
  await ask('https://gemini.google.com');
  assert.equal(posted[0].error, '認証情報が残っていたため送りませんでした', 'トークンの値が残っていれば渡さない');
  posted.length = 0;
  preview('blob:', { dom: page.replace('<title>', '<title>data-bard-client-injected を説明する '), window: { __initial_auth_token: token } });
  await ask('https://gemini.google.com');
  assert.equal(posted[0].error, '', '目印の文字列が本文に残るだけなら送る');
  document.querySelectorAll = (selector) => selector === 'model-response' ? [{ querySelector: (selector) => selector === 'message-content' ? el('MESSAGE-CONTENT', {}, t(now < 1000 ? '途中' : '回答')) : null }] : [];
  document.querySelector = () => stopping ? {} : null;
  now = 0;
  tick = (time) => { stopping = time < 2000; };
  await vm.runInContext('relayAnswer("abc", 0)', context);
  assert.deepEqual(copy(relayed), [{ type: 'answer', conversation: 'abc', text: '回答', files: [] }], '生成完了後の回答を 1 回だけ転送する');
  assert.ok(now >= 3200, '停止ボタンが消えてから 1.5 秒待つ');
  relayed.length = 0;
  now = 0;
  stopping = true;
  document.querySelectorAll = (selector) => selector === 'model-response' ? [{ querySelector: (selector) => selector === 'message-content' ? el('MESSAGE-CONTENT', {}, t('完成した回答')) : {} }] : [];
  await vm.runInContext('relayAnswer("abc", 0)', context);
  assert.deepEqual(copy(relayed).map((msg) => msg.text), ['完成した回答']);
  assert.equal(now, 2000, '完了表示があれば停止ボタンが消えた時点で送る。生成中は完了表示があっても送らない');
  // Canvas は本文の後から生成が終わり、プレビューが HTML を返すようになってから送る
  relayed.length = 0;
  // ページ側の canvas-bridge.js と content.js を同じ document でつなぐ
  const domListeners = {};
  Object.assign(document, {
    addEventListener: (type, fn) => (domListeners[type] ||= new Set()).add(fn),
    removeEventListener: (type, fn) => domListeners[type]?.delete(fn),
    dispatchEvent: (event) => { for (const fn of [...(domListeners[event.type] || [])]) fn(event); },
  });
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  Object.assign(context, { CustomEvent, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, crypto: { randomUUID: () => 'id' + now } });
  let asked = 0, bridgeMessage;
  const previewWindow = { length: 0, postMessage: (msg) => {
    asked++;
    if (now < 5000) return; // 生成中は HTML を持つフレームがなく、誰も答えない
    bridgeMessage({ data: { type: 'morn-gemini-relay:canvas', id: msg.id, html: '<html>全文</html>', error: '' } });
  } };
  vm.runInNewContext(fs.readFileSync('canvas-bridge.js', 'utf8'), { document, CustomEvent, addEventListener: (type, fn) => { bridgeMessage = fn; } });
  const chip = { querySelector: () => ({ contentWindow: previewWindow }) };
  document.querySelectorAll = (selector) => selector === 'model-response' ? [{}, { querySelectorAll: () => now < 1000 ? [] : [chip] }] : [];
  now = 0;
  tick = () => {};
  await vm.runInContext('relayCanvas("abc")', context);
  assert.deepEqual(copy(relayed), [{ type: 'canvas', conversation: 'abc', files: [{ name: 'canvas-1.html', content: '<html>全文</html>' }] }], 'Canvas の生成完了後に全文を 1 回だけ送る');
  assert.ok(now >= 5000 && asked > 1, '本文の完了後に現れた Canvas も、HTML が返るまで問い合わせ続ける');
  // 読み込み中のフレームは最初の問い合わせを捨てるので、問い合わせ直して読み込み終わりを拾う
  let reask;
  context.setInterval = (fn) => { reask = fn; return 1; };
  now = 1000;
  asked = 0;
  const loading = vm.runInContext('canvasHtml(1, 0, 15000)', context);
  now = 6000;
  reask();
  assert.equal((await loading).html, '<html>全文</html>', '最初の問い合わせに答えがなくても、問い合わせ直して HTML を受け取る');
  assert.equal(asked, 2);
  // 最新の回答には Canvas がなく、以前の回答の iframe だけが更新される実際の配置。
  relayed.length = 0;
  context.location.pathname = '/app/updates';
  document.querySelector = () => null;
  document.querySelectorAll = (selector) => selector === 'model-response' ? [{ querySelectorAll: () => [chip] }, { querySelectorAll: () => [] }] : [];
  const originalPost = previewWindow.postMessage;
  let updatedHtml = '<html>初版</html>';
  previewWindow.postMessage = (msg) => bridgeMessage({ data: { type: 'morn-gemini-relay:canvas', id: msg.id, html: updatedHtml } });
  now = 0;
  tick = (time) => {
    updatedHtml = time < 4000 ? '<html>初版</html>' : time < 4500 ? '<html>生成途中</html>' : '<html>更新版</html>';
    if (time >= 10000) context.location.pathname = '/app/elsewhere';
  };
  await vm.runInContext('relayCanvas("updates")', context);
  assert.deepEqual(copy(relayed).map((msg) => msg.files[0].content), ['<html>初版</html>', '<html>更新版</html>'], '以前の Canvas の変更を再添付し、同じ内容と生成途中の内容は添付しない');
  assert.ok(now < 11000, '会話を移動したら監視を終了する');
  relayed.length = 0;
  context.location.pathname = '/app/updates';
  now = 0;
  tick = (time) => { if (time >= 4000) context.location.pathname = '/app/elsewhere'; };
  await vm.runInContext('relayCanvas("updates")', context);
  assert.equal(relayed.length, 0, '回答ごとに監視を再開しても、送信済みの同じ HTML は再添付しない');
  now = 0;
  context.location.pathname = '/app/updates';
  previewWindow.postMessage = (msg) => {
    context.location.pathname = '/app/elsewhere';
    bridgeMessage({ data: { type: 'morn-gemini-relay:canvas', id: msg.id, html: '<html>別の更新</html>' } });
  };
  await vm.runInContext('relayCanvas("updates")', context);
  assert.equal(relayed.length, 0, '問い合わせ中に会話が変わっても送信しない');
  context.location.pathname = '/app/rendered';
  now = 0;
  tick = (time) => { if (time >= 14000) context.location.pathname = '/app/elsewhere'; };
  previewWindow.postMessage = (msg) => bridgeMessage({ data: {
    type: 'morn-gemini-relay:canvas', id: msg.id, source: 'dom',
    url: now < 9000 ? 'blob:version-1' : 'blob:version-2',
    html: now < 4000 ? '<html>score:0</html>' : now < 9000 ? '<html>score:1</html>' : '<html>新しいコード</html>',
  } });
  await vm.runInContext('relayCanvas("rendered")', context);
  assert.deepEqual(copy(relayed).map((msg) => msg.files[0].content), ['<html>score:0</html>', '<html>新しいコード</html>'], 'DOM 代用時はゲーム内のスコア更新を無視し、プレビューの再生成時だけ再添付する');
  previewWindow.postMessage = originalPost;
  // Chrome で確認した自動修正ボタンは入力欄を空にしたまま新しい回答を追加する。
  relayed.length = 0;
  context.location.pathname = '/app/abc';
  const repairResponse = {
    querySelector: () => el('MESSAGE-CONTENT', {}, t('エラーの原因を修正します。')),
    querySelectorAll: () => [chip],
  };
  let repairResponses = [{}, {}];
  document.querySelectorAll = (selector) => selector === 'model-response' ? repairResponses : [];
  document.querySelector = () => null;
  now = 6000;
  tick = () => { repairResponses = [{}, {}, repairResponse]; };
  await domHandlers.click({ target: { closest: (selector) => selector === 'button[data-test-id="fix-errors-button"]' ? {} : null } });
  assert.deepEqual(copy(relayed), [
    { type: 'answer', conversation: 'abc', text: 'エラーの原因を修正します。', files: [] },
    { type: 'canvas', conversation: 'abc', files: [{ name: 'canvas-1.html', content: '<html>全文</html>' }] },
  ], '自動修正ボタンから回答と修正後の Canvas を送り、空の質問は送らない');
  relayed.length = 0;
  await domHandlers.click({ target: { closest: () => null } });
  assert.equal(relayed.length, 0, '他のボタンでは転送を開始しない');
  const historyResponses = ['最初の回答', '自動修正の回答'].map((text) => el('MODEL-RESPONSE', {}, el('MESSAGE-CONTENT', {}, t(text))));
  const historyQueries = ['質問', ''].map((text, i) => {
    const query = el('USER-QUERY', {}, ...(text ? [el('DIV', { className: 'query-text' }, t(text))] : []));
    query.closest = () => ({ querySelector: () => historyResponses[i] });
    return query;
  });
  document.querySelectorAll = (selector) => selector === 'user-query' ? historyQueries : selector === 'model-response' ? historyResponses : [];
  document.querySelector = (selector) => selector === 'user-query' ? historyQueries[0] : null;
  tick = () => {};
  await vm.runInContext('sendConversation()', context);
  assert.deepEqual(copy(relayed).map(({ type, text }) => ({ type, text })), [
    { type: 'prompt', text: '質問' }, { type: 'answer', text: '最初の回答' }, { type: 'answer', text: '自動修正の回答' },
  ], '過去チャット送信でも自動修正の回答を残し、空の質問は投稿しない');
  // IME 確定の Enter と送信の Enter が続いても、質問は 1 回だけ送る
  relayed.length = 0;
  const editor = { innerText: '確定前', closest: () => editor };
  document.querySelector = (selector) => selector === '.ql-editor' ? editor : null;
  document.querySelectorAll = () => [];
  context.location.pathname = '/app/abc';
  now = 0;
  let second;
  tick = (time) => {
    if (time >= 300 && time < 1800) editor.innerText = '確定後';
    // 1 回目の検知期限 (1500ms) の直前に 2 回目の Enter を押し、期限を過ぎてから入力欄が空になる
    if (time >= 1350 && !second) second = vm.runInContext('relay()', context).catch(() => {});
    if (time >= 1800) editor.innerText = '';
  };
  await vm.runInContext('relay()', context).catch(() => {});
  await second;
  assert.deepEqual(copy(relayed.filter((msg) => msg.type === 'prompt')).map((msg) => msg.text), ['確定後'], '二重に押しても 1 回だけ、確定後の文字で送る。検知中の押下は期限を延ばし、取りこぼさない');
  for (const mode of ['受理が遅い', '入力欄を交換', '質問数が増えない']) {
    relayed.length = 0;
    now = 0;
    context.location.pathname = '/app/abc';
    const oldEditor = { innerText: '追加の質問' };
    let currentEditor = oldEditor, accepted = false;
    const oldQuery = el('USER-QUERY', {}, t('前の質問'));
    const acceptedQuery = el('USER-QUERY', {}, t('追加の質問'));
    const response = el('MODEL-RESPONSE', {}, el('MESSAGE-CONTENT', {}, t('追加の回答')));
    const responseQuery = response.querySelector;
    response.querySelector = (selector) => selector === '.response-footer.complete' ? {} : responseQuery(selector);
    document.querySelector = (selector) => selector === '.ql-editor' ? currentEditor : null;
    document.querySelectorAll = (selector) => selector === 'user-query'
      ? accepted ? mode === '質問数が増えない' ? [acceptedQuery] : [oldQuery, acceptedQuery] : [oldQuery]
      : selector === 'model-response' && accepted ? [response] : [];
    const delay = mode === '受理が遅い' ? 4000 : 300;
    let postedAt;
    context.chrome.runtime.sendMessage = async (msg) => { relayed.push(msg); if (msg.type === 'prompt') postedAt = now; return {}; };
    tick = (time) => {
      if (time >= delay && !accepted) {
        accepted = true;
        if (mode === '入力欄を交換') currentEditor = { innerText: '' };
        else if (mode !== '質問数が増えない') currentEditor.innerText = '';
      }
      if (time >= delay + 1000) context.location.pathname = '/app/elsewhere';
    };
    const transfer = vm.runInContext('relay()', context);
    await domHandlers.click({ target: { closest: (selector) => selector.includes('送信') ? {} : null } });
    await transfer;
    assert.deepEqual(copy(relayed).map(({ type, text }) => ({ type, text })), [
      { type: 'prompt', text: '追加の質問' }, { type: 'answer', text: '追加の回答' },
    ], `${mode}でも質問と回答を重複なく送る`);
    assert.ok(postedAt <= delay + 150, `${mode}でも質問の描画から 150ms 以内に転送を開始する`);
    if (mode === '入力欄を交換') assert.equal(oldEditor.innerText, '追加の質問', '切り離された旧入力欄は空にならなくてもよい');
  }
  relayed.length = 0;
  now = 0;
  context.location.pathname = '/app/abc';
  const fastEditor = { innerText: '本文はすぐ送る' };
  const lateQuery = el('USER-QUERY', {}, el('DIV', { className: 'query-text' }, t('本文はすぐ送る')),
    el('USER-QUERY-FILE-PREVIEW', {}, el('BUTTON', { 'aria-label': '資料.pdf' }), el('DIV', { className: 'filename-label' }, t('資料.pdf'))));
  const fastResponse = el('MODEL-RESPONSE', {}, el('MESSAGE-CONTENT', {}, t('回答も先に送る')));
  const fastQuerySelector = fastResponse.querySelector;
  fastResponse.querySelector = (selector) => selector === '.response-footer.complete' ? {} : fastQuerySelector(selector);
  document.querySelector = (selector) => selector === '.ql-editor' ? fastEditor : null;
  document.querySelectorAll = (selector) => selector === 'user-query' && now >= 5000 ? [lateQuery]
    : selector === 'model-response' && now >= 1000 ? [fastResponse] : [];
  const timings = [];
  context.chrome.runtime.sendMessage = async (msg) => { relayed.push(msg); timings.push({ type: msg.type, at: now }); return {}; };
  tick = (time) => {
    if (time >= 150) fastEditor.innerText = '';
    if (time >= 8000) context.location.pathname = '/app/elsewhere';
  };
  await vm.runInContext('relay()', context);
  assert.deepEqual(copy(relayed).map((msg) => msg.type), ['prompt', 'answer', 'attachments'], '本文・回答は添付名の描画を待たず、添付名だけ後から送る');
  assert.equal(timings[0].at, 150, '質問の描画が 5 秒遅れても、受理後最初の確認 (150ms) で本文を送る');
  assert.ok(timings[1].at < 5000, '添付名が出る前に回答も転送できる');
  assert.deepEqual(copy(relayed[2].attachments), ['資料.pdf'], '遅れて表示された添付名も失わない');
  console.log('PASS: 質問本文の即時転送・添付名の後追い通知・Canvas 問い合わせの再試行・送信順の保証・全チャット取得・チャット送信 (新しいスレッド)・二重送信の防止・Slack スレッド転送・コード投稿・Canvas 全文の後追い送信・mrkdwn 変換・回答検知・転送・永続保存の廃止・専用タブ・保存の成功/失敗・重複質問・遅延一覧・待機時間 (静止時 800ms)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
