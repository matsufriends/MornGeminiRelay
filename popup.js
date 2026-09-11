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
    status(`${r.conversations} 会話を順に開いて取り込み中 (1 会話ごとに .md を保存)。終わるまでタブを触らない`);
  });
};
