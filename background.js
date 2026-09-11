const key = (h) => h.url + '\n' + h.text;

// 1 会話分を ダウンロード/gemini-history-<日付>/<タイトル>.md に保存
function downloadConversation(url, hs) {
  if (!hs.length) return;
  const title = hs.find((h) => h.title)?.title || url.split('/').pop();
  let md = `# ${title}\n\n${url}\n\n`;
  for (const h of hs) md += (h.ts ? `## ${new Date(h.ts).toLocaleString('ja-JP')}\n\n` : '') + h.text + '\n\n---\n\n';
  const safe = title.replace(/[\\/:*?"<>|\n]+/g, ' ').trim().slice(0, 60);
  chrome.downloads.download({
    url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md),
    filename: `gemini-history-${new Date().toISOString().slice(0, 10)}/${safe}.md`,
  });
}

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
          body: JSON.stringify({ content: `**${msg.account || 'unknown'}**\n${msg.text}`.slice(0, 2000) }),
        }).catch((e) => console.error('webhook failed', e));
      }
    });
  }
  if (msg.type === 'import') {
    // 1 会話分ずつ届く。保存したらその場でダウンロード
    chrome.storage.local.get({ history: [] }, ({ history }) => {
      const seen = new Set(history.map(key));
      for (const it of msg.items) if (!seen.has(key(it))) { seen.add(key(it)); history.push(it); }
      chrome.storage.local.set({ history });
      if (msg.items[0]) downloadConversation(msg.items[0].url, msg.items);
    });
  }
});
