const $ = (id) => document.getElementById(id);
const status = (t) => ($('status').textContent = t);

chrome.storage.local.get({ webhook: '', history: [], importQueue: [], importTotal: 0 }, ({ webhook, history, importQueue, importTotal }) => {
  $('webhook').value = webhook;
  status(importQueue.length ? `取り込み中 ${importTotal - importQueue.length}/${importTotal} 会話 (${history.length} 件)` : `${history.length} 件`);
});

$('save').onclick = () => chrome.storage.local.set({ webhook: $('webhook').value.trim() }, () => status('保存した'));

$('import').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://gemini.google.com/')) return status('Gemini のタブで押してください');
  chrome.tabs.sendMessage(tab.id, { type: 'importAll' }, (r) => {
    if (chrome.runtime.lastError) return status('失敗: ' + chrome.runtime.lastError.message);
    status(`${r.conversations} 会話を順に開いて取り込み中。終わるまでタブを触らない`);
  });
};

$('download').onclick = () => chrome.storage.local.get({ history: [] }, ({ history }) => {
  const byUrl = new Map();
  for (const h of history) (byUrl.get(h.url) || byUrl.set(h.url, []).get(h.url)).push(h);
  let md = '# Gemini 質問履歴\n\n';
  for (const [url, hs] of byUrl) {
    md += `## ${hs.find((h) => h.title)?.title || url}\n\n${url}\n\n`;
    for (const h of hs) md += (h.ts ? `### ${new Date(h.ts).toLocaleString('ja-JP')}\n\n` : '') + h.text + '\n\n---\n\n';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `gemini-history-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
});

$('clear').onclick = () => chrome.storage.local.set({ history: [] }, () => status('0 件'));
