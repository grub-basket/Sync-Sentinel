// One-way snapshot backups of the vault to an external destination, with an
// optional AES-256-GCM encryption layer and generational retention.
import { App, Notice } from "obsidian";
import { fsp, path } from "../util/fsutil";
import { copyAtomic, ensureDir, exists, statSafe } from "../util/fsutil";
import { encryptFile } from "./crypto";
import { log, warn } from "../util/log";
import type { SyncSentinelSettings } from "../types";

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export class OneWayBackup {
  constructor(
    private app: App,
    private base: string,
    private getSettings: () => SyncSentinelSettings,
    private getKey: () => Buffer | null
  ) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }

  async run(opts: { silent?: boolean } = {}): Promise<string | null> {
    const s = this.s;
    if (!s.backupDestination) {
      if (!opts.silent)
        new Notice("Sync Sentinel: set a backup destination first.");
      return null;
    }
    let key: Buffer | null = null;
    if (s.backupEncrypt) {
      key = this.getKey();
      if (!key) {
        new Notice(
          "Sync Sentinel: encryption enabled but no key available — aborting backup."
        );
        return null;
      }
    }

    const genDir = path.join(s.backupDestination, `backup-${stamp(new Date())}`);
    await ensureDir(genDir);

    // For unencrypted backups we hardlink files unchanged since the previous
    // generation (same size+mtime), so each snapshot is cheap and dedup'd.
    // Hardlinks survive pruning: removing one generation just drops that link.
    const prevGen = key ? null : await this.latestGen(genDir);

    const files = this.app.vault.getFiles();
    const notice = opts.silent ? null : new Notice("Backing up…", 0);
    let n = 0;
    let linked = 0;
    for (const f of files) {
      const srcAbs = path.join(this.base, f.path);
      const stat = await statSafe(srcAbs);
      if (!stat) continue;
      try {
        if (key) {
          await encryptFile(srcAbs, path.join(genDir, f.path + ".sse"), key);
        } else {
          const destAbs = path.join(genDir, f.path);
          const reused = prevGen
            ? await this.tryHardlink(prevGen, f.path, destAbs, stat.size, stat.mtimeMs)
            : false;
          if (reused) linked++;
          else await copyAtomic(srcAbs, destAbs);
        }
        n++;
        if (notice && n % 25 === 0) notice.setMessage(`Backing up… ${n} files`);
      } catch (e) {
        warn("backup file failed:", f.path, e);
      }
    }
    // Write a small manifest describing the generation.
    await fsp.writeFile(
      path.join(genDir, ".sync-sentinel-backup.json"),
      JSON.stringify(
        {
          createdAt: Date.now(),
          encrypted: !!key,
          fileCount: n,
          vaultName: this.app.vault.getName(),
        },
        null,
        2
      )
    );

    await this.prune();
    notice?.hide();
    if (!opts.silent)
      new Notice(`Sync Sentinel: backed up ${n} files to ${path.basename(genDir)}.`);
    log("backup complete:", genDir, n, "files,", linked, "hardlinked");
    return genDir;
  }

  /** Most recent existing backup-* generation (excluding `exclude`), or null. */
  private async latestGen(exclude: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.s.backupDestination);
    } catch {
      return null;
    }
    const gens = entries
      .filter((e) => e.startsWith("backup-"))
      .filter((e) => path.join(this.s.backupDestination, e) !== exclude)
      .sort();
    if (gens.length === 0) return null;
    return path.join(this.s.backupDestination, gens[gens.length - 1]);
  }

  /** Hardlink from the previous generation if size+mtime match. */
  private async tryHardlink(
    prevGen: string,
    relPath: string,
    destAbs: string,
    size: number,
    mtimeMs: number
  ): Promise<boolean> {
    const prevAbs = path.join(prevGen, relPath);
    const pst = await statSafe(prevAbs);
    if (!pst || pst.size !== size || Math.abs(pst.mtimeMs - mtimeMs) >= 1000) {
      return false;
    }
    try {
      await ensureDir(path.dirname(destAbs));
      await fsp.link(prevAbs, destAbs);
      return true;
    } catch {
      return false;
    }
  }

  private async prune(): Promise<void> {
    const keep = this.s.backupKeep;
    if (keep <= 0) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.s.backupDestination);
    } catch {
      return;
    }
    const gens = entries
      .filter((e) => e.startsWith("backup-"))
      .sort(); // lexicographic == chronological for our stamp
    const excess = gens.slice(0, Math.max(0, gens.length - keep));
    for (const g of excess) {
      try {
        await fsp.rm(path.join(this.s.backupDestination, g), {
          recursive: true,
          force: true,
        });
        log("pruned old backup:", g);
      } catch (e) {
        warn("prune failed:", g, e);
      }
    }
  }
}
