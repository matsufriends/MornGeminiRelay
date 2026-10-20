// ページ側 (MAIN world) で動く。content.js からは window.monaco が見えないため、
// 要求イベントを受けたら Canvas エディタのコード全文を DOM 属性に書き出して渡す。
// Monaco は見えている行しか描画しないので、DOM から読むと長いコードが欠ける。
document.addEventListener('morn-gemini-relay:canvas', () => {
  for (const editor of window.monaco?.editor.getEditors?.() || []) {
    const host = editor.getDomNode()?.closest('xap-code-editor');
    const model = editor.getModel();
    if (!host || !model) continue;
    host.dataset.mornCode = model.getValue();
    host.dataset.mornLang = model.getLanguageId();
  }
});
