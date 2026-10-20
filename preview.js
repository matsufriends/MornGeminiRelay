// Canvas のプレビュー (scf.usercontent.goog) のページ側 (MAIN world) で動く。
// プレビューのフレームは、まず読み込み役のページが生成された HTML を Blob にし、同じフレームを blob: URL へ遷移させる。
// 遷移すると blob: URL は無効になり読み直せないので、Blob が作られた瞬間に中身を sessionStorage (同じオリジンで共有) に控える。
// 控えがなければ、表示中の DOM で代用する (スクリプトによる書き換えも含まれる)。
// Gemini が差し込む <script data-bard-client-injected> (認証トークン・Firebase 設定入り) は取り除き、
// それでもトークンやキーの値が残っていれば渡さない。
const KEY = 'morn-gemini-relay:canvas';
const stripInjected = (html) => html.replace(/<script\b[^>]*\bdata-bard-client-injected\b[^>]*>[\s\S]*?<\/script>\s*/g, '');
const isHtml = (text) => /<html|<!doctype html/i.test(text);

window.Blob = new Proxy(Blob, {
  construct(target, args) {
    const parts = Array.isArray(args[0]) ? args[0] : [];
    const text = parts.map((part) => typeof part === 'string' ? part : ArrayBuffer.isView(part) ? new TextDecoder().decode(part) : '').join('');
    if (isHtml(text)) try { sessionStorage.setItem(KEY, text); } catch {}
    return Reflect.construct(target, args);
  },
});

// 差し込みスクリプトの実行後に window へ置かれる値
function secrets() {
  const values = [window.__initial_auth_token];
  try { values.push(JSON.parse(window.__firebase_config || '{}').apiKey); } catch {}
  return values.filter((value) => typeof value === 'string' && value.length >= 8);
}

function currentHtml() {
  let stored = '';
  try { stored = sessionStorage.getItem(KEY) || ''; } catch {}
  // 別の Canvas の控えを取り違えないよう、タイトルが一致するときだけ使う
  if (stored && (!document.title || stored.includes(document.title))) return { html: stored, source: 'blob' };
  return location.protocol === 'blob:' ? { html: `<!DOCTYPE html>\n${document.documentElement.outerHTML}`, source: 'dom' } : { html: '', source: '' };
}

addEventListener('message', (event) => {
  if (event.origin !== 'https://gemini.google.com' || event.data?.type !== 'morn-gemini-relay:get-canvas') return;
  const { html: raw, source } = currentHtml();
  // HTML を持たないフレーム (遷移前の読み込み役) は黙り、持っている側に答えさせる
  if (!isHtml(raw)) return;
  const html = stripInjected(raw);
  const error = /<script\b[^>]*\bdata-bard-client-injected/.test(html) ? '差し込みスクリプトを除去できませんでした'
    : secrets().some((secret) => html.includes(secret)) ? '認証情報が残っていたため送りませんでした' : '';
  event.source.postMessage({ type: 'morn-gemini-relay:canvas', id: event.data.id, html: error ? '' : html, error, source }, event.origin);
});
