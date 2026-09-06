// Shared modal chrome for Sync Sentinel's modals. This plugin ships no
// styles.css (the release uploads only main.js + manifest.json), so component
// CSS is injected once as a scoped <style> element at runtime.
//
// The width + vertical-only scroll is what keeps long note/file paths from
// forcing horizontal scrolling — the recurring complaint the modals had.

const ID = "sync-sentinel-modal-styles";
const CSS = `
.sync-sentinel-modal.modal { width: min(1000px, 94vw); }
.sync-sentinel-modal .modal-content { max-height: 78vh; overflow-y: auto; overflow-x: hidden; }
.sync-sentinel-modal .modal-title { overflow-wrap: anywhere; word-break: break-word; }
.ss-wrap { overflow-wrap: anywhere; word-break: break-word; }
`;

function ensureStyles(): void {
  if (document.getElementById(ID)) return;
  const el = document.createElement("style");
  el.id = ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Make a modal wide with vertical-only scrolling; call from onOpen. */
export function applyWideModal(modalEl: HTMLElement): void {
  ensureStyles();
  modalEl.addClass("sync-sentinel-modal");
}
