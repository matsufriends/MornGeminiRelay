// Gemini の送信操作 (Enter / 送信ボタン) を捕まえ、入力欄のテキストを background へ渡す
const SEND_BTN = 'button[aria-label*="送信"], button[aria-label*="Send" i]';

// 右上アバターの aria-label「Google アカウント: 名前 (メール)」から取る
function account() {
  const label = document.querySelector('a[aria-label^="Google アカウント"], a[aria-label^="Google Account"]')?.getAttribute('aria-label') || '';
  return label.split(/[:：]/).slice(1).join(':').replace(/\s+/g, ' ').replace(/,.*$/, '').trim();
}

// 新規チャットは送信後に URL が /app/<id> へ変わるので、それを待って会話 ID (= Slack スレッドの単位) にする
async function conversationId() {
  for (let i = 0; i < 100; i++) {
    const id = location.pathname.match(/\/app\/([^/]+)$/)?.[1];
    if (id) return id;
    await sleep(100);
  }
  throw new Error('会話 ID を取得できませんでした');
}

// 送信前に添付された画像のファイル名。画像は送信後の表示にファイル名が残らないため、選択・ドロップ・貼り付けの時点で控える。
// ponytail: 送信前に画像を外すと以降の名前が 1 つずれる。問題になったら入力欄のプレビューと突き合わせる。
let pickedImages = [];
const pickImages = (files) => { for (const file of files || []) if (file.type.startsWith('image/')) pickedImages.push(file.name); };
document.addEventListener('change', (e) => { if (e.target.type === 'file') pickImages(e.target.files); }, true);
document.addEventListener('drop', (e) => pickImages(e.dataTransfer?.files), true);
document.addEventListener('paste', (e) => pickImages(e.clipboardData?.files), true);

// 送信済みの質問に付いた添付の名前。中身は送らず、添付があったことだけを知らせる。
// ファイルは表示名が省略される (Bar.png.meta → Bar.png) ので、完全な名前が入るボタンの aria-label を使う。
// 画像は表示名がなくボタンのラベルも「…ライトボックスに表示」という操作名なので、控えた名前を添付順に当てる。
function attachments(query) {
  const names = [...(query?.querySelectorAll('user-query-file-preview') || [])].map((preview) => preview.querySelector('.filename-label')
    ? preview.querySelector('button')?.getAttribute('aria-label')?.trim() || preview.querySelector('.filename-label').innerText.trim()
    : pickedImages.shift() || '画像');
  pickedImages = [];
  return names;
}

const STOP_BTN ='button[aria-label*="停止"], button[aria-label*="Stop" i]';
const lastResponse = () => {
  const responses = document.querySelectorAll('model-response');
  const last = responses[responses.length - 1];
  return last?.querySelector('message-content') || last;
};

