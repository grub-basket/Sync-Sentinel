// Aggressively snapshots Obsidian's sync log to an external folder, so a sync
// problem can be diagnosed even after Obsidian rotates/truncates its own log.
import { App, Notice } from "obsidian";
import { fsp, path } from "../util/fsutil";
import { copyAtomic, ensureDir, exists, hashFile, statSafe } from "../util/fsutil";
import { log, warn } from "../util/log";
import type { SyncSentinelSettings } from "../types";

const KEEP_SNAPSHOTS = 50;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export class SyncLogArchiver {
  private lastHash = "";

  constructor(
    private app: App,
    private base: string,
    private getSettings: () => SyncSentinelSettings
  ) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }

  /** Best-effort auto-detection of the sync log path. */
  async detectLogPath(): Promise<string | null> {
    const configDir = (this.app.vault as any).configDir || ".obsidian";
    const candidates = [
      path.join(this.base, configDir, "sync.log"),
      path.join(this.base, configDir, "sync", "sync.log"),
      path.join(this.base, configDir, "workspace-sync.log"),
    ];
    for (const c of candidates) {
      if (await exists(c)) return c;
    }
    return null;
  }

  async run(opts: { silent?: boolean } = {}): Promise<boolean> {
    const s = this.s;
    let src = s.syncLogPath;
    if (!src) {
      const detected = await this.detectLogPath();
      if (!detected) {
        if (!opts.silent)
          new Notice(
            "Sync Sentinel: sync log not found — set its path manually in settings."
          );
        return false;
      }
      src = detected;
    }
    if (!s.syncLogDestination) {
      if (!opts.silent)
        new Notice("Sync Sentinel: set a sync-log archive destination.");
      return false;
    }
    const st = await statSafe(src);
    if (!st) {
      if (!opts.silent) new Notice("Sync Sentinel: sync log path not readable.");
      return false;
    }

    // Skip if unchanged since last snapshot.
    const h = await hashFile(src);
    if (h === this.lastHash) return false;
    this.lastHash = h;

    await ensureDir(s.syncLogDestination);
    const dest = path.join(
      s.syncLogDestination,
      `${stamp(new Date())}__${path.basename(src)}`
    );
    try {
      await copyAtomic(src, dest);
      await this.prune();
      log("sync log snapshotted:", dest);
      if (!opts.silent) new Notice("Sync Sentinel: sync log snapshotted.");
      return true;
    } catch (e) {
      warn("sync log snapshot failed:", e);
      return false;
    }
  }

  private async prune(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.s.syncLogDestination);
    } catch {
      return;
    }
    const snaps = entries.filter((e) => e.includes("__")).sort();
    const excess = snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS));
    for (const sName of excess) {
      try {
        await fsp.unlink(path.join(this.s.syncLogDestination, sName));
      } catch {
        /* ignore */
      }
    }
  }
}
