import { App, Modal, Notice, setIcon } from "obsidian";
import { humanBytes } from "../util/fsutil";
import type SyncSentinelPlugin from "../main";
import type { RegistryEntryStatus } from "./registry";

const STATE_LABEL: Record<RegistryEntryStatus["state"], string> = {
  synced: "✓ In sync",
  "ready-to-merge": "↧ Ready to merge",
  conflict: "⚠ Conflict (local differs)",
  "missing-shards": "… Missing shards",
  "split-here": "Split here",
};

export class RegistryModal extends Modal {
  constructor(app: App, private plugin: SyncSentinelPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Sync Sentinel — split registry");
    await this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const toolbar = contentEl.createDiv();
    toolbar.style.marginBottom = "12px";
    const refresh = toolbar.createEl("button", { text: "Refresh" });
    refresh.onclick = () => this.render();
    const reconAll = toolbar.createEl("button", { text: "Reconstruct all" });
    reconAll.style.marginLeft = "8px";
    reconAll.onclick = async () => {
      await this.plugin.registry.reconstructAll();
      this.render();
    };
    const splitAll = toolbar.createEl("button", { text: "Split all large files" });
    splitAll.style.marginLeft = "8px";
    splitAll.onclick = async () => {
      await this.plugin.registry.scanAndAutoSplit();
      this.render();
    };

    this.renderOverview(contentEl);

    const tracked = contentEl.createEl("h3", { text: "Tracked splits" });
    tracked.style.margin = "16px 0 4px";

    const statuses = await this.plugin.registry.statuses();
    if (statuses.length === 0) {
      contentEl.createEl("p", {
        text: "No split files tracked yet. Split a large file to get started.",
        cls: "setting-item-description",
      });
      return;
    }

    for (const s of statuses) {
      const row = contentEl.createDiv();
      row.style.borderTop = "1px solid var(--background-modifier-border)";
      row.style.padding = "8px 0";

      const title = row.createEl("div", { text: s.manifest.originalPath });
      title.style.fontWeight = "600";

      const meta = row.createEl("div");
      meta.style.fontSize = "12px";
      meta.style.color = "var(--text-muted)";
      meta.setText(
        `${STATE_LABEL[s.state]} · ${humanBytes(s.manifest.originalSize)} · ` +
          `${s.manifest.shards.length} shards · from ${s.manifest.host}`
      );

      await this.renderDevices(row, s.manifest.id);

      const actions = row.createDiv();
      actions.style.marginTop = "6px";

      if (s.state === "ready-to-merge") {
        const b = actions.createEl("button", { text: "Reconstruct" });
        b.onclick = async () => {
          await this.plugin.registry.reconstruct(s.manifest);
          this.render();
        };
      }
      if (s.state === "conflict") {
        const note = row.createEl("div");
        note.style.fontSize = "12px";
        note.style.color = "var(--text-warning, var(--text-muted))";
        note.setText(
          s.conflictFile
            ? `A synced copy is saved as “${s.conflictFile.split("/").pop()}” for you to compare.`
            : "Local file differs from the synced shards."
        );

        const useSynced = actions.createEl("button", {
          text: "Use synced version",
        });
        useSynced.onclick = async () => {
          await this.plugin.registry.resolveUseSynced(s.manifest);
          new Notice("Replaced local with the synced version.");
          this.render();
        };

        const keepLocal = actions.createEl("button", {
          text: "Keep local (re-split)",
        });
        keepLocal.style.marginLeft = "6px";
        keepLocal.onclick = async () => {
          await this.plugin.registry.resolveKeepLocal(s.manifest);
          new Notice("Kept local file; shards re-generated from it.");
          this.render();
        };

        if (s.conflictFile) {
          const open = actions.createEl("button", { text: "Open synced copy" });
          open.style.marginLeft = "6px";
          open.onclick = () => {
            this.app.workspace.openLinkText(s.conflictFile as string, "", true);
          };
        } else {
          const make = actions.createEl("button", {
            text: "Save synced copy to compare",
          });
          make.style.marginLeft = "6px";
          make.onclick = async () => {
            const p = await this.plugin.registry.writeConflictFile(s.manifest);
            new Notice(p ? "Saved synced copy." : "Could not save (shards incomplete).");
            this.render();
          };
        }
      }
      if (s.state === "synced") {
        const b = actions.createEl("button", { text: "Re-split (refresh shards)" });
        b.onclick = async () => {
          await this.plugin.registry.splitVaultFile(s.manifest.originalPath, {
            force: true,
          });
          this.render();
        };
      }
      const forget = actions.createEl("button", { text: "Forget" });
      forget.style.marginLeft = "6px";
      forget.onclick = async () => {
        await this.plugin.registry.forget(s.manifest.id);
        new Notice("Forgot split (original left untouched).");
        this.render();
      };

      await this.renderSpace(row, s);
    }
  }

