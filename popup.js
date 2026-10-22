const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);

let lastResult = '';
function showProgress(job) {
  const running = !!job && !job.done && !job.error;
  for (const id of ['export', 'list']) $(id).disabled = running;
  $('send').disabled = running || $('chat').disabled;
  status(!job ? lastResult || 'Gemini を開いて、質問履歴を .md に保存します。'
    : job.error ? `停止: ${job.error}`
    : job.mode === 'list' ? 'Gemini を開いて全チャットを取得中…'
    : job.mode === 'send' ? 'Slack に送信中… 完了まで Gemini のタブを触らないでください。'
    : job.done ? `${job.saved} 会話を保存しました`
    : job.queue ? `保存中 ${job.saved}/${job.total} 会話。完了まで Gemini のタブを触らないでください。` : 'Gemini を開いて会話一覧を取得中…');
}

function showChats(chats = []) {
  $('chat').replaceChildren(...chats.map((chat) => new Option(chat.title || chat.href, chat.href)));
  if (!chats.length) $('chat').append(new Option('先に全チャットを取得してください'));
  $('chat').disabled = $('send').disabled = !chats.length;
}

chrome.storage.local.get({ slackToken: '', slackChannel: '', nickname: '', relayEnabled: false }, ({ slackToken, slackChannel, nickname, relayEnabled }) => {
  $('slackToken').value = slackToken;
  $('slackChannel').value = slackChannel;
  $('nickname').value = nickname;
  $('relayEnabled').checked = relayEnabled;
});
let chats = [];
chrome.storage.session.get(['exportJob', 'chatList', 'lastResult'], (values) => {
  chats = values.chatList || [];
  lastResult = values.lastResult || '';
  showChats(chats);
  showProgress(values.exportJob);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.chatList) showChats(chats = changes.chatList.newValue || []);
  if (changes.lastResult) lastResult = changes.lastResult.newValue || '';
  if (changes.exportJob || changes.lastResult) chrome.storage.session.get('exportJob', ({ exportJob }) => showProgress(exportJob));
});

$('save').onclick = () => {
  const slackToken = $('slackToken').value.trim(), slackChannel = $('slackChannel').value.trim();
  const relayEnabled = $('relayEnabled').checked;
  if (relayEnabled && (!slackToken.startsWith('xoxb-') || !/^[CG][A-Z0-9]+$/.test(slackChannel))) {
    status('Bot Token とチャンネル ID を確認してください');
    return;
  }
  chrome.storage.local.set({ slackToken, slackChannel, nickname: $('nickname').value.trim(), relayEnabled }, () => status(relayEnabled ? '保存しました。Slack 転送は有効です' : '保存しました。Slack 転送は停止中です'));
};

async function start(message) {
  for (const id of ['export', 'list', 'send']) $(id).disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'startExport', ...message });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    showProgress(null);
    status(`失敗: ${error.message}`);
  }
}

$('export').onclick = () => start({});
$('list').onclick = () => start({ mode: 'list' });
$('send').onclick = () => start({ mode: 'send', chat: chats.find((chat) => chat.href === $('chat').value) });
