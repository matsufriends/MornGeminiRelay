// ページ側 (MAIN world) で動く。content.js からは window.monaco が見えないため、
// 要求イベントを受けたら、コード表示中の Canvas エディタの全文を DOM 属性に書き出して渡す (プレビュー表示中は preview.js が担う)。
// Monaco は見えている行しか描画しないので、DOM から読むと長いコードが欠ける。
document.addEventListener('morn-gemini-relay:canvas', () => {
  for (const editor of window.monaco?.editor.getEditors?.() || []) {
    const host = editor.getDomNode()?.closest('immersive-entry-chip');
    const model = editor.getModel();
    if (!host || !model) continue;
    host.dataset.mornCode = model.getValue();
    host.dataset.mornLang = model.getLanguageId();
  }
});
