const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);

function showProgress(job) {
  $('export').disabled = !!job && !job.done && !job.error;
  status(!job ? 'Gemini を開いて、質問履歴を .md に保存します。' : job.error ? `停止: ${job.error}` : job.done ? `${job.saved} 会話を保存しました` : job.queue ? `保存中 ${job.saved}/${job.total} 会話。完了まで Gemini のタブを触らないでください。` : 'Gemini を開いて会話一覧を取得中…');
}

chrome.storage.local.get({ slackToken: '', slackChannel: '' }, ({ slackToken, slackChannel }) => {
  $('slackToken').value = slackToken;
  $('slackChannel').value = slackChannel;
});
chrome.storage.session.get('exportJob', ({ exportJob }) => showProgress(exportJob));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.exportJob) showProgress(changes.exportJob.newValue);
});

$('save').onclick = () => chrome.storage.local.set({ slackToken: $('slackToken').value.trim(), slackChannel: $('slackChannel').value.trim() }, () => status('保存しました'));

$('export').onclick = async () => {
  $('export').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'startExport' });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    $('export').disabled = false;
    status(`失敗: ${error.message}`);
  }
};
