// Local version history browser — the "fixable anytime" guarantee.
//
// Sync tools give you a deadline: Obsidian Sync's version history expires,
// Syncthing's versioning is opt-in, a silent last-writer-wins or a weird
// automatic merge is only fixable if you NOTICE in time. The base store keeps
// every observed version of your text files locally (deduplicated, never
// age-purged unless the user opts in), and this modal lets you inspect and
// restore any of them, whenever you get around to noticing.
import { App, Modal, Notice } from "obsidian";
import type { BaseStore } from "./baseStore";

/** Cheap line-diff summary: how many lines this version adds/removes vs now. */
function diffSummary(from: string, to: string): string {
  const a = from.split("\n");
  const b = to.split("\n");
  const countA = new Map<string, number>();
  for (const l of a) countA.set(l, (countA.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const c = countA.get(l) ?? 0;
    if (c > 0) {
      common++;
      countA.set(l, c - 1);
    }
  }
  const removed = a.length - common;
  const added = b.length - common;
  if (!added && !removed) return "identical to current";
  return `${added ? `+${added}` : ""}${added && removed ? " / " : ""}${removed ? `−${removed}` : ""} line(s) vs current`;
}

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private bases: BaseStore,
    private filePath: string,
    /**
     * Restore `text` into the file. Provided by the plugin so it goes through
     * the editor-aware path (RecoveryService.restoreInto): if the note is open,
     * the editor buffer is replaced, otherwise the file is written — and the
     * replaced content is snapshotted first, so a restore never loses anything.
     */
    private restore: (text: string) => Promise<void>
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Version history — ${this.filePath}`);
    await this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const snaps = (await this.bases.listSnapshots(this.filePath)).reverse(); // newest first
    const intro = contentEl.createEl("p", {
      text: snaps.length
        ? `${snaps.length} locally remembered version(s). Restoring never loses anything — the current content is snapshotted first.`
        : "No versions remembered for this file yet. Versions accumulate as the file is opened and changed while version history is enabled.",
      cls: "setting-item-description",
    });
    intro.style.marginTop = "0";
    if (!snaps.length) return;

    const current = await this.app.vault.adapter.read(this.filePath).catch(() => "");

    for (const s of snaps) {
      const text = await this.bases.readBlob(s.h);
      const row = contentEl.createDiv();
      row.style.padding = "8px 0";
      row.style.borderTop = "1px solid var(--background-modifier-border)";

      const head = row.createDiv();
      head.style.display = "flex";
      head.style.justifyContent = "space-between";
      head.style.alignItems = "baseline";
      const title = head.createSpan({ text: new Date(s.t).toLocaleString() });
      title.style.fontWeight = "600";
      if (s.suspicious) {
        const tag = head.createSpan({ text: " ␀ blanked" });
        tag.style.color = "var(--text-error)";
        tag.style.fontSize = "11px";
      }
      const sub = head.createSpan({
        text: text === null ? "content missing (blob purged)" : diffSummary(text, current),
      });
      sub.style.fontSize = "12px";
      sub.style.color = "var(--text-muted)";

      if (text === null) continue;

      const btns = row.createDiv();
      btns.style.marginTop = "4px";
      const previewBtn = btns.createEl("button", { text: "Preview" });
      previewBtn.style.marginRight = "6px";
      const restoreBtn = btns.createEl("button", { text: "Restore this version" });

      let pre: HTMLElement | null = null;
      previewBtn.onclick = () => {
        if (pre) {
          pre.remove();
          pre = null;
          previewBtn.setText("Preview");
          return;
        }
        pre = row.createEl("pre");
        pre.style.maxHeight = "220px";
        pre.style.overflow = "auto";
        pre.style.fontSize = "12px";
        pre.style.whiteSpace = "pre-wrap";
        pre.style.background = "var(--background-secondary)";
        pre.style.padding = "8px";
        pre.setText(text);
        previewBtn.setText("Hide preview");
      };

      restoreBtn.onclick = async () => {
        await this.restore(text);
        new Notice(
          `Restored ${this.filePath} to the ${new Date(s.t).toLocaleString()} version. The replaced content is in version history.`
        );
        await this.render();
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
