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
  vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), { chrome, URL, setTimeout, fetch: async (url, options) => { sent.push({ url, ...options, body: JSON.parse(options.body) }); return { json: async () => ({ ok: true, ts: 'ts' + sent.length }) }; } });
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
  document.querySelectorAll = (selector) => selector === 'model-response' ? [{ querySelector: () => ({ innerText: now < 1000 ? '途中' : '回答' }) }] : [];
  document.querySelector = () => stopping ? {} : null;
  now = 0;
  tick = (time) => { stopping = time < 2000; };
  await vm.runInContext('relayAnswer("abc", 0)', context);
  assert.deepEqual(copy(relayed), [{ type: 'answer', conversation: 'abc', text: '回答' }], '生成完了後の回答を 1 回だけ転送する');
  assert.ok(now >= 3200, '停止ボタンが消えてから 1.5 秒待つ');
  console.log('PASS: Slack スレッド転送・回答検知・転送・永続保存の廃止・専用タブ・保存の成功/失敗・重複質問・遅延一覧・待機時間 (静止時 800ms)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
