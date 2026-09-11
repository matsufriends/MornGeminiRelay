// 設定だけを永続保存する。旧版が蓄積した質問履歴と取り込み情報は削除する。
chrome.storage.local.remove(['history', 'importQueue', 'importTotal']);

async function downloadConversation(conversation, texts) {
  const title = conversation.title || new URL(conversation.href).pathname.split('/').pop();
  const md = `# ${title}\n\n${conversation.href}\n\n${texts.join('\n\n---\n\n')}\n`;
  const safe = title.replace(/[\\/:*?"<>|\n]+/g, ' ').trim().slice(0, 60) || 'conversation';
  const id = await chrome.downloads.download({
    url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md),
    filename: `gemini-history-${new Date().toISOString().slice(0, 10)}/${safe}.md`,
  });
  // 保存失敗を取りこぼさず、成功した会話から次へ進む。
  for (let i = 0; i < 300; i++) {
    const [download] = await chrome.downloads.search({ id });
    if (download?.state === 'complete') return;
    if (!download || download.state === 'interrupted') throw new Error(download?.error || 'ダウンロードに失敗しました');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('保存を確認できませんでした。Chrome のダウンロード一覧を確認してください');
}

async function handleMessage(msg, sender) {
  if (msg.type === 'prompt') {
    const { webhook } = await chrome.storage.local.get('webhook');
    if (webhook) {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${msg.account || 'unknown'}**\n${msg.text}`.slice(0, 2000) }),
      });
      if (!response.ok) throw new Error(`Discord: HTTP ${response.status}`);
    }
    return {};
  }

  const { exportJob } = await chrome.storage.session.get('exportJob');
  if (msg.type === 'startExport') {
    if (sender.tab) throw new Error('拡張機能のボタンから開始してください');
    if (exportJob && !exportJob.done && !exportJob.error) {
      await chrome.tabs.update(exportJob.tabId, { active: true });
      return {};
    }
    // 空タブで ID を確定してから Gemini を開き、ページ読み込みとの競合を避ける。
    const tab = await chrome.tabs.create({ url: 'about:blank' });
    await chrome.storage.session.set({ exportJob: { tabId: tab.id, queue: null, total: 0, saved: 0 } });
    try {
      await chrome.tabs.update(tab.id, { url: 'https://gemini.google.com/app' });
    } catch (error) {
      await chrome.storage.session.remove('exportJob');
      throw error;
    }
    return {};
  }
  if (msg.type === 'getExportJob') return exportJob?.tabId === sender.tab?.id ? exportJob : null;
  if (!exportJob || exportJob.tabId !== sender.tab?.id) throw new Error('保存用の Gemini タブではありません');

  if (msg.type === 'exportError') {
    await chrome.storage.session.set({ exportJob: { ...exportJob, error: String(msg.error) } });
    return {};
  }
  if (exportJob.error || exportJob.done) throw new Error('保存処理は停止しています');
  if (msg.type === 'exportQueue') {
    if (exportJob.queue !== null || !Array.isArray(msg.queue) || !msg.queue.length) throw new Error('会話一覧を取得できませんでした');
    const seen = new Set();
    exportJob.queue = msg.queue.map(({ href, title }) => {
      const url = new URL(href);
      if (url.origin !== 'https://gemini.google.com' || !/^\/(?:u\/\d+\/)?app\/[^/]+$/.test(url.pathname) || typeof title !== 'string' || seen.has(href)) throw new Error('会話 URL が不正です');
      seen.add(href);
      return { href, title };
    });
    exportJob.total = exportJob.queue.length;
  } else if (msg.type === 'exportConversation') {
    const current = exportJob.queue?.[0];
    if (!current || new URL(sender.url).pathname !== new URL(current.href).pathname || !Array.isArray(msg.texts) || !msg.texts.length || !msg.texts.every((text) => typeof text === 'string' && text.trim())) throw new Error('会話の本文を取得できませんでした');
    await downloadConversation(current, msg.texts);
    const active = await chrome.storage.session.get('exportJob');
    if (active.exportJob?.tabId !== exportJob.tabId) throw new Error('保存が中止されました');
    exportJob.queue.shift();
    exportJob.saved++;
    exportJob.done = !exportJob.queue.length;
  } else {
    throw new Error('不明な操作です');
  }
  // メモリ上に作業中の URL と進捗だけを置く。質問本文は保存しない。
  await chrome.storage.session.set({ exportJob });
  return { next: exportJob.queue[0]?.href };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { exportJob } = await chrome.storage.session.get('exportJob');
  if (exportJob?.tabId === tabId) await chrome.storage.session.remove('exportJob');
});
