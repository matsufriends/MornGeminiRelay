// 設定と会話 ID → Slack スレッドの対応だけを永続保存する。旧版の履歴・取り込み情報・Discord 設定は削除する。
chrome.storage.local.remove(['history', 'importQueue', 'importTotal', 'webhook']);

const escapeSlack = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let slackQueue = Promise.resolve();

// files.getUploadURLExternal が JSON を受け付けないため、全メソッドをフォーム形式で呼ぶ。undefined の項目 (親投稿時の thread_ts) は送らない。
// 投稿が速すぎると 429 (ratelimited) が返るので、Retry-After の秒数だけ待って送り直す。
async function slackApi(token, method, params) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new URLSearchParams(JSON.parse(JSON.stringify(params))),
    });
    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, (Number(response.headers.get('Retry-After')) || 1) * 1000));
      continue;
    }
    const result = await response.json();
    if (!result.ok) throw new Error(`Slack ${method}: ${result.error}`);
    return result;
  }
}

// 会話の最初の投稿を親にし、以降の質問・回答はその ts をスレッドにして返信する。
// コードは長くても 1 つにまとまり折りたたまれるよう、ファイルとして同じスレッドに添付する (files:write が必要)。
// 同じ会話の親投稿が二重にできないよう、投稿は 1 件ずつ順に処理する。
// fresh なら既存のスレッドを使わず、新しい親投稿を作って対応表を置き換える (チャットを丸ごと送り直すとき)。
// 本文は表示名に依存するので makeText(nickname) で受け取り、順番待ちの中で作る (await を挟むと送信順が入れ替わりうる)。
function postToSlack(conversation, makeText, files = [], fresh = false) {
  const post = slackQueue.then(async () => {
    const { slackToken, slackChannel, threads = {}, nickname } = await chrome.storage.local.get(['slackToken', 'slackChannel', 'threads', 'nickname']);
    if (!slackToken || !slackChannel) return;
    const text = makeText(nickname);
    let thread = fresh ? undefined : threads[conversation];
    if (text) {
      const result = await slackApi(slackToken, 'chat.postMessage', { channel: slackChannel, thread_ts: thread, text: text.slice(0, 39000) });
      if (!thread) {
        thread = result.ts;
        // ponytail: 対応表は会話数ぶん増え続ける。肥大が問題になったら古いものから消す。
        await chrome.storage.local.set({ threads: { ...threads, [conversation]: thread } });
      }
    }
    if (!files.length) return;
    const uploaded = [];
    for (const file of files) {
      const bytes = new TextEncoder().encode(file.content);
      const { upload_url, file_id } = await slackApi(slackToken, 'files.getUploadURLExternal', { filename: file.name, length: bytes.length });
      const upload = await fetch(upload_url, { method: 'POST', body: bytes });
      if (!upload.ok) throw new Error(`Slack upload: HTTP ${upload.status}`);
      uploaded.push({ id: file_id, title: file.name });
    }
    await slackApi(slackToken, 'files.completeUploadExternal', { files: JSON.stringify(uploaded), channel_id: slackChannel, thread_ts: thread });
  });
  slackQueue = post.catch(() => {});
  return post;
}

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
  if (msg.type === 'prompt' || msg.type === 'answer' || msg.type === 'canvas') {
    // canvas は本文なしで、回答の後から届く Canvas のコードだけを同じスレッドへ流す
    const files = msg.files || [], text = msg.type === 'canvas' ? '' : msg.text;
    if (typeof msg.conversation !== 'string' || !/^[\w-]+$/.test(msg.conversation) || typeof text !== 'string') throw new Error('不正な転送内容です');
    if (!Array.isArray(files) || !files.every((file) => /^[\w.-]{1,100}$/.test(file?.name) && typeof file.content === 'string' && file.content)) throw new Error('不正な添付ファイルです');
    // 同じ Bot が投稿するので、名前の行を Slack の引用 (左の縦線) にして自分と Gemini を見分けられるようにする。
    // Slack は日本語に隣接した *太字* を解釈しないので、ゼロ幅スペースで区切る。
    // 添付は名前だけを知らせる (中身は送らない)
    const attached = Array.isArray(msg.attachments) ? msg.attachments.filter((name) => typeof name === 'string' && name).map((name) => name.slice(0, 200)) : [];
    const note = attached.length ? `\n📎 添付: ${escapeSlack(attached.join(', '))}` : '';
    const email = msg.account?.match(/\(([^()]+@[^()]+)\)/)?.[1];
    const makeText = (nickname) => {
      if (msg.type === 'canvas') return '';
      // 自分の名前はポップアップで設定したニックネームを優先して「ニックネーム (メール)」にし、未設定なら「Google アカウント名 (メール)」のまま
      const me = nickname ? (email ? `${nickname} (${email})` : nickname) : msg.account || 'unknown';
      const author = msg.type === 'prompt' ? `🧑‍💻 \u200B*${escapeSlack(me)}*\u200B` : '✨ \u200B*Gemini*\u200B';
      return `> ${author}\n${escapeSlack(text)}${note}`;
    };
    await postToSlack(msg.conversation, makeText, files, msg.type === 'prompt' && msg.newThread === true);
    return {};
  }

  const { exportJob } = await chrome.storage.session.get('exportJob');
  if (msg.type === 'startExport') {
    if (sender.tab) throw new Error('拡張機能のボタンから開始してください');
    if (exportJob && !exportJob.done && !exportJob.error) {
      await chrome.tabs.update(exportJob.tabId, { active: true });
      return {};
    }
    // download: 全会話を .md に保存 / list: 会話一覧だけを取得 / send: 選んだ会話を Slack の新しいスレッドへ送る
    const mode = ['list', 'send'].includes(msg.mode) ? msg.mode : 'download';
    const chat = mode === 'send' ? validChat(msg.chat) : null;
    // 空タブで ID を確定してから Gemini を開き、ページ読み込みとの競合を避ける。
    const tab = await chrome.tabs.create({ url: 'about:blank' });
    await chrome.storage.session.set({ exportJob: { tabId: tab.id, mode, queue: chat ? [chat] : null, total: chat ? 1 : 0, saved: 0 } });
    try {
      await chrome.tabs.update(tab.id, { url: chat?.href || 'https://gemini.google.com/app' });
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
    exportJob.queue = msg.queue.map((chat) => {
      if (seen.has(chat?.href)) throw new Error('会話 URL が不正です');
      seen.add(chat.href);
      return validChat(chat);
    });
    exportJob.total = exportJob.queue.length;
    if (exportJob.mode === 'list') return finishJob(exportJob, `${exportJob.total} 件の会話を取得しました`, { chatList: exportJob.queue });
  } else if (msg.type === 'exportSent') {
    const current = exportJob.queue?.[0];
    if (exportJob.mode !== 'send' || !current || new URL(sender.url).pathname !== new URL(current.href).pathname) throw new Error('送信中の会話ではありません');
    return finishJob(exportJob, `「${current.title}」を Slack に送信しました`);
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

// 一覧の取得と会話の送信は 1 回で終わるので、結果を残して専用タブを閉じる。
// ponytail: 会話一覧 (URL とタイトル) はセッション中だけメモリに置く。ブラウザを閉じたら取り直す。
async function finishJob(exportJob, message, values = {}) {
  await chrome.storage.session.set({ ...values, lastResult: message });
  await chrome.tabs.remove(exportJob.tabId).catch(() => {});
  return {};
}

function validChat(chat) {
  const url = new URL(chat?.href);
  if (url.origin !== 'https://gemini.google.com' || !/^\/(?:u\/\d+\/)?app\/[^/]+$/.test(url.pathname) || typeof chat.title !== 'string') throw new Error('会話 URL が不正です');
  return { href: chat.href, title: chat.title };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { exportJob } = await chrome.storage.session.get('exportJob');
  if (exportJob?.tabId === tabId) await chrome.storage.session.remove('exportJob');
});
