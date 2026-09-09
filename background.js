const key = (h) => h.url + '\n' + h.text;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'prompt') {
    chrome.storage.local.get({ history: [], webhook: '' }, ({ history, webhook }) => {
      history.push({ ts: msg.ts, url: msg.url, title: '', text: msg.text });
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
  }
  if (msg.type === 'import') {
    chrome.storage.local.get({ history: [] }, ({ history }) => {
      const seen = new Set(history.map(key));
      for (const it of msg.items) if (!seen.has(key(it))) { seen.add(key(it)); history.push(it); }
      chrome.storage.local.set({ history });
    });
  }
});
