// Gemini のページ側 (MAIN world) で動く。content.js (isolated world) に頼まれて Canvas のプレビューへ HTML を問い合わせ、
// 返事を DOM イベントで content.js に渡す。コンソール (ページ側) から送った問い合わせには preview.js が答えたが、
// content.js から直接送った問い合わせには答えが返らなかったため、実績のあるページ側から送る。
const descendants = (win, depth = 3) => depth ? Array.from({ length: win.length }, (_, i) => win[i]).flatMap((child) => [child, ...descendants(child, depth - 1)]) : [];

document.addEventListener('morn-gemini-relay:ask-canvas', (event) => {
  const { id, response, chip } = JSON.parse(event.detail);
  const win = document.querySelectorAll('model-response')[response]?.querySelectorAll('immersive-entry-chip')[chip]?.querySelector('iframe')?.contentWindow;
  // iframe 自身が blob に遷移して HTML を持つので、自身も問い合わせ先に含める
  for (const frame of win ? [win, ...descendants(win)] : []) frame.postMessage({ type: 'morn-gemini-relay:get-canvas', id }, '*');
});

addEventListener('message', (event) => {
  if (event.data?.type === 'morn-gemini-relay:canvas') document.dispatchEvent(new CustomEvent('morn-gemini-relay:canvas', { detail: JSON.stringify(event.data) }));
});
