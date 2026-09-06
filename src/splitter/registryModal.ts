import { App, Modal, Notice } from "obsidian";
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

// Injected once (this plugin ships no styles.css — the release uploads only
// main.js + manifest.json — so component CSS is a <style> element added at
// runtime, scoped under .sync-sentinel-registry). Widening the modal + wrapping
// every path is what kills the old horizontal-scroll problem.
const STYLE_ID = "sync-sentinel-registry-styles";
const STYLES = `
.sync-sentinel-registry.modal { width: min(1000px, 94vw); }
.sync-sentinel-registry .modal-content { max-height: 78vh; overflow-y: auto; overflow-x: hidden; }
.ssr-toolbar {
  position: sticky; top: 0; z-index: 3;
  display: flex; flex-wrap: wrap; gap: 8px;
  padding: 4px 0 10px; margin-bottom: 4px;
  background: var(--modal-background, var(--background-primary));
  border-bottom: 1px solid var(--background-modifier-border);
}
.ssr-toolbar button { margin: 0; }
.ssr-section { margin: 16px 0 4px; }
.ssr-section-title { margin: 0 0 6px; font-size: var(--h4-size, 1.05em); font-weight: 600; }
.ssr-section-title.is-alert { color: var(--text-error); }
.ssr-sub { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
.ssr-card {
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px; padding: 10px 12px; margin: 8px 0;
  background: var(--background-secondary);
}
.ssr-card.is-alert { border-color: var(--text-error); }
.ssr-path { font-weight: 600; overflow-wrap: anywhere; word-break: break-word; line-height: 1.35; }
.ssr-meta {
  font-size: 12px; color: var(--text-muted); margin-top: 3px;
  display: flex; flex-wrap: wrap; gap: 2px 10px;
}
.ssr-devices { font-size: 12px; color: var(--text-muted); margin-top: 4px; overflow-wrap: anywhere; }
.ssr-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ssr-actions button { margin: 0; }
.ssr-note { font-size: 12px; color: var(--text-warning, var(--text-muted)); margin-top: 6px; overflow-wrap: anywhere; }
.ssr-space {
  margin-top: 8px; padding-top: 8px; font-size: 12px;
  border-top: 1px dashed var(--background-modifier-border);
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
}
.ssr-space button { margin: 0; }
.ssr-space-status { flex-basis: 100%; margin-top: 2px; }
.ssr-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
.ssr-table td { padding: 2px 0; vertical-align: top; }
.ssr-table td.ssr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px; }
.ssr-table td.ssr-num { text-align: right; white-space: nowrap; width: 74px; }
.ssr-table td.ssr-tag { text-align: right; white-space: nowrap; width: 64px; }
.ssr-empty { font-size: 13px; color: var(--text-muted); margin: 6px 0; }
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLES;
  document.head.appendChild(el);
}

export class RegistryModal extends Modal {
  constructor(app: App, private plugin: SyncSentinelPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    injectStyles();
    this.modalEl.addClass("sync-sentinel-registry");
    this.titleEl.setText("Sync Sentinel — command center");
    await this.render();
  }

  /** A titled section wrapper. Returns the body element to fill. */
  private section(root: HTMLElement, title: string, opts: { alert?: boolean; sub?: string } = {}): HTMLElement {
    const wrap = root.createDiv({ cls: "ssr-section" });
    const h = wrap.createDiv({ cls: "ssr-section-title", text: title });
    if (opts.alert) h.addClass("is-alert");
    if (opts.sub) wrap.createDiv({ cls: "ssr-sub", text: opts.sub });
    return wrap;
  }

  /** Make a button that runs `fn` then re-renders. */
  private actionBtn(parent: HTMLElement, label: string, fn: () => Promise<unknown> | unknown): HTMLButtonElement {
    const b = parent.createEl("button", { text: label });
    b.onclick = async () => {
      await fn();
      this.render();
    };
    return b;
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const toolbar = contentEl.createDiv({ cls: "ssr-toolbar" });
    this.actionBtn(toolbar, "Refresh", () => {});
    this.actionBtn(toolbar, "Reconstruct all", () => this.plugin.registry.reconstructAll());
    this.actionBtn(toolbar, "Split all large files", () => this.plugin.registry.scanAndAutoSplit());

    // Attention-first ordering: things needing action float to the top.
    this.renderBlanked(contentEl);
    this.renderEditConflicts(contentEl);
    this.renderOverview(contentEl);
    this.renderValidation(contentEl);

    const sec = this.section(contentEl, "Tracked splits");
    const statuses = await this.plugin.registry.statuses();
    if (statuses.length === 0) {
      sec.createDiv({
        cls: "ssr-empty",
        text: "No split files tracked yet. Split a large file to get started.",
      });
      return;
    }

    for (const s of statuses) {
      const card = sec.createDiv({ cls: "ssr-card" });
      if (s.state === "conflict") card.addClass("is-alert");

      card.createDiv({ cls: "ssr-path", text: s.manifest.originalPath });

      const meta = card.createDiv({ cls: "ssr-meta" });
      meta.createSpan({ text: STATE_LABEL[s.state] });
      meta.createSpan({ text: humanBytes(s.manifest.originalSize) });
      meta.createSpan({ text: `${s.manifest.shards.length} shards` });
      meta.createSpan({ text: `from ${s.manifest.host}` });

      await this.renderDevices(card, s.manifest.id);

      const actions = card.createDiv({ cls: "ssr-actions" });

      if (s.state === "ready-to-merge") {
        this.actionBtn(actions, "Reconstruct", () => this.plugin.registry.reconstruct(s.manifest));
      }
      if (s.state === "conflict") {
        card.createDiv({
          cls: "ssr-note",
          text: s.conflictFile
            ? `A synced copy is saved as “${s.conflictFile.split("/").pop()}” for you to compare.`
            : "Local file differs from the synced shards.",
        });
        this.actionBtn(actions, "Use synced version", async () => {
          await this.plugin.registry.resolveUseSynced(s.manifest);
          new Notice("Replaced local with the synced version.");
        });
        this.actionBtn(actions, "Keep local (re-split)", async () => {
          await this.plugin.registry.resolveKeepLocal(s.manifest);
          new Notice("Kept local file; shards re-generated from it.");
        });
        if (s.conflictFile) {
          this.actionBtn(actions, "Open synced copy", () =>
            this.app.workspace.openLinkText(s.conflictFile as string, "", true)
          );
        } else {
          this.actionBtn(actions, "Save synced copy to compare", async () => {
            const p = await this.plugin.registry.writeConflictFile(s.manifest);
            new Notice(p ? "Saved synced copy." : "Could not save (shards incomplete).");
          });
        }
      }
      if (s.state === "synced") {
        this.actionBtn(actions, "Re-split (refresh shards)", () =>
          this.plugin.registry.splitVaultFile(s.manifest.originalPath, { force: true })
        );
      }
      this.actionBtn(actions, "Forget", async () => {
        await this.plugin.registry.forget(s.manifest.id);
        new Notice("Forgot split (original left untouched).");
      });

      await this.renderSpace(card, s);
    }
  }

  /** Keeper archive + gated purge controls for reclaiming space. */
  private async renderSpace(card: HTMLElement, s: RegistryEntryStatus): Promise<void> {
    const reg = this.plugin.registry;
    const m = s.manifest;
    const devices = await reg.deviceStatesFor(m.id);
    const self = devices.find((d) => d.isSelf);
    const selfKeeper = !!self?.keeper;
    const selfOptedOut = !!self?.optedOut;
    const selfArchivedValid = self?.archivedSha === m.originalSha256;
    const gate = await reg.purgeGate(m);

    const box = card.createDiv({ cls: "ssr-space" });

    if (selfOptedOut) {
      box.createSpan({
        cls: "ssr-space-status",
        text: "This device opted out of this file (won't hold it; excluded from the purge gate).",
      });
      this.actionBtn(box, "Opt back in", () => reg.setOptedOut(m.id, false));
      return;
    }

    this.actionBtn(box, selfKeeper ? "Unset keeper (this device)" : "Make this device a keeper", () =>
      reg.setKeeper(m.id, !selfKeeper)
    );

    const optOut = this.actionBtn(box, "Opt out on this device", async () => {
      const ok = window.confirm(
        `Opt this device out of "${m.originalPath}"?\n\n` +
          "It won't auto-reconstruct here and won't count toward the purge gate. Any local " +
          "keeper role for this file is dropped. You can opt back in later."
      );
      if (ok) await reg.setOptedOut(m.id, true);
    });
    optOut.title = "This device won't hold this file; it stops blocking the purge gate.";

    if (selfKeeper && s.shardsComplete && !selfArchivedValid) {
      this.actionBtn(box, "Archive shards locally", async () => {
        const ok = await reg.archiveShards(m);
        new Notice(
          ok
            ? "Archived shards to the excluded folder (verified)."
            : "Archive failed — shards incomplete or verification mismatch. Not marked as archived."
        );
      });
    }

    if (!s.shardsComplete && (await reg.hasLocalArchive(m))) {
      this.actionBtn(box, "Re-share shards from archive", async () => {
        const ok = await reg.reShareFromArchive(m);
        new Notice(ok ? "Re-shared shards to the synced folder." : "No local archive to re-share.");
      });
    }

    const requests = await reg.purgeRequestsFor(m.id);
    const selfRequested = requests.some((r) => r.isSelf);

    if (selfKeeper) {
      const others = requests.filter((r) => !r.isSelf).map((r) => r.name);
      const label = others.length
        ? `Approve & purge (suggested by ${others.join(", ")})`
        : "Purge synced shards";
      const purge = this.actionBtn(box, label, async () => {
        const ok = window.confirm(
          `Purge the synced shards for "${m.originalPath}"?\n\n` +
            "This device (a keeper) will re-verify its archive, then delete the shards on ALL " +
            "devices (Sync propagates it). The reconstructed file and your archive stay put."
        );
        if (!ok) return;
        const res = await reg.approveAndPurge(m);
        new Notice(res.ok ? "Purged synced shards — space reclaimed." : `Not purged: ${res.reason}`);
      });
      purge.disabled = !gate.canPurge;
    } else if (selfRequested) {
      this.actionBtn(box, "Cancel purge suggestion", () => reg.cancelPurgeRequest(m.id));
    } else {
      const suggest = this.actionBtn(box, "Suggest purge to keeper", async () => {
        await reg.requestPurge(m.id);
        new Notice("Purge suggested — a keeper device must review and approve it.");
      });
      suggest.disabled = !s.shardsComplete;
    }

    const reqNote = requests.length
      ? ` · suggested by: ${requests.map((r) => r.name + (r.isSelf ? " (this)" : "")).join(", ")}`
      : "";
    const status = box.createDiv({ cls: "ssr-space-status" });
    status.style.color = gate.canPurge ? "var(--text-success, var(--text-muted))" : "var(--text-muted)";
    status.setText(
      (gate.canPurge
        ? "✓ Safe to purge — every active device holds the file and a keeper has archived it."
        : `Not safe to purge yet — ${gate.reasons.join(" · ")}`) + reqNote
    );
  }

  /** Per-split device holdings: who has the full file, who's a keeper. */
  private async renderDevices(card: HTMLElement, manifestId: string): Promise<void> {
    const devices = await this.plugin.registry.deviceStatesFor(manifestId);
    const line = card.createDiv({ cls: "ssr-devices" });
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
    if (!r.largest) {
      this.section(root, "Largest files in your vault", { sub: "No files found in this vault." });
      return;
    }
    const pct = Math.round((r.largest.size / r.threshold) * 100);
    const wrap = this.section(root, "Largest files in your vault", {
      sub:
        `Largest: ${humanBytes(r.largest.size)} (${pct}% of the ${humanBytes(r.threshold)} threshold) · ` +
        `${r.overThreshold} at/over threshold · ${r.nearThreshold} within 50% · ${r.totalFiles} files total`,
    });

    const table = wrap.createEl("table", { cls: "ssr-table" });
    for (const f of r.files) {
      const tr = table.createEl("tr");
      const over = f.size >= r.threshold;
      const near = !over && f.size >= r.threshold * 0.5;

      const name = tr.createEl("td", { cls: "ssr-name", text: f.path });
      name.title = f.path; // full path on hover

      tr.createEl("td", { cls: "ssr-num", text: humanBytes(f.size) });

      const tag = tr.createEl("td", { cls: "ssr-tag" });
      if (over) {
        tag.setText("⬆ over");
        tag.style.color = "var(--text-accent)";
      } else if (near) {
        tag.setText("~ close");
        tag.style.color = "var(--text-warning, var(--text-muted))";
      }
    }
  }

  /** Notes detected as blanked (network-drive glitch) that can be rescued. */
  private renderBlanked(root: HTMLElement): void {
    const blanked = [...this.plugin.recovery.blanked.values()];
    if (blanked.length === 0) return;
    const wrap = this.section(root, `⚠ Blanked notes — recoverable (${blanked.length})`, {
      alert: true,
      sub: "These open notes were wiped to empty (a network/cloud-drive glitch). Their last good version is remembered locally.",
    });
    this.actionBtn(wrap, "Rescue all now", () => this.plugin.recovery.rescueOpenTabs());
    for (const b of blanked) {
      const card = wrap.createDiv({ cls: "ssr-card is-alert" });
      card.createDiv({ cls: "ssr-path", text: b.path });
      const btns = card.createDiv({ cls: "ssr-actions" });
      this.actionBtn(btns, "Restore last good", () => this.plugin.recovery.restoreLatestHealthy(b.path));
      this.actionBtn(btns, "Review history", () => this.plugin.openHistory(b.path));
    }
  }

  /** Flagged sync-conflict pairs the weaver could not (or may not) auto-merge. */
  private renderEditConflicts(root: HTMLElement): void {
    const flagged = [...this.plugin.weaver.flagged.values()];
    if (flagged.length === 0) return;
    const wrap = this.section(root, `Edit conflicts needing review (${flagged.length})`, { alert: true });
    const REASON: Record<string, string> = {
      "no-base": "no common ancestor known — can't 3-way merge",
      overlap: "both devices edited the same lines",
      binary: "not a mergeable text file",
      "missing-original": "conflict copy has no original beside it",
    };
    for (const f of flagged) {
      const card = wrap.createDiv({ cls: "ssr-card" });
      card.createDiv({ cls: "ssr-path", text: f.originalPath });
      card.createDiv({
        cls: "ssr-meta",
        text:
          REASON[f.reason] +
          (f.conflicts ? ` (${f.conflicts} overlapping region${f.conflicts === 1 ? "" : "s"})` : ""),
      });
      const btns = card.createDiv({ cls: "ssr-actions" });
      if (f.reason === "overlap" || f.reason === "no-base") {
        this.actionBtn(btns, "Merge with markers", () => this.plugin.weaver.applyWithMarkers(f));
      }
      this.actionBtn(btns, "Keep this device's", () => this.plugin.weaver.keepLocal(f));
      this.actionBtn(btns, "Take synced copy", () => this.plugin.weaver.takeConflict(f));
      this.actionBtn(btns, "Open both", async () => {
        await this.app.workspace.openLinkText(f.originalPath, "", true);
        await this.app.workspace.openLinkText(f.conflictPath, "", true);
      });
    }
  }

  /** Result of the last "Validate keeper archives" run, if any. */
  private renderValidation(root: HTMLElement): void {
    const rep = this.plugin.lastValidation;
    if (!rep) return;
    const wrap = this.section(root, "Archive validation", {
      sub: `Checked ${new Date(rep.checkedAt).toLocaleString()} — archive vs synced shards, hash-verified.`,
    });
    if (rep.rows.length === 0 && rep.orphanedArchiveSets.length === 0) {
      wrap.createDiv({ cls: "ssr-empty", text: "Nothing tracked to validate." });
      return;
    }
    const cell = (x: { present: number; total: number; badHash: number }) =>
      `${x.present}/${x.total}${x.badHash ? ` (${x.badHash} corrupt!)` : ""}`;
    for (const r of rep.rows) {
      const row = wrap.createDiv({ cls: "ssr-devices" });
      row.style.color = r.ok ? "var(--text-muted)" : "var(--text-error)";
      row.setText(
        `${r.ok ? "✓" : "✗"} ${r.originalPath} — synced ${cell(r.synced)}, ` +
          (r.archived ? `archived ${cell(r.archived)}` : "no local archive")
      );
    }
    for (const o of rep.orphanedArchiveSets) {
      const row = wrap.createDiv({ cls: "ssr-devices" });
      row.style.color = "var(--text-warning)";
      row.setText(`⚠ orphaned archive set "${o}" — no matching manifest (safe to review & remove by hand)`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
