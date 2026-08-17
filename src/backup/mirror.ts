// Live on-disk safety mirror: copies recently-modified vault files into an
// external folder the user excludes from sync, keeping a short version history
// so a bad sync can't silently destroy recent work.
import { App, Notice } from "obsidian";
import { fsp, path } from "../util/fsutil";
import { copyAtomic, ensureDir, exists, statSafe } from "../util/fsutil";
import { log, warn } from "../util/log";
import type { SyncSentinelSettings } from "../types";

const KEEP_VERSIONS = 10;

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export class DiskMirror {
  /** path -> last mtimeMs we mirrored, to skip unchanged files. */
  private seen = new Map<string, number>();

  constructor(
    private app: App,
    private base: string,
    private getSettings: () => SyncSentinelSettings
  ) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }

  async run(opts: { silent?: boolean } = {}): Promise<number> {
    const s = this.s;
    if (!s.mirrorDestination) {
      if (!opts.silent)
        new Notice("Sync Sentinel: set a mirror destination first.");
      return 0;
    }
    const cutoff = Date.now() - s.mirrorRecentMinutes * 60_000;
    const files = this.app.vault.getFiles();
    let n = 0;
    for (const f of files) {
      if (f.path.startsWith(s.shardFolder)) continue;
      const srcAbs = path.join(this.base, f.path);
      const st = await statSafe(srcAbs);
      if (!st) continue;
      if (st.mtimeMs < cutoff) continue;
      if (this.seen.get(f.path) === st.mtimeMs) continue;

      // dest/<relpath>/<stamp>__<basename>
      const verDir = path.join(s.mirrorDestination, f.path);
      const verName = `${stamp(st.mtimeMs)}__${path.basename(f.path)}`;
      const destAbs = path.join(verDir, verName);
      if (await exists(destAbs)) {
        this.seen.set(f.path, st.mtimeMs);
        continue;
      }
      try {
        await copyAtomic(srcAbs, destAbs);
        this.seen.set(f.path, st.mtimeMs);
        await this.pruneVersions(verDir);
        n++;
      } catch (e) {
        warn("mirror copy failed:", f.path, e);
      }
    }
    if (!opts.silent) new Notice(`Sync Sentinel: mirrored ${n} recent file(s).`);
    if (n > 0) log("mirror pass copied", n, "files");
    return n;
  }

  private async pruneVersions(verDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(verDir);
    } catch {
      return;
    }
    const versions = entries.filter((e) => e.includes("__")).sort();
    const excess = versions.slice(0, Math.max(0, versions.length - KEEP_VERSIONS));
    for (const v of excess) {
      try {
        await fsp.unlink(path.join(verDir, v));
      } catch {
        /* ignore */
      }
    }
  }

  resetSeen(): void {
    this.seen.clear();
  }
}
