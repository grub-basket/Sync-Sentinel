// File recovery — protects against the network/cloud-drive glitch that blanks
// open notes' bodies while Obsidian is running. Built on the same local
// version-history snapshots as offline merge.
//
// Three jobs:
//   1. Baseline capture: snapshot a note's content when it's OPENED, so the
//      pre-blank version exists even if you never edit it this session (the
//      glitch hits open notes you may only be reading).
//   2. Blank detection: when a save wipes a note's body, record it as
//      "suspicious" (never a merge base / restore target), alert, and remember
//      which notes need rescue.
//   3. Restore INTO THE OPEN EDITOR, not just to disk — the blanked buffer is
//      still loaded, so writing the file underneath it would be re-saved as
//      blank. Setting the editor value replaces the buffer and persists.
import { App, MarkdownView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { BaseStore } from "./baseStore";
import { BLANK_MIN_PRIOR, bodyOf, looksBlank, nonWsLen } from "./blankDetect";
import { log, warn } from "../util/log";
import type { SyncSentinelSettings } from "../types";

export interface BlankedRecord {
  path: string;
  at: number;
  /** non-whitespace body length just before the blanking. */
  priorLen: number;
}

export class RecoveryService {
  /** Notes observed to have been blanked this session, keyed by path. */
  readonly blanked = new Map<string, BlankedRecord>();
  /** Last known-healthy non-ws body length per path (in-memory baseline). */
  private lastBodyLen = new Map<string, number>();

  constructor(
    private app: App,
    private bases: BaseStore,
    private getSettings: () => SyncSentinelSettings,
    private onChange: () => void
  ) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }

  private eligible(path: string, size: number): boolean {
    return (
      !path.startsWith(this.s.shardFolder) &&
      !path.startsWith(this.s.archiveFolder) &&
      BaseStore.isTextPath(path, size)
    );
  }

  /** Snapshot a file's current content as a healthy baseline (skips blanks). */
  async captureBaseline(file: TFile): Promise<void> {
    if (!this.eligible(file.path, file.stat.size)) return;
    try {
      const content = await this.app.vault.cachedRead(file);
      if (looksBlank(content)) return; // don't seed a baseline from an empty file
      this.lastBodyLen.set(file.path, nonWsLen(bodyOf(content)));
      await this.bases.snapshot(file.path, content, file.stat.mtime);
    } catch (e) {
      warn("baseline capture failed:", file.path, e);
    }
  }

  /** Snapshot every currently-open markdown note (call on layout ready). */
  async captureOpenTabs(): Promise<void> {
    for (const f of this.openMarkdownFiles()) await this.captureBaseline(f);
  }

  /**
   * Flag open notes that are ALREADY blank on disk (the glitch persisted across
   * a restart) but for which we hold a healthy version — so they surface for
   * rescue on load, not only when edited. Only flags when a restore is actually
   * possible, to avoid crying wolf over genuinely-empty notes.
   */
  async flagAlreadyBlankOpen(): Promise<void> {
    if (!this.s.blankGuardEnabled) return;
    for (const f of this.openMarkdownFiles()) {
      let content = "";
      try {
        content = await this.app.vault.cachedRead(f);
      } catch {
        continue;
      }
      if (!looksBlank(content)) continue;
      const healthy = await this.bases.newestHealthy(f.path);
      if (healthy && nonWsLen(bodyOf(healthy.text)) >= BLANK_MIN_PRIOR) {
        this.blanked.set(f.path, {
          path: f.path,
          at: Date.now(),
          priorLen: nonWsLen(bodyOf(healthy.text)),
        });
      }
    }
    if (this.blanked.size) this.onChange();
  }

  /**
   * Handle a modify event on a text file: snapshot it, detecting a blanking.
   * Returns true if this was treated as a blanking event.
   */
  async onModify(file: TFile): Promise<boolean> {
    if (!this.eligible(file.path, file.stat.size)) return false;
    let content: string;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (e) {
      warn("recovery read failed:", file.path, e);
      return false;
    }
    const newLen = nonWsLen(bodyOf(content));

    // Baseline for "what did this file hold before now": prefer the in-memory
    // last-known length, fall back to the newest healthy snapshot's body.
    let priorLen = this.lastBodyLen.get(file.path);
    if (priorLen == null) {
      const healthy = await this.bases.newestHealthy(file.path);
      priorLen = healthy ? nonWsLen(bodyOf(healthy.text)) : 0;
    }

    // A blanking is: guard on, body now empty, real content before.
    const blanking = this.s.blankGuardEnabled && newLen === 0 && priorLen >= BLANK_MIN_PRIOR;

    if (blanking) {
      // Record the blank as SUSPICIOUS: it stays in history for the record but
      // is never chosen as a merge base or a restore target.
      await this.bases.snapshot(file.path, content, file.stat.mtime, { suspicious: true });
      const had = this.blanked.get(file.path);
      this.blanked.set(file.path, {
        path: file.path,
        at: Date.now(),
        priorLen: had?.priorLen ?? priorLen,
      });
      // Do NOT update lastBodyLen — keep the healthy baseline so a second blank
      // is still measured against real content.
      this.onChange();
      log("blank detected:", file.path, "prior body len", priorLen);
      return true;
    }

    // Healthy write — snapshot and update the baseline.
    this.lastBodyLen.set(file.path, newLen);
    await this.bases.snapshot(file.path, content, file.stat.mtime);
    // A file that was blanked and is now non-blank again has recovered.
    if (newLen > 0 && this.blanked.has(file.path)) {
      this.blanked.delete(file.path);
      this.onChange();
    }
    return false;
  }

  /** After a blank pass, alert once if anything is newly blanked. */
  notifyIfBlanked(): void {
    const n = this.blanked.size;
    if (!n) return;
    new Notice(
      `Sync Sentinel: ${n} open note${n === 1 ? "" : "s"} went blank. ` +
        `Run "Rescue blanked notes now" (or the registry) to restore the last good version.`,
      12_000
    );
  }

  // --- restore ---

  /**
   * Restore `text` into `path`. If the note is open in an editor, replace the
   * EDITOR's content (so the loaded buffer can't re-save the blank over it);
   * otherwise write the file. Either way the healthy content gets re-snapshotted
   * through the normal modify path.
   */
  async restoreInto(path: string, text: string): Promise<void> {
    const leaf = this.markdownLeafFor(path);
    if (leaf && leaf.view instanceof MarkdownView && leaf.view.editor) {
      const view = leaf.view;
      view.editor.setValue(text);
      // setValue marks the view dirty; force a save NOW rather than waiting for
      // Obsidian's debounce, so the good content reaches disk promptly (matters
      // if the drive is still misbehaving). Then snapshot so it's in history.
      try {
        await view.save();
      } catch (e) {
        warn("restore save failed (editor still holds good content):", path, e);
      }
      this.lastBodyLen.set(path, nonWsLen(bodyOf(text)));
      await this.bases.snapshot(path, text, Date.now());
    } else {
      try {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.vault.modify(f, text);
        else await this.app.vault.adapter.write(path, text);
        this.lastBodyLen.set(path, nonWsLen(bodyOf(text)));
      } catch (e) {
        warn("restore write failed:", path, e);
        throw e; // let the caller surface it — nothing was cleared yet
      }
    }
    this.blanked.delete(path);
    this.onChange();
  }

  /** Restore one path to its newest healthy version. Returns false if none. */
  async restoreLatestHealthy(path: string): Promise<boolean> {
    const healthy = await this.bases.newestHealthy(path);
    if (!healthy) return false;
    await this.restoreInto(path, healthy.text);
    return true;
  }

  /**
   * Rescue every open note that currently looks blank and has a healthy
   * version to restore. Returns { restored, skipped } paths.
   */
  async rescueOpenTabs(): Promise<{ restored: string[]; skipped: string[] }> {
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const f of this.openMarkdownFiles()) {
      let content = "";
      try {
        content = await this.app.vault.cachedRead(f);
      } catch {
        /* fall through as blank */
      }
      if (!looksBlank(content)) continue; // only rescue notes that are blank now
      try {
        if (await this.restoreLatestHealthy(f.path)) restored.push(f.path);
        else skipped.push(f.path);
      } catch (e) {
        warn("rescue failed for", f.path, e);
        skipped.push(f.path);
      }
    }
    return { restored, skipped };
  }

  // --- workspace helpers ---

  private openMarkdownFiles(): TFile[] {
    const files: TFile[] = [];
    const seen = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && !seen.has(view.file.path)) {
        seen.add(view.file.path);
        files.push(view.file);
      }
    });
    return files;
  }

  private markdownLeafFor(path: string): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!found && view instanceof MarkdownView && view.file?.path === path) {
        found = leaf;
      }
    });
    return found;
  }
}
