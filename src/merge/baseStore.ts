// Ancestor base store — the memory that makes three-way merging possible.
//
// Snapshots text files as they change into `<archiveFolder>/_bases/` (blobs
// content-addressed by SHA-256, one shared index). That folder is already
// excluded from sync (the keeper-archive folder: Obsidian Sync exclusion is a
// one-time user step; Syncthing mode manages `.stignore` automatically), so
// snapshots stay local per device — each device remembers the versions IT saw,
// which is exactly what a merge base needs.
//
// Load-notice discipline: ALL I/O goes through `app.vault.adapter` and hashing
// uses Web Crypto (`crypto.subtle`) — this module never loads a Node package,
// so passive snapshotting can't trigger Obsidian's "attempted to load nodeJS
// package" notice.
import type { App } from "obsidian";
import { warn } from "../util/log";
import type { SyncSentinelSettings } from "../types";

function vJoin(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface Snap {
  /** ms timestamp when this content was observed. */
  t: number;
  /** SHA-256 of the content (blob name). */
  h: string;
  /** Recorded as a likely blanking/corruption event — never a base or target. */
  suspicious?: boolean;
}

interface BaseIndex {
  v: 1;
  files: Record<string, { snaps: Snap[] }>;
}

/** Extensions we treat as mergeable text. */
export const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "canvas", "csv", "yml", "yaml", "org", "tex",
]);
/** Don't snapshot / merge files larger than this (line-merge on huge files is unwise). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// Snapshot compaction (count-shaping, NOT age deletion — that's the opt-in
// retention purge). Every save is snapshotted immediately (the only way to
// leave no race window against a sync clobber), so a typing session produces
// many near-duplicate versions. Compaction keeps the newest few densely and
// thins older ones to one per time bucket, so the burst noise collapses while
// meaningful ancestors survive.
const KEEP_RECENT_SNAPS = 5;
const THIN_BUCKET_MS = 10 * 60_000;
const MAX_SNAPS_PER_FILE = 40;

export class BaseStore {
  private index: BaseIndex | null = null;
  private saveTimer: number | null = null;

  constructor(private app: App, private getSettings: () => SyncSentinelSettings) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }
  private get root(): string {
    return vJoin(this.s.archiveFolder, "_bases");
  }
  private get blobDir(): string {
    return vJoin(this.root, "blobs");
  }
  private get indexPath(): string {
    return vJoin(this.root, "index.json");
  }
  /** Where pre-merge copies of resolved conflict files are preserved. */
  get resolvedDir(): string {
    return vJoin(this.root, "resolved");
  }

  static isTextPath(path: string, size: number): boolean {
    if (size > MAX_TEXT_BYTES) return false;
    const dot = path.lastIndexOf(".");
    if (dot < 0) return false;
    return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
  }

  private async loadIndex(): Promise<BaseIndex> {
    if (this.index) return this.index;
    const ad = this.app.vault.adapter;
    try {
      if (await ad.exists(this.indexPath)) {
        const parsed = JSON.parse(await ad.read(this.indexPath)) as BaseIndex;
        if (parsed && parsed.v === 1 && parsed.files) {
          this.index = parsed;
          return parsed;
        }
      }
    } catch (e) {
      warn("base index unreadable, starting fresh:", e);
    }
    this.index = { v: 1, files: {} };
    return this.index;
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveIndex();
    }, 2000);
  }

  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    const ad = this.app.vault.adapter;
    try {
      await ad.mkdir(this.root).catch(() => {});
      await ad.write(this.indexPath, JSON.stringify(this.index));
    } catch (e) {
      warn("base index save failed:", e);
    }
  }

  /** Flush any pending index write (call from onunload). */
  async flush(): Promise<void> {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveIndex();
  }

  /**
   * Record the current content of `path` as an ancestor candidate. Dedups by
   * hash (an unchanged save costs one hash, no write). `t` should be the
   * file's mtime when known — merge-base selection compares against mtimes.
   */
  async snapshot(
    path: string,
    content: string,
    t: number,
    opts: { suspicious?: boolean } = {}
  ): Promise<void> {
    const idx = await this.loadIndex();
    const h = await sha256Hex(content);
    const entry = (idx.files[path] ??= { snaps: [] });
    const last = entry.snaps[entry.snaps.length - 1];
    if (last && last.h === h) {
      // Same content as the newest snapshot. If it was previously recorded as
      // healthy and this observation is suspicious (or vice-versa), keep the
      // SAFER label: once a blank is flagged suspicious, a later identical
      // healthy-looking write shouldn't un-flag it — but a healthy version must
      // never inherit a suspicious flag. So only ever ADD suspicion, and only
      // when the incoming observation is itself suspicious.
      if (opts.suspicious && !last.suspicious) last.suspicious = true;
      return;
    }
    const ad = this.app.vault.adapter;
    const blobPath = vJoin(this.blobDir, h);
    try {
      if (!(await ad.exists(blobPath))) {
        await ad.mkdir(this.blobDir).catch(() => {});
        await ad.write(blobPath, content);
      }
    } catch (e) {
      warn("base blob write failed:", path, e);
      return; // don't index a blob we failed to write
    }
    const snap: Snap = { t, h };
    if (opts.suspicious) snap.suspicious = true;
    entry.snaps.push(snap);
    await this.compact(entry);
    this.scheduleSave();
  }

  /**
   * Newest NON-suspicious snapshot content for a path — the "last known good"
   * version to restore to. Returns null when the only history is suspicious or
   * there's nothing at all.
   */
  async newestHealthy(path: string): Promise<{ t: number; text: string } | null> {
    const idx = await this.loadIndex();
    const snaps = idx.files[path]?.snaps ?? [];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].suspicious) continue;
      const text = await this.readBlob(snaps[i].h);
      if (text !== null) return { t: snaps[i].t, text };
    }
    return null;
  }

  /**
   * Compact one file's snapshot list: the newest KEEP_RECENT_SNAPS survive
   * unconditionally; older snaps are thinned to the newest one per
   * THIN_BUCKET_MS bucket; a hard cap bounds the total. Dropped snaps' blobs
   * are deleted ONLY when no file references them anymore (content-addressing
   * is shared across files).
   */
  private async compact(entry: { snaps: Snap[] }): Promise<void> {
    if (entry.snaps.length <= KEEP_RECENT_SNAPS) return;
    const recent = entry.snaps.slice(-KEEP_RECENT_SNAPS);
    const older = entry.snaps.slice(0, -KEEP_RECENT_SNAPS);
    const byBucket = new Map<number, Snap>();
    for (const s of older) {
      const bucket = Math.floor(s.t / THIN_BUCKET_MS);
      const cur = byBucket.get(bucket);
      // Prefer a HEALTHY representative over a suspicious one regardless of
      // recency — thinning must never drop the last good version in a bucket in
      // favour of a newer blank. Within the same suspicion class, newest wins.
      if (!cur) {
        byBucket.set(bucket, s);
      } else if (!!cur.suspicious !== !!s.suspicious) {
        if (cur.suspicious) byBucket.set(bucket, s); // s is healthy, cur isn't
      } else if (s.t > cur.t) {
        byBucket.set(bucket, s);
      }
    }
    let thinned = [...byBucket.values()].sort((a, b) => a.t - b.t);
    if (thinned.length + recent.length > MAX_SNAPS_PER_FILE) {
      thinned = thinned.slice(thinned.length + recent.length - MAX_SNAPS_PER_FILE);
    }
    const keep = [...thinned, ...recent];
    const dropped = entry.snaps.filter((s) => !keep.includes(s));
    entry.snaps = keep;
    if (dropped.length) await this.gcBlobs(dropped.map((s) => s.h));
  }

  /** Delete blobs that no snapshot (of ANY file) references anymore. */
  private async gcBlobs(candidates: string[]): Promise<void> {
    const idx = await this.loadIndex();
    const live = new Set<string>();
    for (const e of Object.values(idx.files)) for (const s of e.snaps) live.add(s.h);
    const ad = this.app.vault.adapter;
    for (const h of new Set(candidates)) {
      if (live.has(h)) continue;
      await ad.remove(vJoin(this.blobDir, h)).catch(() => {});
    }
  }

  /** SHA-256 of a text, hex — same hashing the snapshot index uses. */
  static hashText(text: string): Promise<string> {
    return sha256Hex(text);
  }

  /**
   * Best merge base for `path`: the NEWEST snapshot observed at-or-before
   * `beforeMs` (i.e. before the two variants diverged). Returns its content,
   * or null when we have no usable ancestor.
   *
   * `excludeHash` (the CURRENT local content's hash) is critical for
   * correctness, not an optimization: every save is snapshotted immediately,
   * so the local edit's own snapshot always sits at t == the local mtime —
   * inside the divergence bound. Chosen as base, it makes the merge read as
   * "local never advanced" and silently take the remote copy, losing the
   * local edit. Excluding it forces a genuinely older ancestor; in the true
   * fast-forward case the older base still yields the right outcome (the
   * remote side carries those same changes, which collapse as identical).
   */
  async findBase(
    path: string,
    beforeMs: number,
    excludeHash?: string
  ): Promise<{ t: number; text: string } | null> {
    const idx = await this.loadIndex();
    const entry = idx.files[path];
    if (!entry || entry.snaps.length === 0) return null;
    let best: Snap | null = null;
    for (const s of entry.snaps) {
      if (s.h === excludeHash) continue;
      if (s.suspicious) continue; // a blanked version is never a valid ancestor
      if (s.t <= beforeMs && (!best || s.t > best.t)) best = s;
    }
    if (!best) return null;
    try {
      const text = await this.app.vault.adapter.read(vJoin(this.blobDir, best.h));
      return { t: best.t, text };
    } catch {
      return null;
    }
  }

  /** All snapshots recorded for a path, oldest → newest (index-only). */
  async listSnapshots(path: string): Promise<Snap[]> {
    const idx = await this.loadIndex();
    return [...(idx.files[path]?.snaps ?? [])];
  }

  /** Read one snapshot's content by hash, or null if the blob is gone. */
  async readBlob(hash: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(vJoin(this.blobDir, hash));
    } catch {
      return null;
    }
  }

  /** Does this path have any ancestor snapshot yet? (index-only, no reads) */
  async hasAnySnapshot(path: string): Promise<boolean> {
    const idx = await this.loadIndex();
    return (idx.files[path]?.snaps.length ?? 0) > 0;
  }

  /**
   * Seed pass: snapshot every mergeable text file that has NO ancestor yet, so
   * the FIRST conflict after enabling the feature is still mergeable. Cheap on
   * every boot after the first (index lookup per file, no reads for files
   * already covered). Returns how many files were seeded.
   */
  async seedMissing(
    files: Array<{ path: string; size: number; mtime: number }>,
    read: (path: string) => Promise<string>
  ): Promise<number> {
    let n = 0;
    for (const f of files) {
      if (!BaseStore.isTextPath(f.path, f.size)) continue;
      if (await this.hasAnySnapshot(f.path)) continue;
      try {
        await this.snapshot(f.path, await read(f.path), f.mtime);
        n++;
      } catch (e) {
        warn("seed snapshot failed:", f.path, e);
      }
    }
    return n;
  }

  /** Preserve a copy of a conflict file before it's resolved away. */
  async preserveResolved(name: string, content: string): Promise<void> {
    const ad = this.app.vault.adapter;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      await ad.mkdir(this.resolvedDir).catch(() => {});
      await ad.write(vJoin(this.resolvedDir, `${stamp}__${name}`), content);
    } catch (e) {
      warn("preserveResolved failed:", name, e);
    }
  }

  /**
   * Age-based pruning — called ONLY by the opt-in retention purge. Removes
   * snapshots older than `ageMs` (always keeping each file's newest snapshot,
   * so a merge base survives even for rarely-edited files), then deletes any
   * blob no snapshot references. Returns counts for reporting.
   */
  async pruneOlderThan(ageMs: number, dryRun: boolean): Promise<{ snaps: number; blobs: number; resolved: number }> {
    const idx = await this.loadIndex();
    const cutoff = Date.now() - ageMs;
    let snapsRemoved = 0;
    const live = new Set<string>();
    for (const [p, entry] of Object.entries(idx.files)) {
      const keep = entry.snaps.filter(
        (s, i) => s.t >= cutoff || i === entry.snaps.length - 1
      );
      snapsRemoved += entry.snaps.length - keep.length;
      if (!dryRun) {
        entry.snaps = keep;
        if (keep.length === 0) delete idx.files[p];
      }
      for (const s of keep) live.add(s.h);
    }
    const ad = this.app.vault.adapter;
    let blobsRemoved = 0;
    try {
      if (await ad.exists(this.blobDir)) {
        const listed = await ad.list(this.blobDir);
        for (const f of listed.files) {
          const h = f.slice(f.lastIndexOf("/") + 1);
          if (!live.has(h)) {
            blobsRemoved++;
            if (!dryRun) await ad.remove(f).catch(() => {});
          }
        }
      }
    } catch (e) {
      warn("blob prune failed:", e);
    }
    // Resolved-conflict copies: name-stamped with an ISO date; prune by that.
    let resolvedRemoved = 0;
    try {
      if (await ad.exists(this.resolvedDir)) {
        const listed = await ad.list(this.resolvedDir);
        for (const f of listed.files) {
          const st = await ad.stat(f).catch(() => null);
          if (st && st.mtime < cutoff) {
            resolvedRemoved++;
            if (!dryRun) await ad.remove(f).catch(() => {});
          }
        }
      }
    } catch (e) {
      warn("resolved prune failed:", e);
    }
    if (!dryRun) this.scheduleSave();
    return { snaps: snapsRemoved, blobs: blobsRemoved, resolved: resolvedRemoved };
  }
}
