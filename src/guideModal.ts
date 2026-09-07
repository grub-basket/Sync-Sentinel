// In-plugin viewer for the free-sync guide. The guide markdown is bundled from
// docs/public/diy-sync-guide.md at build time (esbuild text loader), so this
// view and the published doc are the same source — they can't drift.
import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import guideMarkdown from "../docs/public/diy-sync-guide.md";
import { applyWideModal } from "./util/modalStyle";

export class GuideModal extends Modal {
  // Own Component so rendered child components (callouts, code blocks) are torn
  // down when the modal closes, not leaked until plugin unload.
  private readonly comp = new Component();

  constructor(app: App) {
    super(app);
  }

  async onOpen(): Promise<void> {
    applyWideModal(this.modalEl);
    this.titleEl.setText("Sync Sentinel — free DIY sync guide");
    this.comp.load();
    const body = this.contentEl.createDiv({ cls: "markdown-rendered ss-wrap" });
    await MarkdownRenderer.render(this.app, guideMarkdown, body, "", this.comp);
  }

  onClose(): void {
    this.comp.unload();
    this.contentEl.empty();
  }
}
