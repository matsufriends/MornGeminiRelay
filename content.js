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
      chrome.runtime.sendMessage({ type: 'prompt', text, url: location.href, ts: Date.now(), account: account() });
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

// ---- 過去履歴の全取り込み ----
// サイドバーの会話 URL を queue に保存し、1 会話ずつフルロードで開いて user-query を集める。
// SPA 内遷移だと前の会話 DOM が hidden で残り、サイドバーも消えるため、ページ遷移で毎回まっさらにする
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(200);
  }
  return false;
}

function scrapeQueries() {
  return [...document.querySelectorAll('user-query .query-text')].map((q) =>
    [...q.querySelectorAll('.query-text-line')].map((p) => p.innerText).join('\n').trim()
  ).filter(Boolean);
}

async function startImport() {
  // サイドバーが閉じていると会話リンクが描画されないので開く
  if (!document.querySelector('[data-test-id="conversation"] a')) {
    [...document.querySelectorAll('button')]
      .find((b) => /サイドバーを開く|open sidebar|メインメニュー|main menu/i.test(b.getAttribute('aria-label') || ''))?.click();
  }
  await waitFor(() => document.querySelector('[data-test-id="conversation"] a'));
  const queue = [...document.querySelectorAll('[data-test-id="conversation"] a')]
    .map((a) => ({ href: a.href, title: a.innerText.trim() }));
  await chrome.storage.local.set({ importQueue: queue, importTotal: queue.length });
  location.href = queue[0].href;
  return { conversations: queue.length };
}

async function continueImport() {
  const { importQueue = [] } = await chrome.storage.local.get('importQueue');
  const cur = importQueue[0];
  if (!cur || !location.href.startsWith(cur.href)) return;
  await waitFor(() => document.querySelector('user-query'));
  // 各ターンは少し遅れて描画されるので、件数が 2 秒変わらなくなるまで待つ
  for (let n = -1, stable = 0; stable < 4; stable = document.querySelectorAll('user-query').length === n ? stable + 1 : 0) {
    n = document.querySelectorAll('user-query').length;
    await sleep(500);
  }
  // ponytail: 長い会話は上方向へ数回スクロールして遅延描画分を読む。足りなければ回数を増やす
  const sc = document.querySelector('infinite-scroller');
  for (let i = 0; i < 5 && sc; i++) { sc.scrollTop = 0; await sleep(600); }
  const items = scrapeQueries().map((text) => ({ ts: null, url: cur.href, title: cur.title, text }));
  chrome.runtime.sendMessage({ type: 'import', items });
  const rest = importQueue.slice(1);
  await chrome.storage.local.set({ importQueue: rest });
  if (rest[0]) location.href = rest[0].href;
}
continueImport();

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type !== 'importAll') return;
  startImport().then(sendResponse);
  return true;
});
