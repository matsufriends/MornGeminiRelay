// Canvas のプレビュー (scf.usercontent.goog 内の blob: フレーム) で動く。
// blob の中身が生成された HTML そのものなので、読み込み直後に控えておき、Gemini 側の content.js から問い合わせがあれば返す。
// Gemini が先頭に差し込む認証トークン入りの <script data-bard-client-injected> は取り除き、取り切れなければ渡さない。
const stripInjected = (html) => {
  html = html.replace(/<script data-bard-client-injected[^>]*>[\s\S]*?<\/script>\s*/g, '');
  return html.includes('data-bard-client-injected') ? '' : html;
};

if (location.protocol === 'blob:') {
  // 読み込み後に blob が破棄されても取れるよう document_start で取りに行く。失敗したら描画後の DOM で代用する。
  const source = fetch(location.href).then((response) => response.text()).catch(() => '');
  addEventListener('message', async (event) => {
    if (event.origin !== 'https://gemini.google.com' || event.data?.type !== 'morn-gemini-relay:get-canvas') return;
    const html = (await source) || `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
    event.source.postMessage({ type: 'morn-gemini-relay:canvas', html: stripInjected(html) }, event.origin);
  });
}
