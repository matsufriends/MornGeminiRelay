// Canvas のプレビュー (scf.usercontent.goog のフレームと、その中の blob: フレーム) のページ側 (MAIN world) で動く。
// scf フレームは生成された HTML を blob にして子フレームで表示するので、blob の作成を横取りして中身を控える。
// blob: フレームに入れた場合は自分自身を読み直す。Gemini 側の content.js から問い合わせがあれば控えた HTML を返す。
// Gemini が先頭に差し込む認証トークン入りの <script data-bard-client-injected> は取り除き、取り切れなければ渡さない。
const stripInjected = (html) => {
  // 属性が先頭とは限らない (例: <script ws-interception-config="…" data-bard-client-injected="true">)
  html = html.replace(/<script\b[^>]*\bdata-bard-client-injected\b[^>]*>[\s\S]*?<\/script>\s*/g, '');
  return html.includes('data-bard-client-injected') ? '' : html;
};
const isHtml = (text) => /<html|<!doctype html/i.test(text);

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
  const html = await source;
  // HTML を持たないフレームは黙り、持っている側 (scf か blob) に答えさせる
  if (isHtml(html)) event.source.postMessage({ type: 'morn-gemini-relay:canvas', id: event.data.id, html: stripInjected(html) }, event.origin);
});
