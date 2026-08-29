// Conflict weaver — offline multi-device edit safety on Syncthing.
//
// Syncthing never merges: when two devices edit the same file offline, the
// losing copy lands next to the winner as `Name.sync-conflict-YYYYMMDD-HHMMSS-
// DEVICE.md`. This module detects those siblings and three-way merges them
// using an ancestor from the BaseStore, so edits made on different devices
// while offline CONVERGE instead of one silently "losing".
//
// Safety posture (the whole point of this plugin):
//   - Nothing is merged without a genuine common ancestor. No base → flagged
//     for the user, never guessed.
//   - Before ANY write, both variants are preserved (base store + resolved
//     copies). The conflict file goes to Obsidian's trash, not deletion.
//   - A dirty merge (true overlap) is never auto-applied; it's flagged, and
//     applying it with conflict markers is an explicit user action.
import { App, Notice, TFile } from "obsidian";
import { diff3 } from "./diff3";
import { BaseStore } from "./baseStore";
import { conflictOriginalPath, isSyncConflictPath } from "./conflictPatterns";
import { log, warn } from "../util/log";
import type { SyncSentinelSettings } from "../types";

export { conflictOriginalPath, isSyncConflictPath };

export interface FlaggedConflict {
  originalPath: string;
  conflictPath: string;
  reason: "no-base" | "overlap" | "binary" | "missing-original";
  /** For "overlap": how many conflicting regions diff3 found. */
  conflicts?: number;
  flaggedAt: number;
}

export class ConflictWeaver {
  /** Conflicts we could not (or may not) auto-merge, keyed by conflict path. */
  readonly flagged = new Map<string, FlaggedConflict>();

