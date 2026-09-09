const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ webhook: '', history: [] }, ({ webhook, history }) => {
  $('webhook').value = webhook;
  $('status').textContent = `${history.length} 件`;
});

$('save').onclick = () => chrome.storage.local.set({ webhook: $('webhook').value.trim() }, () => ($('status').textContent = '保存した'));

$('download').onclick = () => chrome.storage.local.get({ history: [] }, ({ history }) => {
  const md = '# Gemini 質問履歴\n\n' + history.map((h) =>
    `## ${new Date(h.ts).toLocaleString('ja-JP')}\n\n${h.url}\n\n${h.text}\n`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `gemini-history-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
});

$('clear').onclick = () => chrome.storage.local.set({ history: [] }, () => ($('status').textContent = '0 件'));
