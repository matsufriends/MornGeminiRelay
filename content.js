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