const EXT = { javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh', csharp: 'cs', 'c#': 'cs', markdown: 'md', yaml: 'yml' };
// Slack は日本語に隣接した *太字* を解釈しないので、ゼロ幅スペースで区切る
const wrap = (mark, text) => text.trim() ? `​${mark}${text.trim()}${mark}​` : '';

// 回答の DOM を Slack mrkdwn に変換する。コードブロックは本文から外し、添付ファイルとして返す。
function toMrkdwn(root) {
  const files = [];
  const addFile = (content, lang) => {
    if (!content.trim()) return '';
    lang = lang.trim().toLowerCase();
    const name = `code-${files.length + 1}.${EXT[lang] || lang.replace(/\W/g, '') || 'txt'}`;
    files.push({ name, content });
    return `\n📎 ${name}\n`;
  };
  const walk = (node, depth) => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    // Canvas のエディタは見えている行しか DOM にないので本文には入れず、全文は relayCanvas が別に送る
    if (node.nodeType !== 1 || /^(BUTTON|MAT-ICON|SVG|STYLE|SCRIPT|XAP-CODE-EDITOR)$/.test(node.tagName)) return '';
    const inner = () => [...node.childNodes].map((child) => walk(child, depth)).join('');
    switch (node.tagName) {
      case 'CODE-BLOCK':
      case 'PRE': {
        const code = node.querySelector('code') || node;
        const lang = code.className.match(/language-([\w#+-]+)/)?.[1] || node.querySelector('.code-block-decoration')?.innerText.split('\n')[0] || '';
        return addFile(code.innerText.replace(/\n$/, ''), lang);
      }
      case 'P': return `\n${inner().trim()}\n\n`;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return `\n${wrap('*', inner())}\n`;
      case 'STRONG': case 'B': return wrap('*', inner());
      case 'EM': case 'I': return wrap('_', inner());
      case 'S': case 'DEL': return wrap('~', inner());
      case 'CODE': return `\`${node.textContent}\``;
      case 'BR': return '\n';
      case 'HR': return '\n———\n';
      case 'A': return node.href && !inner().includes(node.href) ? `${inner()} (${node.href})` : inner();
      case 'UL':
      case 'OL': {
        const start = Number(node.getAttribute('start')) || 1;
        return '\n' + [...node.children].filter((child) => child.tagName === 'LI').map((li, i) => {
          const marker = node.tagName === 'OL' ? `${start + i}. ` : depth ? '◦ ' : '• ';
          const body = [...li.childNodes].map((child) => walk(child, depth + 1)).join('').replace(/\n\s*\n/g, '\n').trim();
          return '    '.repeat(depth) + marker + body;
        }).join('\n') + '\n\n';
      }
      case 'TABLE': return '\n' + [...node.querySelectorAll('tr')].map((tr) => [...tr.children].map((cell) => walk(cell, depth).trim()).join(' | ')).join('\n') + '\n\n';
      default: return inner();
    }
  };
  // 入れ子リストの字下げだけ残し、それ以外の行頭・行末の空白は消す
  const text = walk(root, 0).split('\n').map((line) => /^ +[•◦\d]/.test(line) ? line.trimEnd() : line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, files };
}

// Canvas のプレビューに HTML を問い合わせる。実際の問い合わせはページ側の canvas-bridge.js が行い、返事を DOM イベントで返す。
// HTML を持つフレームだけが答えるので、timeoutMs 以内に返事がなければ null (まだ生成中・読み込み中)。
// 読み込み中のフレームは問い合わせを捨てるので、読み込み終わりを逃さないよう 300ms ごとに問い合わせ直す。
function canvasHtml(response, chip, timeoutMs) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (html) => { document.removeEventListener('morn-gemini-relay:canvas', onReply); clearInterval(timer); clearTimeout(timeout); resolve(html); };
    const onReply = (event) => {
      const reply = JSON.parse(event.detail);
      if (reply.id !== id) return;
      if (reply.error) console.warn(`MornGeminiRelay: Canvas のコードを送れません: ${reply.error}`);
      done(reply.html);
    };
    document.addEventListener('morn-gemini-relay:canvas', onReply);
    const ask = () => document.dispatchEvent(new CustomEvent('morn-gemini-relay:ask-canvas', { detail: JSON.stringify({ id, response, chip }) }));
    const timer = setInterval(ask, 300);
    const timeout = setTimeout(() => done(null), timeoutMs);
    ask();
  });
}

// 新しい回答が現れ、停止ボタンが消えて本文が 1.5 秒変わらなくなったら完了とみなす
async function relayAnswer(conversation, before) {
  await waitFor(() => document.querySelectorAll('model-response').length > before, '回答が見つかりません');
  let previous = '', changed = Date.now();
  for (const end = Date.now() + 600000; Date.now() < end; await sleep(300)) {
    const current = lastResponse()?.innerText.trim() || '';
    if (current !== previous || document.querySelector(STOP_BTN)) { previous = current; changed = Date.now(); }
    if (current && Date.now() - changed >= 1500) return request({ type: 'answer', conversation, ...toMrkdwn(lastResponse()) });
  }
  throw new Error('回答の生成が完了しませんでした');
}

