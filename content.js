// Gemini の送信操作 (Enter / 送信ボタン) を捕まえ、入力欄のテキストを background へ渡す
const SEND_BTN = 'button[aria-label*="送信"], button[aria-label*="Send" i]';

// 右上アバターの aria-label「Google アカウント: 名前 (メール)」から取る
function account() {
  const label = document.querySelector('a[aria-label^="Google アカウント"], a[aria-label^="Google Account"]')?.getAttribute('aria-label') || '';
  return label.split(/[:：]/).slice(1).join(':').replace(/\s+/g, ' ').replace(/,.*$/, '').trim();
}

// Enter は IME 確定でも飛ぶので、押下時のテキストを控えて「入力欄が空になった = Gemini が受理した」ときだけ送る
async function relay() {
  const editor = document.querySelector('.ql-editor');
  const text = editor?.innerText.trim();
  if (!text) return;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!editor.innerText.trim()) {
      request({ type: 'prompt', text, account: account() }).catch(console.error);
      return;
    }
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest('.ql-editor')) relay();
}, true);

document.addEventListener('mousedown', (e) => {
  if (e.target.closest(SEND_BTN)) relay();
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

function scrapeQueries() {
  return [...document.querySelectorAll('user-query .query-text')].filter(visible).map((query) => {
    const lines = [...query.querySelectorAll('.query-text-line')];
    return (lines.length ? lines.map((line) => line.innerText).join('\n') : query.innerText).trim();
  }).filter(Boolean);
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

async function exportCurrentPage() {
  const job = await request({ type: 'getExportJob' });
  if (!job || job.done || job.error) return;
  let response;
  if (job.queue === null) {
    response = await request({ type: 'exportQueue', queue: await collectConversations() });
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
