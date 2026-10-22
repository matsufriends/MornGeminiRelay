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
      done(reply);
    };
    document.addEventListener('morn-gemini-relay:canvas', onReply);
    const ask = () => document.dispatchEvent(new CustomEvent('morn-gemini-relay:ask-canvas', { detail: JSON.stringify({ id, response, chip }) }));
    const timer = setInterval(ask, 300);
    const timeout = setTimeout(() => done(null), timeoutMs);
    ask();
  });
}

// Gemini の完了表示で即送信する。表示がない場合は本文の静止 1.5 秒で代用する。
async function relayAnswer(conversation, before) {
  await waitFor(() => document.querySelectorAll('model-response').length > before, '回答が見つかりません');
  let previous = '', changed = Date.now();
  for (const end = Date.now() + 600000; Date.now() < end; await sleep(100)) {
    const response = document.querySelectorAll('model-response')[before];
    const root = response?.querySelector('message-content') || response;
    const current = root?.innerText.trim() || '';
    const generating = document.querySelector(STOP_BTN);
    if (current !== previous || generating) { previous = current; changed = Date.now(); }
    if (current && !generating && (response.querySelector('.response-footer.complete') || Date.now() - changed >= 1500)) return request({ type: 'answer', conversation, ...toMrkdwn(root) });
  }
  throw new Error('回答の生成が完了しませんでした');
}

let canvasWatch = 0;
const sentCanvases = new Map();

// 新しい回答に Canvas が付かず、過去の回答の Canvas が更新される場合もある。
// 回答後の 10 分間、会話内のプレビューを見張り、1.5 秒変わらなかった HTML を変更時だけ添付する。
async function relayCanvas(conversation) {
  const watch = ++canvasWatch, path = location.pathname;
  if (!sentCanvases.has(conversation)) sentCanvases.set(conversation, new Map());
  const sent = sentCanvases.get(conversation), pending = new Map();
  const active = () => watch === canvasWatch && location.pathname === path;
  for (const end = Date.now() + 600000; active() && Date.now() < end; await sleep(500)) {
    const responses = document.querySelectorAll('model-response');
    for (let r = 0; r < responses.length; r++) {
      const chips = responses[r].querySelectorAll?.('immersive-entry-chip') || [];
      for (let i = 0; i < chips.length; i++) {
        if (!chips[i].querySelector('iframe')) continue;
        const result = await canvasHtml(r, i, 300);
        if (!active()) return;
        const { html, source, url } = result || {};
        const key = `${r}:${i}`;
        if (!html || document.querySelector(STOP_BTN)) { pending.delete(key); continue; }
        const previous = sent.get(key);
        // DOM で代用した場合、同じプレビュー内のスコアやアニメーションの変化はコード更新に数えない。
        if (previous?.html === html || (source === 'dom' && previous?.source === 'dom' && previous.url === url)) { pending.delete(key); continue; }
        if (pending.get(key)?.html !== html) pending.set(key, { html, changed: Date.now() });
        if (Date.now() - pending.get(key).changed < 1500) continue;
        await request({ type: 'canvas', conversation, files: [{ name: `canvas-${i + 1}.html`, content: html }] });
        sent.set(key, { html, source, url });
        pending.delete(key);
      }
    }
  }
}

// Enter は IME 確定でも飛ぶので、新しい質問の描画か入力欄のクリアで Gemini の受理を確認する。
// IME 確定の Enter → 送信の Enter や、Enter と送信ボタンが続くと検知が並走して二重送信になるので、
// 検知中の押下は新たに検知せず、検知の期限を延ばすだけにする。
let detectUntil = 0;
async function relay() {
  const editor = document.querySelector('.ql-editor');
  let text = editor?.innerText.trim();
  if (!text) return;
  const detecting = Date.now() < detectUntil;
  detectUntil = Date.now() + 15000;
  if (detecting) return;
  const before = document.querySelectorAll('model-response').length;
  const queries = new Set(document.querySelectorAll('user-query'));
  const newQuery = () => {
    const all = document.querySelectorAll('user-query'), last = all[all.length - 1];
    return last && !queries.has(last) && queryText(last.querySelector('.query-text') || last) === text ? last : null;
  };
  let sent = false;
  while (!sent && Date.now() < detectUntil) {
    await sleep(150);
    // Angular が入力欄を交換しても、切り離された古い要素を見続けない。
    const currentEditor = document.querySelector('.ql-editor');
    sent = !!newQuery() || !!currentEditor && !currentEditor.innerText.trim();
    // 検知中に IME で確定した文字も含めるよう、空になる直前の内容を控え直す
    if (!sent && currentEditor?.innerText.trim()) text = currentEditor.innerText.trim();
  }
  detectUntil = 0;
  if (!sent) { console.warn('MornGeminiRelay: 15 秒以内に質問の送信を確認できませんでした'); return; }
  canvasWatch++;
  const conversation = await conversationId();
  const query = newQuery();
  const prompt = request({ type: 'prompt', conversation, text, account: account(), attachments: query ? attachments(query) : [] });
  // 添付名の描画は本文を待たせず、遅れて表示された場合だけ同じスレッドへ追記する。
  const attached = (async () => {
    if (query) return;
    await waitFor(newQuery, '').catch(() => {});
    const names = attachments(newQuery());
    if (names.length) await request({ type: 'attachments', conversation, account: account(), attachments: names });
  })();
  await Promise.all([prompt, attached, relayAnswer(conversation, before).then(() => relayCanvas(conversation))]);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest('.ql-editor')) relay().catch(console.error);
}, true);

document.addEventListener('mousedown', (e) => {
  if (e.target.closest(SEND_BTN)) relay().catch(console.error);
}, true);

// Canvas の自動修正は入力欄を経由せず、空の user-query と新しい回答を追加する。
async function relayRepair() {
  canvasWatch++;
  const before = document.querySelectorAll('model-response').length;
  const conversation = await conversationId();
  await relayAnswer(conversation, before);
  return relayCanvas(conversation);
}

document.addEventListener('click', (e) => {
  if (e.target.closest(SEND_BTN)) return relay().catch(console.error);
  if (e.target.closest('button[data-test-id="fix-errors-button"]')) return relayRepair().catch(console.error);
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
    const text = queryText(query.querySelector('.query-text') || query);
    const attached = attachments(query);
    if (text || attached.length) post({ type: 'prompt', conversation, text, account: account(), attachments: attached, newThread: i === 0 });
    if (!response) continue;
    post({ type: 'answer', conversation, ...toMrkdwn(answerRoot()) });
    const index = [...document.querySelectorAll('model-response')].indexOf(response);
    for (const [c, chip] of [...response.querySelectorAll('immersive-entry-chip')].entries()) {
      // 画面外の Canvas はプレビューが読み込まれないことがあるので、見える位置へ動かしてから問い合わせる
      chip.scrollIntoView?.({ block: 'center' });
      const html = (await canvasHtml(index, c, 15000))?.html;
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