  /** Keeper archive + gated purge controls for reclaiming space. */
  private async renderSpace(row: HTMLElement, s: RegistryEntryStatus): Promise<void> {
    const reg = this.plugin.registry;
    const m = s.manifest;
    const devices = await reg.deviceStatesFor(m.id);
    const self = devices.find((d) => d.isSelf);
    const selfKeeper = !!self?.keeper;
    const selfOptedOut = !!self?.optedOut;
    const selfArchivedValid = self?.archivedSha === m.originalSha256;
    const gate = await reg.purgeGate(m);

    const box = row.createDiv();
    box.style.marginTop = "6px";
    box.style.fontSize = "12px";

    // If this device opted out, it doesn't participate — offer only to opt back in.
    if (selfOptedOut) {
      const note = box.createSpan({
        text: "This device opted out of this file (won't hold it; excluded from the purge gate). ",
      });
      note.style.color = "var(--text-muted)";
      const back = box.createEl("button", { text: "Opt back in" });
      back.onclick = async () => {
        await reg.setOptedOut(m.id, false);
        this.render();
      };
      return;
    }

    const keeperBtn = box.createEl("button", {
      text: selfKeeper ? "Unset keeper (this device)" : "Make this device a keeper",
    });
    keeperBtn.onclick = async () => {
      await reg.setKeeper(m.id, !selfKeeper);
      this.render();
    };

    const optOut = box.createEl("button", { text: "Opt out on this device" });
    optOut.style.marginLeft = "6px";
    optOut.title = "This device won't hold this file; it stops blocking the purge gate.";
    optOut.onclick = async () => {
      const ok = window.confirm(
        `Opt this device out of "${m.originalPath}"?\n\n` +
          "It won't auto-reconstruct here and won't count toward the purge gate. Any local " +
          "keeper role for this file is dropped. You can opt back in later."
      );
      if (!ok) return;
      await reg.setOptedOut(m.id, true);
      this.render();
    };

    if (selfKeeper && s.shardsComplete && !selfArchivedValid) {
      const a = box.createEl("button", { text: "Archive shards locally" });
      a.style.marginLeft = "6px";
      a.onclick = async () => {
        const ok = await reg.archiveShards(m);
        new Notice(
          ok
            ? "Archived shards to the excluded folder (verified)."
            : "Archive failed — shards incomplete or verification mismatch. Not marked as archived."
        );
        this.render();
      };
    }

    if (!s.shardsComplete && (await reg.hasLocalArchive(m))) {
      const r = box.createEl("button", { text: "Re-share shards from archive" });
      r.style.marginLeft = "6px";
      r.onclick = async () => {
        const ok = await reg.reShareFromArchive(m);
        new Notice(ok ? "Re-shared shards to the synced folder." : "No local archive to re-share.");
        this.render();
      };
    }

    const requests = await reg.purgeRequestsFor(m.id);
    const selfRequested = requests.some((r) => r.isSelf);

    if (selfKeeper) {
      // Keeper reviews & executes (re-verifies its archive at approval time).
      const others = requests.filter((r) => !r.isSelf).map((r) => r.name);
      const label = others.length
        ? `Approve & purge (suggested by ${others.join(", ")})`
        : "Purge synced shards";
      const purge = box.createEl("button", { text: label });
      purge.style.marginLeft = "6px";
      purge.disabled = !gate.canPurge;
      purge.onclick = async () => {
        const ok = window.confirm(
          `Purge the synced shards for "${m.originalPath}"?\n\n` +
            "This device (a keeper) will re-verify its archive, then delete the shards on ALL " +
            "devices (Sync propagates it). The reconstructed file and your archive stay put."
        );
        if (!ok) return;
        const res = await reg.approveAndPurge(m);
        new Notice(res.ok ? "Purged synced shards — space reclaimed." : `Not purged: ${res.reason}`);
        this.render();
      };
    } else {
      // Non-keeper devices can only suggest; a keeper must approve.
      if (selfRequested) {
        const cancel = box.createEl("button", { text: "Cancel purge suggestion" });
        cancel.style.marginLeft = "6px";
        cancel.onclick = async () => {
          await reg.cancelPurgeRequest(m.id);
          this.render();
        };
      } else {
        const suggest = box.createEl("button", { text: "Suggest purge to keeper" });
        suggest.style.marginLeft = "6px";
        suggest.disabled = !s.shardsComplete;
        suggest.onclick = async () => {
          await reg.requestPurge(m.id);
          new Notice("Purge suggested — a keeper device must review and approve it.");
          this.render();
        };
      }
    }

    const status = box.createEl("div");
    status.style.marginTop = "4px";
    status.style.color = gate.canPurge ? "var(--text-success, var(--text-muted))" : "var(--text-muted)";
    const reqNote = requests.length
      ? ` · suggested by: ${requests.map((r) => r.name + (r.isSelf ? " (this)" : "")).join(", ")}`
      : "";
    status.setText(
      (gate.canPurge
        ? "✓ Safe to purge — every active device holds the file and a keeper has archived it."
        : `Not safe to purge yet — ${gate.reasons.join(" · ")}`) + reqNote
    );
  }

