// Gemini の送信操作 (Enter / 送信ボタン) を捕まえ、入力欄のテキストを background へ渡す
const SEND_BTN = 'button[aria-label*="送信"], button[aria-label*="Send" i]';

function relay() {
  const text = document.querySelector('.ql-editor')?.innerText.trim();
  if (!text) return;
  chrome.runtime.sendMessage({ type: 'prompt', text, url: location.href, ts: Date.now() });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.closest('.ql-editor')) relay();
}, true);

document.addEventListener('mousedown', (e) => {
  if (e.target.closest(SEND_BTN)) relay();
}, true);

// ---- 過去履歴の全取り込み: サイドバーの会話を順に開いて user-query を集める ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 8000) {
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

async function importAll() {
  const hrefs = [...document.querySelectorAll('[data-test-id="conversation"] a')].map((a) => a.href);
  const items = [];
  for (const href of hrefs) {
    const a = [...document.querySelectorAll('[data-test-id="conversation"] a')].find((x) => x.href === href);
    if (!a) continue;
    const title = a.innerText.trim();
    a.click();
    await waitFor(() => location.href === href && document.querySelector('user-query'));
    // ponytail: 長い会話は上方向へ数回スクロールして遅延描画分を読む。足りなければ回数を増やす
    const sc = document.querySelector('infinite-scroller');
    for (let i = 0; i < 5 && sc; i++) { sc.scrollTop = 0; await sleep(600); }
    for (const text of scrapeQueries()) items.push({ ts: null, url: href, title, text });
  }
  chrome.runtime.sendMessage({ type: 'import', items });
  return { conversations: hrefs.length, messages: items.length };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type !== 'importAll') return;
  importAll().then(sendResponse);
  return true;
});