// Canvas は本文の完了後も生成が続き、終わってからプレビューに HTML が載る。
// そこで本文とは別に回答を見張り、プレビューが HTML を返したらスレッドに追加で投稿する。
// Angular が要素を作り直しても追えるよう、回答もチップも毎回 index で探し直す。
async function relayCanvas(conversation, index) {
  const chips = () => document.querySelectorAll('model-response')[index]?.querySelectorAll('immersive-entry-chip') || [];
  const finished = new Set();
  // HTML を持っていれば返事はすぐ来るので、短い間隔で見張り、生成完了から投稿までの遅れを 1 秒未満にする
  for (const end = Date.now() + 600000; Date.now() < end; await sleep(500)) {
    for (let i = 0; i < chips().length; i++) {
      if (finished.has(i)) continue;
      const html = await canvasHtml(index, i, 300);
      if (html === null) continue;
      finished.add(i); // 送れない理由があった ('' ) 場合も再試行しない
      if (html) await request({ type: 'canvas', conversation, files: [{ name: `canvas-${i + 1}.html`, content: html }] });
    }
    if (chips().length && finished.size === chips().length) return;
  }
  if (chips().length) console.warn('MornGeminiRelay: Canvas のコードを 10 分以内に取得できませんでした');
}

// Enter は IME 確定でも飛ぶので、押下時のテキストを控えて「入力欄が空になった = Gemini が受理した」ときだけ送る。
// IME 確定の Enter → 送信の Enter や、Enter と送信ボタンが続くと検知が並走して二重送信になるので、
// 検知中の押下は新たに検知せず、検知の期限を延ばすだけにする。
let detectUntil = 0;
async function relay() {
  const editor = document.querySelector('.ql-editor');
  let text = editor?.innerText.trim();
  if (!text) return;
  const detecting = Date.now() < detectUntil;
  detectUntil = Date.now() + 1500;
  if (detecting) return;
  const before = document.querySelectorAll('model-response').length;
  const queries = document.querySelectorAll('user-query').length;
  let sent = false;
  while (!sent && Date.now() < detectUntil) {
    await sleep(150);
    sent = !editor.innerText.trim();
    // 検知中に IME で確定した文字も含めるよう、空になる直前の内容を控え直す
    if (!sent) text = editor.innerText.trim();
  }
  detectUntil = 0;
  if (!sent) return;
  const conversation = await conversationId();
  // 添付は送信後の質問に表示されるので、新しい質問が描画されるのを待って読む (出なければ添付なし扱い)
  await waitFor(() => document.querySelectorAll('user-query').length > queries, '').catch(() => {});
  const query = document.querySelectorAll('user-query')[queries];
  await request({ type: 'prompt', conversation, text, account: account(), attachments: attachments(query) });
  await relayAnswer(conversation, before);
  return relayCanvas(conversation, before);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest('.ql-editor')) relay().catch(console.error);
}, true);

document.addEventListener('mousedown', (e) => {
  if (e.target.closest(SEND_BTN)) relay().catch(console.error);
}, true);

// ---- Gemini を開いて直接 Markdown に保存 ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

const visible = (element) => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
const LOADING = '[aria-busy="true"], [role="progressbar"], mat-progress-spinner';
const loading = (root) => (root.matches?.(LOADING) && visible(root)) || [...root.querySelectorAll(LOADING)].some(visible);

async function waitFor(condition, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (condition()) return;
    await sleep(100);
  }
  throw new Error(message);
}

// ponytail: DOM の静止 800ms を読み込み完了の目安にする。明示的な完了表示が得られたら置き換える。
async function settle(read, advance, root) {
  let previous = read(), changed = Date.now();
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    advance();
    await sleep(100);
    const current = read();
    if (current !== previous || loading(root)) { previous = current; changed = Date.now(); }
    if (Date.now() - changed >= 800) return;
  }
  throw new Error('読み込みが完了しませんでした。保存を停止しました');
}

// 質問ブロックの本文 (画面読み上げ用の「あなたのプロンプト」などは含めない)
function queryText(query) {
  const lines = [...query.querySelectorAll('.query-text-line')];
  return (lines.length ? lines.map((line) => line.innerText).join('\n') : query.innerText).trim();
}

function scrapeQueries() {
  return [...document.querySelectorAll('user-query .query-text')].filter(visible).map(queryText).filter(Boolean);
}

