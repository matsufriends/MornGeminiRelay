// node test.js — 実際のメッセージハンドラーと取得処理を、通信・ダウンロードなしで確認する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

(async () => {
  const local = { slackToken: 'xoxb-test', slackChannel: 'C1', webhook: 'https://discord.com/api/webhooks/example', history: [{ text: '旧履歴' }], importQueue: ['old'], importTotal: 1 };
  const session = {}, downloads = [], tabs = [], sent = [];
  let listener, onRemoved, state = 'complete', nextId = 1;
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
    },
    downloads: {
      download: async (options) => { downloads.push(options); return downloads.length; },
      search: async () => [{ state, error: state === 'interrupted' ? 'DISK_FULL' : undefined }],
    },
  };
  const fetch = async (url, options) => {
    sent.push({ url, ...options, body: Object.fromEntries(options.body) });
    return { json: async () => ({ ok: true, ts: 'ts' + sent.length }) };
  };
  vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), { chrome, URL, URLSearchParams, setTimeout, fetch });
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
  assert.equal(sent[0].body.text, '*test account*\n新しい質問 &lt;!channel&gt;', 'メンションなどの Slack 記法を無効化する');
  assert.equal(sent[1].body.text, '*Gemini*\n回答 &amp; 補足');
  assert.ok((await message({ type: 'prompt', conversation: '../x', text: 'x' })).error);
  assert.equal(JSON.stringify(local).includes('新しい質問'), false, 'Slack 転送で本文を蓄積しない');
  sent.length = 0;
  const long = Array.from({ length: 4000 }, (_, i) => `line ${i} <p>`).join('\n');
  await message({ type: 'answer', conversation: 'abc', text: '📎 code-1.html', files: [{ name: 'code-1.html', content: long }] });
  assert.ok(sent.length > 2, '長いコードは複数の投稿に分ける');
  assert.ok(sent.every(({ url, body }) => url.endsWith('chat.postMessage') && body.thread_ts === 'ts1' && body.text.length <= 40000), 'コードはファイル添付せず同じスレッドへ投稿する');
  assert.match(sent[1].body.text, /^📎 code-1.html\n```\nline 0 &lt;p&gt;\n/);
  assert.equal(sent.slice(1).map(({ body }) => body.text.split('\n').slice(2, -1).join('\n')).join('\n'), long.replace(/</g, '&lt;').replace(/>/g, '&gt;'), '分割してもコードを欠落させない');
  assert.ok((await message({ type: 'answer', conversation: 'abc', text: 'x', files: [{ name: '../x', content: 'x' }] })).error);
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

  let now = 0, tick = () => {}, busy = false, links = [];
  const query = { getClientRects: () => [{}], innerText: 'fallback', querySelectorAll: () => [] };
  const scroller = { parentElement: null, scrollHeight: 10, scrollTop: 0 };
  const document = {
    addEventListener() {},
    dispatchEvent() {},
    querySelector: () => links[0],
    querySelectorAll: (selector) => selector === 'user-query .query-text' ? [query] : selector === '[data-test-id="conversation"] a' ? links : [],
  };
  scroller.querySelectorAll = () => busy ? [query] : [];
  const context = vm.createContext({
    document, location: { pathname: '/app' }, URL, console, CustomEvent: class {},
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
    el('IMMERSIVE-ENTRY-CHIP', { dataset: { mornCode: '<!DOCTYPE html>\n<html></html>', mornLang: 'html' } }, t('Neon Breakout Game コード プレビュー'), el('XAP-CODE-EDITOR', {}, t('見えている行だけ'))),
    el('P', {}, t('以上')));
  assert.deepEqual(copy(vm.runInContext('toMrkdwn', context)(answer)), {
    text: '\u200B*主な仕様*\u200B\n\n1. \u200B*操作性*\u200B:\n    ◦ マウス `A/D`\n2. 見た目\n\n📎 code-1.html\n\n📎 code-2.html\n\n以上',
    files: [{ name: 'code-1.html', content: '<p>\n  x\n</p>' }, { name: 'code-2.html', content: '<!DOCTYPE html>\n<html></html>' }],
  }, '見出し・番号・入れ子の箇条書き・太字・コードを Slack 記法へ変換し、コードブロックと Canvas の全文は別投稿に回す');
  let canvasListener;
  const host = { dataset: {} };
  vm.runInNewContext(fs.readFileSync('canvas.js', 'utf8'), {
    document: { addEventListener: (type, fn) => { if (type === 'morn-gemini-relay:canvas') canvasListener = fn; } },
    window: { monaco: { editor: { getEditors: () => [{ getDomNode: () => ({ closest: () => host }), getModel: () => ({ getValue: () => '全 900 行', getLanguageId: () => 'html' }) }] } } },
  });
  canvasListener();
  assert.deepEqual(host.dataset, { mornCode: '全 900 行', mornLang: 'html' }, 'Canvas のコードは描画範囲ではなく Monaco のモデルから全文を取る');
  let previewListener;
  const posted = [];
  const injected = '<script data-bard-client-injected="true">(function(){ window.__initial_auth_token = "secret"; })()</script>\n';
  let previewUrl;
  const preview = (protocol, html) => {
    previewUrl = { createObjectURL: (blob) => 'blob:' + blob.size };
    vm.runInNewContext(fs.readFileSync('preview.js', 'utf8'), {
      location: { protocol, href: 'blob:https://x.scf.usercontent.goog/1' },
      URL: previewUrl,
      fetch: async () => ({ text: async () => html }),
      addEventListener: (type, fn) => { previewListener = fn; },
    });
  };
  const ask = async (origin) => {
    await previewListener({ origin, data: { type: 'morn-gemini-relay:get-canvas', id: 'req' }, source: { postMessage: (msg) => posted.push(msg) } });
  };
  const page = '<!DOCTYPE html><html><head>' + injected + '<title>x</title></head></html>';
  const stripped = [{ type: 'morn-gemini-relay:canvas', id: 'req', html: '<!DOCTYPE html><html><head><title>x</title></head></html>' }];
  preview('blob:', page);
  await ask('https://evil.example');
  assert.equal(posted.length, 0, 'Gemini 以外からの問い合わせには答えない');
  await ask('https://gemini.google.com');
  assert.deepEqual(copy(posted), stripped, 'blob: フレームは自分を読み直し、認証トークン入りの差し込みを除いた HTML を返す');
  posted.length = 0;
  preview('https:', '');
  await ask('https://gemini.google.com');
  assert.equal(posted.length, 0, 'HTML を持たない scf フレームは答えない');
  assert.equal(previewUrl.createObjectURL({ size: 3, text: async () => page }), 'blob:3', 'blob の作成は本来どおり行う');
  previewUrl.createObjectURL({ size: 1, text: async () => 'console.log(1)' });
  await ask('https://gemini.google.com');
  assert.deepEqual(copy(posted), stripped, 'scf フレームは blob にした HTML を控えて返し、HTML 以外の blob では上書きしない');
  posted.length = 0;
  preview('blob:', '<html><head><script data-bard-client-injected="true">window.__initial_auth_token = "secret";');
  await ask('https://gemini.google.com');
  assert.equal(posted[0].html, '', '差し込みを取り切れない HTML は渡さない');
  document.querySelectorAll = (selector) => selector === 'model-response' ? [{ querySelector: () => el('MESSAGE-CONTENT', {}, t(now < 1000 ? '途中' : '回答')) }] : [];
  document.querySelector = () => stopping ? {} : null;
  now = 0;
  tick = (time) => { stopping = time < 2000; };
  await vm.runInContext('relayAnswer("abc", 0)', context);
  assert.deepEqual(copy(relayed), [{ type: 'answer', conversation: 'abc', text: '回答', files: [] }], '生成完了後の回答を 1 回だけ転送する');
  assert.ok(now >= 3200, '停止ボタンが消えてから 1.5 秒待つ');
  console.log('PASS: Slack スレッド転送・コード投稿・Canvas 全文取得 (コード/プレビュー)・mrkdwn 変換・回答検知・転送・永続保存の廃止・専用タブ・保存の成功/失敗・重複質問・遅延一覧・待機時間 (静止時 800ms)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
