// Canvas のプレビュー (scf.usercontent.goog のフレームと、それが遷移する blob: フレーム) のページ側 (MAIN world) で動く。
// scf フレームは生成された HTML を blob にして表示するので、blob の作成を横取りして中身を控える。
// blob: フレームでは自分自身を読み直す。Gemini 側の content.js から問い合わせがあれば控えた HTML を返す。
// Gemini が差し込む <script data-bard-client-injected> (認証トークン・Firebase 設定入り) は取り除き、
// それでもトークンやキーの値が残っていれば渡さない。
const stripInjected = (html) => html.replace(/<script\b[^>]*\bdata-bard-client-injected\b[^>]*>[\s\S]*?<\/script>\s*/g, '');
const isHtml = (text) => /<html|<!doctype html/i.test(text);

// 差し込みスクリプトの実行後に window へ置かれる値。blob: フレームでのみ得られる。
function secrets() {
  const values = [window.__initial_auth_token];
  try { values.push(JSON.parse(window.__firebase_config || '{}').apiKey); } catch {}
  return values.filter((value) => typeof value === 'string' && value.length >= 8);
}

// 読み込み後に blob が破棄されても取れるよう document_start で取りに行く
let source = location.protocol === 'blob:' ? fetch(location.href).then((response) => response.text()).catch(() => '') : Promise.resolve('');

const createObjectURL = URL.createObjectURL;
URL.createObjectURL = function (object) {
  if (typeof object?.text === 'function') {
    const previous = source;
    source = object.text().then((text) => isHtml(text) ? text : previous, () => previous);
  }
  return createObjectURL.apply(this, arguments);
};

addEventListener('message', async (event) => {
  if (event.origin !== 'https://gemini.google.com' || event.data?.type !== 'morn-gemini-relay:get-canvas') return;
  const raw = await source;
  // HTML を持たないフレームは黙り、持っている側に答えさせる
  if (!isHtml(raw)) return;
  const html = stripInjected(raw);
  const error = /<script\b[^>]*\bdata-bard-client-injected/.test(html) ? '差し込みスクリプトを除去できませんでした'
    : secrets().some((secret) => html.includes(secret)) ? '認証情報が残っていたため送りませんでした' : '';
  event.source.postMessage({ type: 'morn-gemini-relay:canvas', id: event.data.id, html: error ? '' : html, error }, event.origin);
});
