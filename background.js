chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'prompt') return;
  chrome.storage.local.get({ history: [], webhook: '' }, ({ history, webhook }) => {
    history.push({ ts: msg.ts, url: msg.url, text: msg.text });
    chrome.storage.local.set({ history });
    if (webhook) {
      // Discord の content は 2000 文字上限
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg.text.slice(0, 2000) }),
      }).catch((e) => console.error('webhook failed', e));
    }
  });
});