  constructor(
    private app: App,
    private bases: BaseStore,
    private getSettings: () => SyncSentinelSettings,
    /** Called after anything changes (merged or flagged) so UI can refresh. */
    private onChange: () => void
  ) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }

  /** Scan the whole vault for unresolved sync-conflict siblings. */
  async scan(opts: { silent?: boolean } = {}): Promise<number> {
    let merged = 0;
    for (const f of this.app.vault.getFiles()) {
      if (!isSyncConflictPath(f.path)) continue;
      if (await this.handleConflictFile(f.path)) merged++;
    }
    if (!opts.silent) {
      const open = this.flagged.size;
      new Notice(
        `Sync Sentinel: ${merged} conflict(s) auto-merged` +
          (open ? `, ${open} need review (see registry).` : ".")
      );
    }
    return merged;
  }

  /**
   * Try to resolve one conflict sibling. Returns true if it auto-merged
   * cleanly; false when flagged (or not a conflict file at all).
   */
  async handleConflictFile(conflictPath: string): Promise<boolean> {
    const originalPath = conflictOriginalPath(conflictPath);
    if (!originalPath) return false;
    const ad = this.app.vault.adapter;

    const conflictStat = await ad.stat(conflictPath).catch(() => null);
    if (!conflictStat) return false; // vanished (another device resolved it)

    if (!(await ad.exists(originalPath))) {
      this.flag(originalPath, conflictPath, "missing-original");
      return false;
    }
    const origStat = await ad.stat(originalPath).catch(() => null);
    if (!origStat) return false;

    if (
      !BaseStore.isTextPath(originalPath, origStat.size) ||
      !BaseStore.isTextPath(conflictPath, conflictStat.size)
    ) {
      this.flag(originalPath, conflictPath, "binary");
      return false;
    }

    const localText = await ad.read(originalPath);
    const otherText = await ad.read(conflictPath);

    const divergedBefore = Math.min(origStat.mtime, conflictStat.mtime);
    // Exclude the current local content from base candidacy — its own
    // snapshot always sits inside the bound and would masquerade as the
    // ancestor, turning the merge into a silent "take remote" (see findBase).
    const localHash = await BaseStore.hashText(localText);
    const base = await this.bases.findBase(originalPath, divergedBefore, localHash);
    if (!base) {
      this.flag(originalPath, conflictPath, "no-base");
      return false;
    }

    // Trivial cases first — no merge machinery needed.
    if (localText === otherText) {
      await this.finishResolve(originalPath, conflictPath, otherText, null);
      return true;
    }
    if (otherText === base.text) {
      // The conflict copy IS the ancestor — local simply moved ahead.
      await this.finishResolve(originalPath, conflictPath, otherText, null);
      return true;
    }
    if (localText === base.text) {
      // Local never advanced — the conflict copy is the only real edit.
      await this.finishResolve(originalPath, conflictPath, otherText, otherText);
      return true;
    }

    const r = diff3(base.text, localText, otherText, {
      local: "this device",
      other: "synced conflict copy",
    });
    if (r.clean && this.s.offlineMergeAuto) {
      await this.finishResolve(originalPath, conflictPath, otherText, r.text);
      log("auto-merged", conflictPath, "into", originalPath);
      return true;
    }
    this.flag(originalPath, conflictPath, "overlap", r.conflicts || undefined);
    return false;
  }

  /**
   * Apply a resolution: preserve the conflict copy, optionally rewrite the
   * original (`mergedText === null` keeps the original untouched), and trash
   * the conflict file (Obsidian trash — recoverable).
   */
  private async finishResolve(
    originalPath: string,
    conflictPath: string,
    conflictText: string,
    mergedText: string | null
  ): Promise<void> {
    const ad = this.app.vault.adapter;
    const name = conflictPath.slice(conflictPath.lastIndexOf("/") + 1);
    await this.bases.preserveResolved(name, conflictText);
    if (mergedText !== null) {
      // Preserve the pre-merge local too, then write the merged result and
      // remember it as the new ancestor for future merges.
      const localText = await ad.read(originalPath).catch(() => null);
      if (localText !== null && localText !== mergedText) {
        const origName = originalPath.slice(originalPath.lastIndexOf("/") + 1);
        await this.bases.preserveResolved(`premerge__${origName}`, localText);
      }
      await ad.write(originalPath, mergedText);
      await this.bases.snapshot(originalPath, mergedText, Date.now());
    }
    const cf = this.app.vault.getAbstractFileByPath(conflictPath);
    if (cf instanceof TFile) {
      await this.app.vault.trash(cf, false).catch((e) => warn("trash failed:", e));
    }
    this.flagged.delete(conflictPath);
    this.onChange();
  }

  private flag(
    originalPath: string,
    conflictPath: string,
    reason: FlaggedConflict["reason"],
    conflicts?: number
  ): void {
    const had = this.flagged.get(conflictPath);
    this.flagged.set(conflictPath, {
      originalPath,
      conflictPath,
      reason,
      conflicts,
      flaggedAt: had?.flaggedAt ?? Date.now(),
    });
    this.onChange();
  }

  // --- explicit user resolutions (from the registry UI) ---

  /** Write the diff3 result WITH conflict markers into the original. */
  async applyWithMarkers(f: FlaggedConflict): Promise<boolean> {
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(f.originalPath)) || !(await ad.exists(f.conflictPath))) return false;
    const localText = await ad.read(f.originalPath);
    const otherText = await ad.read(f.conflictPath);
    const origStat = await ad.stat(f.originalPath).catch(() => null);
    const confStat = await ad.stat(f.conflictPath).catch(() => null);
    const before = Math.min(origStat?.mtime ?? Date.now(), confStat?.mtime ?? Date.now());
    const localHash = await BaseStore.hashText(localText);
    const base = (await this.bases.findBase(f.originalPath, before, localHash))?.text ?? "";
    const r = diff3(base, localText, otherText, {
      local: "this device",
      other: "synced conflict copy",
    });
    await this.finishResolve(f.originalPath, f.conflictPath, otherText, r.text);
    return true;
  }

  /** Keep this device's version; preserve + trash the conflict copy. */
  async keepLocal(f: FlaggedConflict): Promise<void> {
    const ad = this.app.vault.adapter;
    const otherText = await ad.read(f.conflictPath).catch(() => null);
    if (otherText === null) {
      this.flagged.delete(f.conflictPath);
      this.onChange();
      return;
    }
    await this.finishResolve(f.originalPath, f.conflictPath, otherText, null);
  }

  /** Take the synced conflict copy as the new content of the original. */
  async takeConflict(f: FlaggedConflict): Promise<void> {
    const ad = this.app.vault.adapter;
    const otherText = await ad.read(f.conflictPath).catch(() => null);
    if (otherText === null) {
      this.flagged.delete(f.conflictPath);
      this.onChange();
      return;
    }
    await this.finishResolve(f.originalPath, f.conflictPath, otherText, otherText);
  }

  /** Drop a stale flag whose files no longer exist. */
  async pruneFlags(): Promise<void> {
    const ad = this.app.vault.adapter;
    for (const [k, f] of this.flagged) {
      if (!(await ad.exists(f.conflictPath))) this.flagged.delete(k);
    }
    this.onChange();
  }
}