  /** Per-split device holdings: who has the full file, who's a keeper. */
  private async renderDevices(row: HTMLElement, manifestId: string): Promise<void> {
    const devices = await this.plugin.registry.deviceStatesFor(manifestId);
    const line = row.createEl("div");
    line.style.fontSize = "12px";
    line.style.color = "var(--text-muted)";
    line.style.marginTop = "2px";
    if (devices.length === 0) {
      line.setText("On devices: (no device has checked in yet)");
      return;
    }
    const participating = devices.filter((d) => !d.optedOut);
    const have = participating.filter((d) => d.hasOriginal).length;
    const optedOut = devices.length - participating.length;
    line.createSpan({
      text: `On ${have}/${participating.length} device(s)${optedOut ? ` · ${optedOut} opted out` : ""}: `,
    });
    devices.forEach((d, i) => {
      if (i > 0) line.createSpan({ text: ", " });
      const mark = d.optedOut ? "⊘ " : d.hasOriginal ? "✓ " : "· ";
      const label =
        mark + d.name + (d.isSelf ? " (this)" : "") + (d.keeper ? " ★" : "") + (d.optedOut ? " (opted out)" : "");
      const span = line.createSpan({ text: label });
      if (d.hasOriginal && !d.optedOut) span.style.color = "var(--text-normal)";
    });
  }

  /** Vault size overview: largest file + how close things are to the threshold. */
  private renderOverview(root: HTMLElement): void {
    const r = this.plugin.registry.largeFilesReport();
    const wrap = root.createDiv();

    const h = wrap.createEl("h3", { text: "Largest files in your vault" });
    h.style.margin = "4px 0";

    const summary = wrap.createDiv();
    summary.style.fontSize = "12px";
    summary.style.color = "var(--text-muted)";
    summary.style.marginBottom = "8px";
    if (!r.largest) {
      summary.setText("No files found in this vault.");
      return;
    }
    const pct = Math.round((r.largest.size / r.threshold) * 100);
    summary.setText(
      `Largest: ${humanBytes(r.largest.size)} (${pct}% of the ${humanBytes(
        r.threshold
      )} threshold) · ${r.overThreshold} at/over threshold · ${r.nearThreshold} within 50% · ${
        r.totalFiles
      } files total`
    );

    const table = wrap.createEl("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";
    for (const f of r.files) {
      const tr = table.createEl("tr");
      const over = f.size >= r.threshold;
      const near = !over && f.size >= r.threshold * 0.5;

      const name = tr.createEl("td", { text: f.path });
      name.style.width = "100%"; // take all remaining width
      name.style.padding = "2px 6px 2px 0";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";
      name.title = f.path; // full path on hover

      const size = tr.createEl("td", { text: humanBytes(f.size) });
      size.style.textAlign = "right";
      size.style.whiteSpace = "nowrap";
      size.style.width = "1%"; // shrink to content
      size.style.padding = "2px 6px";

      const tag = tr.createEl("td");
      tag.style.textAlign = "right";
      tag.style.whiteSpace = "nowrap";
      tag.style.width = "1%"; // shrink to content
      if (over) {
        tag.setText("⬆ over");
        tag.style.color = "var(--text-accent)";
      } else if (near) {
        tag.setText("~ close");
        tag.style.color = "var(--text-warning, var(--text-muted))";
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