async function collectConversations() {
  const selector = '[data-test-id="conversation"] a';
  const toggle = [...document.querySelectorAll('button')].find((button) => /サイドバーを開く|open sidebar|メインメニュー|main menu/i.test(button.getAttribute('aria-label') || ''));
  toggle?.click();
  await waitFor(() => document.querySelector(selector), '会話が見つかりません。Gemini のログイン状態と会話一覧を確認してください');
  const first = document.querySelector(selector);
  let scroller = first.parentElement;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const conversations = new Map();
  await settle(() => {
    for (const link of document.querySelectorAll(selector)) conversations.set(link.href, { href: link.href, title: link.innerText.trim() });
    return [...conversations.keys()].join('\n');
  }, () => { if (scroller) scroller.scrollTop = scroller.scrollHeight; }, scroller || document);
  return [...conversations.values()];
}

// 開いている会話を最初から読み、リアルタイム転送と同じ形式 (質問 → 回答 → Canvas) で Slack の新しいスレッドへ送る。
// Slack の投稿レートは background が 429 を見て待つので、ここでは間を空けない。
// 送信順は background の順番待ちが守るので、投稿の完了を待たずに次のやり取りを読み進め、最後にまとめて結果を待つ。
async function sendConversation() {
  const posts = [];
  let failure;
  const post = (message) => {
    if (failure) throw failure;
    posts.push(request(message).catch((error) => { failure ??= error; }));
  };
  await waitFor(() => document.querySelector('user-query'), '質問が見つからないため送信を停止しました');
  const scroller = document.querySelector('infinite-scroller');
  await settle(() => String(document.querySelectorAll('user-query').length), () => { if (scroller) scroller.scrollTop = 0; }, scroller || document);
  const conversation = await conversationId();
  const queries = [...document.querySelectorAll('user-query')];
  for (const [i, query] of queries.entries()) {
    // Gemini は画面外のやり取りの中身を描画しないので、見える位置へ動かし、質問と回答が描画されるまで (最大 3 秒) 待つ
    query.scrollIntoView?.({ block: 'center' });
    const response = query.closest('.conversation-container')?.querySelector('model-response');
    const answerRoot = () => response?.querySelector('message-content') || response;
    for (let t = 0; t < 30 && !(queryText(query.querySelector('.query-text') || query) && (!response || answerRoot().innerText.trim())); t++) await sleep(100);
    post({ type: 'prompt', conversation, text: queryText(query.querySelector('.query-text') || query), account: account(), attachments: attachments(query), newThread: i === 0 });
    if (!response) continue;
    post({ type: 'answer', conversation, ...toMrkdwn(answerRoot()) });
    const index = [...document.querySelectorAll('model-response')].indexOf(response);
    for (const [c, chip] of [...response.querySelectorAll('immersive-entry-chip')].entries()) {
      // 画面外の Canvas はプレビューが読み込まれないことがあるので、見える位置へ動かしてから問い合わせる
      chip.scrollIntoView?.({ block: 'center' });
      const html = await canvasHtml(index, c, 15000);
      if (!html) continue;
      post({ type: 'canvas', conversation, files: [{ name: `canvas-${c + 1}.html`, content: html }] });
    }
  }
  await Promise.all(posts);
  if (failure) throw failure;
}

async function exportCurrentPage() {
  const job = await request({ type: 'getExportJob' });
  if (!job || job.done || job.error) return;
  let response;
  if (job.queue === null) {
    response = await request({ type: 'exportQueue', queue: await collectConversations() });
  } else if (job.mode === 'send') {
    if (new URL(job.queue[0].href).pathname !== location.pathname) throw new Error('送信中にページが変わりました。もう一度開始してください');
    await sendConversation();
    response = await request({ type: 'exportSent' });
  } else {
    if (new URL(job.queue[0].href).pathname !== location.pathname) throw new Error('保存中にページが変わりました。もう一度開始してください');
    await waitFor(() => scrapeQueries().length, '質問本文が見つからないため保存を停止しました');
    const scroller = document.querySelector('infinite-scroller');
    await settle(() => JSON.stringify(scrapeQueries()), () => { if (scroller) scroller.scrollTop = 0; }, scroller || document);
    response = await request({ type: 'exportConversation', texts: scrapeQueries() });
  }
  // フルロードで前の会話の非表示 DOM を残さず、作業専用タブだけを進める。
  if (response.next) location.href = response.next;
}

exportCurrentPage().catch(async (error) => {
  console.error(error);
  await request({ type: 'exportError', error: error.message }).catch(console.error);
});
