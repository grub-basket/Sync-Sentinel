// Manages split manifests and orchestrates split/reconstruct against the vault.
//
// IMPORTANT (no-Node-on-idle): Obsidian shows a notification every time a plugin
// require()s a Node package. So all LIGHT work here — listing/reading manifests,
// existence/size checks, status, cleanup — goes through Obsidian's vault adapter
// (Obsidian core touches the disk, not us). Node `fs` is reached ONLY inside the
// streaming split/merge engine, which runs solely when there is a real big file
// to process. A plain reload with nothing to do triggers zero Node loads.
import { App, DataAdapter, Notice, TFile } from "obsidian";
import { copyAtomic, hashFile, hashString, isSafeShardName, isSafeVaultRel } from "../util/fsutil";
import { log, warn, error } from "../util/log";
import type { DeviceFile, SplitManifest, SyncSentinelSettings } from "../types";
import { mergeShards, splitFile } from "./splitter";

// --- pure (Node-free) vault path helpers ---
function vJoin(...parts: string[]): string {
  return parts
    .filter((p) => p && p.length)
    .join("/")
    .replace(/\/{2,}/g, "/");
}
function vBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function vDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function vExtname(p: string): string {
  const base = vBasename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export interface RegistryEntryStatus {
  manifest: SplitManifest;
  originalPresent: boolean;
  originalMatches: boolean; // size matches manifest
  shardsComplete: boolean;
  state: "synced" | "ready-to-merge" | "conflict" | "missing-shards" | "split-here";
  /** vault-relative path of a materialized conflict file, if one exists. */
  conflictFile?: string;
}

export class SplitRegistry {
  /** Paths we just wrote, with a timestamp — to ignore our own vault events. */
  private recentWrites = new Map<string, number>();
  private static SELF_WRITE_GRACE_MS = 10_000;

  constructor(
    private app: App,
    private base: string,
    private getSettings: () => SyncSentinelSettings
  ) {}

  private get s(): SyncSentinelSettings {
    return this.getSettings();
  }

  private get adapter(): DataAdapter {
    return this.app.vault.adapter;
  }

  // --- self-write guard ---

  markWrite(vaultRel: string): void {
    this.recentWrites.set(vaultRel, Date.now());
    if (this.recentWrites.size > 128) {
      const cutoff = Date.now() - SplitRegistry.SELF_WRITE_GRACE_MS;
      for (const [k, t] of this.recentWrites) if (t < cutoff) this.recentWrites.delete(k);
    }
  }

  isRecentWrite(vaultRel: string): boolean {
    const t = this.recentWrites.get(vaultRel);
    return t != null && Date.now() - t < SplitRegistry.SELF_WRITE_GRACE_MS;
  }

  // --- paths ---

  private manifestDirVault(): string {
    return vJoin(this.s.shardFolder, "manifests");
  }
  private shardSetDirVault(id: string): string {
    return vJoin(this.s.shardFolder, id);
  }
  private manifestPathVault(id: string): string {
    return vJoin(this.manifestDirVault(), `${id}.json`);
  }

  /** Absolute FS path — ONLY for the streaming engine (heavy ops). Loads Node `path`. */
  private absFromVault(vaultRel: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");
    return path.join(this.base, ...vaultRel.split("/"));
  }

  idFor(vaultRel: string): string {
    return hashString(vaultRel).slice(0, 16); // heavy path only (split)
  }

  isExcluded(vaultRel: string): boolean {
    if (vaultRel.startsWith(this.s.shardFolder)) return true;
    if (this.s.archiveFolder && vaultRel.startsWith(this.s.archiveFolder)) return true;
    if (vaultRel.includes(".sscconflict-")) return true; // materialized conflict files
    return this.s.splitExcludes.some((x) => x && vaultRel.includes(x));
  }

  private conflictPathVault(manifest: SplitManifest): string {
    const p = manifest.originalPath;
    const ext = vExtname(p);
    const stem = p.slice(0, p.length - ext.length);
    return `${stem}.sscconflict-${manifest.host}-${manifest.updatedAt}${ext}`;
  }

  // --- manifest io (adapter) ---

  async readManifestVault(vaultRel: string): Promise<SplitManifest | null> {
    try {
      const raw = await this.adapter.read(vaultRel);
      const m = JSON.parse(raw) as SplitManifest;
      if (!m || m.version !== 1 || !Array.isArray(m.shards)) return null;
      // SECURITY: manifests are synced (untrusted) — block path traversal.
      if (!isSafeVaultRel(m.originalPath)) {
        warn("rejecting manifest with unsafe originalPath:", m.originalPath);
        return null;
      }
      if (!m.shards.every((sh) => isSafeShardName(sh.name))) {
        warn("rejecting manifest with unsafe shard name:", m.originalPath);
        return null;
      }
      return m;
    } catch {
      return null;
    }
  }

  async listManifests(): Promise<SplitManifest[]> {
    const dir = this.manifestDirVault();
    if (!(await this.adapter.exists(dir))) return [];
    let listed;
    try {
      listed = await this.adapter.list(dir);
    } catch {
      return [];
    }
    const out: SplitManifest[] = [];
    for (const f of listed.files) {
      if (!f.endsWith(".json")) continue;
      const m = await this.readManifestVault(f);
      if (m) out.push(m);
    }
    return out;
  }

  /** All shard files present? (adapter — light) */
  private async shardsPresentVault(manifest: SplitManifest): Promise<boolean> {
    const dir = this.shardSetDirVault(manifest.id);
    for (const sh of manifest.shards) {
      if (!(await this.adapter.exists(vJoin(dir, sh.name)))) return false;
    }
    return true;
  }

  // --- split (heavy: streams via Node) ---

  async splitVaultFile(
    vaultRel: string,
    opts: { force?: boolean; silent?: boolean } = {}
  ): Promise<SplitManifest | null> {
    if (this.isExcluded(vaultRel)) return null;
    const st = await this.adapter.stat(vaultRel);
    if (!st || st.type !== "file") {
      if (!opts.silent) new Notice(`Sync Sentinel: ${vaultRel} not found.`);
      return null;
    }

    const id = this.idFor(vaultRel);
    const manVault = this.manifestPathVault(id);
    const existing = await this.readManifestVault(manVault);

    if (
      existing &&
      !opts.force &&
      existing.originalSize === st.size &&
      Math.abs(existing.originalMtimeMs - st.mtime) < 1000
    ) {
      log("split skip (unchanged):", vaultRel);
      return existing;
    }

    const shardDirVault = this.shardSetDirVault(id);
    await this.adapter.rmdir(shardDirVault, true).catch(() => {});

    let lastPct = -1;
    const notice = opts.silent ? null : new Notice(`Splitting ${vBasename(vaultRel)}…`, 0);
    const result = await splitFile(
      this.absFromVault(vaultRel),
      this.absFromVault(shardDirVault),
      this.s.chunkSizeBytes,
      this.s.shardExtension,
      (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (notice && pct !== lastPct) {
          lastPct = pct;
          notice.setMessage(`Splitting ${vBasename(vaultRel)}… ${pct}%`);
        }
      }
    );

    const manifest: SplitManifest = {
      version: 1,
      id,
      originalPath: vaultRel,
      originalSize: result.originalSize,
      originalSha256: result.originalSha256,
      originalMtimeMs: st.mtime,
      chunkSizeBytes: this.s.chunkSizeBytes,
      shardExtension: this.s.shardExtension,
      shards: result.shards,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      host: this.hostName(),
    };
    await this.adapter.mkdir(this.manifestDirVault()).catch(() => {});
    await this.adapter.write(manVault, JSON.stringify(manifest, null, 2));

    if (this.s.removeOriginalAfterSplit) {
      const ok = await this.verifyShards(manifest);
      if (ok) {
        await this.adapter.remove(vaultRel).catch((e) => warn("remove original:", e));
        log("removed original after verified split:", vaultRel);
      } else {
        warn("shard verification failed; keeping original:", vaultRel);
        if (notice) notice.setMessage("Split verify failed — original kept.");
      }
    }

    await this.ackOriginalPresent(id); // this device holds the original it split
    notice?.hide();
    if (!opts.silent)
      new Notice(`Split ${vBasename(vaultRel)} into ${manifest.shards.length} shards.`);
    return manifest;
  }

  private hostName(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("os").hostname();
    } catch {
      return "unknown-host";
    }
  }

  /** Verify shards reassemble to the manifest hash (heavy). */
  private async verifyShards(manifest: SplitManifest): Promise<boolean> {
    const shardDirAbs = this.absFromVault(this.shardSetDirVault(manifest.id));
    const tmp = this.absFromVault(vJoin(this.shardSetDirVault(manifest.id), ".verify.tmp"));
    try {
      await mergeShards(shardDirAbs, manifest.shards, tmp, manifest.originalSha256);
      await this.adapter
        .remove(vJoin(this.shardSetDirVault(manifest.id), ".verify.tmp"))
        .catch(() => {});
      return true;
    } catch (e) {
      warn("verifyShards:", e);
      await this.adapter
        .remove(vJoin(this.shardSetDirVault(manifest.id), ".verify.tmp"))
        .catch(() => {});
      return false;
    }
  }

  // --- reconstruct (scan light; merge heavy) ---

  async reconstruct(
    manifest: SplitManifest,
    opts: { force?: boolean; silent?: boolean } = {}
  ): Promise<boolean> {
    const destVault = manifest.originalPath;
    const st = await this.adapter.stat(destVault);
    if (st && !opts.force) {
      if (st.size === manifest.originalSize) {
        await this.ackOriginalPresent(manifest.id); // record we hold it
        return false;
      }
      const policy = this.s.conflictPolicy;
      if (policy === "newest-wins") {
        if (manifest.updatedAt > st.mtime) {
          log("conflict: manifest newer, overwriting local:", destVault);
          // fall through to overwrite
        } else {
          log("conflict: local newer, re-splitting:", destVault);
          await this.splitVaultFile(destVault, { force: true, silent: true });
          return false;
        }
      } else if (policy === "conflict-file") {
        await this.writeConflictFile(manifest);
        return false;
      } else {
        warn("reconstruct: original differs — conflict, skipping:", destVault);
        return false;
      }
    }
    if (!(await this.shardsPresentVault(manifest))) {
      log("reconstruct: shards incomplete:", destVault);
      return false;
    }

    const notice = opts.silent ? null : new Notice(`Reconstructing ${vBasename(destVault)}…`, 0);
    this.markWrite(destVault); // suppress our own modify echo (no re-split loop)
    try {
      await mergeShards(
        this.absFromVault(this.shardSetDirVault(manifest.id)),
        manifest.shards,
        this.absFromVault(destVault),
        manifest.originalSha256,
        (done, total) => {
          if (notice)
            notice.setMessage(
              `Reconstructing ${vBasename(destVault)}… ${Math.floor((done / total) * 100)}%`
            );
        }
      );
      notice?.hide();
      await this.ackOriginalPresent(manifest.id);
      if (!opts.silent) new Notice(`Reconstructed ${vBasename(destVault)}.`);
      return true;
    } catch (e) {
      notice?.hide();
      error("reconstruct failed:", e);
      if (!opts.silent)
        new Notice(`Sync Sentinel: reconstruct failed — ${(e as Error).message}`);
      return false;
    }
  }

  async reconstructAll(opts: { silent?: boolean } = {}): Promise<number> {
    const manifests = await this.listManifests();
    const own = await this.readOwnDevice();
    let n = 0;
    for (const m of manifests) {
      if (own.files[m.id]?.optedOut) continue; // don't auto-fetch opted-out files
      if (await this.reconstruct(m, { silent: true })) n++;
    }
    if (!opts.silent && n > 0) new Notice(`Sync Sentinel: reconstructed ${n} file(s).`);
    return n;
  }

  async scanAndAutoSplit(opts: { silent?: boolean } = {}): Promise<number> {
    const files = this.app.vault.getFiles();
    let n = 0;
    for (const f of files) {
      if (this.isExcluded(f.path)) continue;
      if (f.stat.size < this.s.splitThresholdBytes) continue;
      if (await this.splitVaultFile(f.path, { silent: true })) n++;
    }
    if (!opts.silent) new Notice(`Sync Sentinel: split ${n} large file(s).`);
    return n;
  }

  // --- status for UI (adapter — light) ---

  async statuses(): Promise<RegistryEntryStatus[]> {
    const manifests = await this.listManifests();
    const out: RegistryEntryStatus[] = [];
    for (const m of manifests) {
      const st = await this.adapter.stat(m.originalPath);
      const shardsComplete = await this.shardsPresentVault(m);
      const originalPresent = !!st && st.type === "file";
      const originalMatches = !!st && st.size === m.originalSize;
      let state: RegistryEntryStatus["state"];
      if (originalPresent && originalMatches) state = "synced";
      else if (originalPresent && !originalMatches) state = "conflict";
      else if (!originalPresent && shardsComplete) state = "ready-to-merge";
      else state = "missing-shards";
      const cf = this.conflictPathVault(m);
      const conflictFile = (await this.adapter.exists(cf)) ? cf : undefined;
      out.push({ manifest: m, originalPresent, originalMatches, shardsComplete, state, conflictFile });
    }
    return out;
  }

  /**
   * Ranked view of the biggest files in the vault (via the Obsidian file cache —
   * no Node, no disk walk), so the user can see what's near the split threshold.
   */
  largeFilesReport(limit = 25): {
    threshold: number;
    largest: { path: string; size: number } | null;
    overThreshold: number;
    nearThreshold: number;
    totalFiles: number;
    files: { path: string; size: number }[];
  } {
    const threshold = this.s.splitThresholdBytes;
    const near = threshold * 0.5;
    const all = this.app.vault
      .getFiles()
      .filter((f) => !this.isExcluded(f.path))
      .map((f) => ({ path: f.path, size: f.stat.size }))
      .sort((a, b) => b.size - a.size);
    return {
      threshold,
      largest: all.length ? all[0] : null,
      overThreshold: all.filter((f) => f.size >= threshold).length,
      nearThreshold: all.filter((f) => f.size >= near && f.size < threshold).length,
      totalFiles: all.length,
      files: all.slice(0, limit),
    };
  }

  async forget(id: string): Promise<void> {
    await this.adapter.rmdir(this.shardSetDirVault(id), true).catch(() => {});
    await this.adapter.remove(this.manifestPathVault(id)).catch(() => {});
  }

  // --- device ledger (synced, conflict-free: each device owns one file) ---

  /** Stable per-install id, kept in vault-scoped localStorage (never synced). */
  deviceId(): string {
    const k = `sync-sentinel-device-id:${this.app.vault.getName()}`;
    let id = window.localStorage.getItem(k);
    if (!id) {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      window.localStorage.setItem(k, id);
    }
    return id;
  }

  deviceName(): string {
    const k = `sync-sentinel-device-name:${this.app.vault.getName()}`;
    return window.localStorage.getItem(k) || `Device-${this.deviceId().slice(0, 5)}`;
  }

  async setDeviceName(name: string): Promise<void> {
    const k = `sync-sentinel-device-name:${this.app.vault.getName()}`;
    window.localStorage.setItem(k, name.trim() || `Device-${this.deviceId().slice(0, 5)}`);
    // Reflect the new name into our synced ledger file.
    await this.updateOwnDevice(() => true);
  }

  private devicesDirVault(): string {
    return vJoin(this.s.shardFolder, "devices");
  }
  private deviceFilePathVault(deviceId: string): string {
    return vJoin(this.devicesDirVault(), `${deviceId}.json`);
  }

  private async readDeviceFile(vaultPath: string): Promise<DeviceFile | null> {
    try {
      const raw = await this.adapter.read(vaultPath);
      const d = JSON.parse(raw) as DeviceFile;
      if (d && typeof d.deviceId === "string" && d.files) return d;
      return null;
    } catch {
      return null;
    }
  }

  private async readOwnDevice(): Promise<DeviceFile> {
    const existing = await this.readDeviceFile(this.deviceFilePathVault(this.deviceId()));
    return (
      existing || {
        deviceId: this.deviceId(),
        deviceName: this.deviceName(),
        updatedAt: 0,
        files: {},
      }
    );
  }

  /** Apply a mutation to our own device file; write only if it reports a change. */
  private async updateOwnDevice(mut: (d: DeviceFile) => boolean): Promise<void> {
    const d = await this.readOwnDevice();
    d.deviceName = this.deviceName();
    const changed = mut(d);
    if (!changed && d.updatedAt !== 0) return;
    d.updatedAt = Date.now();
    await this.adapter.mkdir(this.devicesDirVault()).catch(() => {});
    await this.adapter.write(
      this.deviceFilePathVault(this.deviceId()),
      JSON.stringify(d, null, 2)
    );
    this.invalidateDevices();
  }

  /** Record that this device now holds the full original for a split. */
  async ackOriginalPresent(manifestId: string): Promise<void> {
    await this.updateOwnDevice((d) => {
      const st = (d.files[manifestId] ??= {});
      if (st.optedOut) return false; // opted out — don't claim to hold it
      if (st.originalAt) return false;
      st.originalAt = Date.now();
      return true;
    });
  }

  async isSelfOptedOut(manifestId: string): Promise<boolean> {
    const own = await this.readOwnDevice();
    return !!own.files[manifestId]?.optedOut;
  }

  /** Opt this device in/out of holding a file. Opting out clears our held/keeper claims. */
  async setOptedOut(manifestId: string, optedOut: boolean): Promise<void> {
    await this.updateOwnDevice((d) => {
      const st = (d.files[manifestId] ??= {});
      if (!!st.optedOut === optedOut) return false;
      st.optedOut = optedOut;
      if (optedOut) {
        delete st.originalAt;
        delete st.keeper;
        delete st.archivedAt;
        delete st.archivedSha;
        delete st.purgeRequested;
      }
      return true;
    });
  }

  async setKeeper(manifestId: string, keeper: boolean): Promise<void> {
    await this.updateOwnDevice((d) => {
      const st = (d.files[manifestId] ??= {});
      if (!!st.keeper === keeper) return false;
      st.keeper = keeper;
      return true;
    });
  }

  /** Record presence for every split whose original is already here (load sweep). */
  async ackPresentOriginals(): Promise<void> {
    for (const m of await this.listManifests()) {
      const st = await this.adapter.stat(m.originalPath);
      if (st && st.type === "file" && st.size === m.originalSize) {
        await this.ackOriginalPresent(m.id);
      }
    }
  }

  private devicesCache: { t: number; data: DeviceFile[] } | null = null;
  /** Drop the device-ledger cache (call when device files change, e.g. via sync). */
  invalidateDevices(): void {
    this.devicesCache = null;
  }

  /** All device ledger files (including ours). Cached briefly to avoid re-reads per render. */
  async listDevices(): Promise<DeviceFile[]> {
    if (this.devicesCache && Date.now() - this.devicesCache.t < 1500) {
      return this.devicesCache.data;
    }
    const data = await this.listDevicesUncached();
    this.devicesCache = { t: Date.now(), data };
    return data;
  }

  private async listDevicesUncached(): Promise<DeviceFile[]> {
    const dir = this.devicesDirVault();
    if (!(await this.adapter.exists(dir))) {
      const own = await this.readOwnDevice();
      return own.updatedAt ? [own] : [];
    }
    let listed;
    try {
      listed = await this.adapter.list(dir);
    } catch {
      return [];
    }
    const out: DeviceFile[] = [];
    for (const f of listed.files) {
      if (!f.endsWith(".json")) continue;
      const d = await this.readDeviceFile(f);
      if (d) out.push(d);
    }
    return out;
  }

  /** Per-device holdings for a given split, for the command center. */
  async deviceStatesFor(manifestId: string): Promise<
    {
      deviceId: string;
      name: string;
      hasOriginal: boolean;
      keeper: boolean;
      archivedSha?: string;
      optedOut: boolean;
      isSelf: boolean;
    }[]
  > {
    const self = this.deviceId();
    const devices = await this.listDevices();
    return devices
      .map((d) => {
        const st = d.files[manifestId] || {};
        return {
          deviceId: d.deviceId,
          name: d.deviceName || d.deviceId.slice(0, 5),
          hasOriginal: !!st.originalAt,
          keeper: !!st.keeper,
          archivedSha: st.archivedSha,
          optedOut: !!st.optedOut,
          isSelf: d.deviceId === self,
        };
      })
      .sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.name.localeCompare(b.name)));
  }

  // --- Phase 2: keeper archive + space reclaim ---

  private archiveSetDirVault(id: string): string {
    return vJoin(this.s.archiveFolder, id);
  }

  /**
   * Keeper action: copy the synced shards into the excluded archive folder, then
   * VERIFY the copies by hash before acking. The archive can never be checked by
   * another device (it's excluded from Sync), so the only trustworthy ack is one
   * this device writes after verifying its own copy. Returns false (no ack) on
   * any mismatch. (heavy)
   */
  async archiveShards(manifest: SplitManifest): Promise<boolean> {
    if (!(await this.shardsPresentVault(manifest))) return false;
    const srcDir = this.shardSetDirVault(manifest.id);
    const dstDir = this.archiveSetDirVault(manifest.id);
    for (const sh of manifest.shards) {
      await copyAtomic(
        this.absFromVault(vJoin(srcDir, sh.name)),
        this.absFromVault(vJoin(dstDir, sh.name))
      );
    }
    // Verify every archived shard reassembles to what the manifest promises.
    for (const sh of manifest.shards) {
      const h = await hashFile(this.absFromVault(vJoin(dstDir, sh.name))).catch(() => "");
      if (h !== sh.sha256) {
        warn("archive verification failed for", sh.name, "— not acking archive");
        return false;
      }
    }
    // Keep a manifest copy alongside the archive so a keeper can re-seed later.
    await this.adapter.write(vJoin(dstDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await this.updateOwnDevice((d) => {
      const st = (d.files[manifest.id] ??= {});
      st.keeper = true;
      st.archivedAt = Date.now();
      st.archivedSha = manifest.originalSha256;
      return true;
    });
    return true;
  }

  /**
   * Keep our own archive acks honest: if a file we claim to have archived is no
   * longer present locally (deleted/corrupt), retract the ack so the purge gate
   * re-closes. Presence-only (adapter, no Node) so it's cheap to run on load.
   */
  async auditOwnArchives(): Promise<void> {
    const own = await this.readOwnDevice();
    const retractArchive: string[] = [];
    const clearRequest: string[] = [];
    for (const [id, st] of Object.entries(own.files)) {
      const m = await this.readManifestVault(this.manifestPathVault(id));
      if (st.keeper && st.archivedSha && (!m || !(await this.hasLocalArchive(m)))) {
        retractArchive.push(id);
      }
      // Drop our own purge suggestion once the shards are actually gone or unknown.
      if (st.purgeRequested && (!m || !(await this.shardsPresentVault(m)))) {
        clearRequest.push(id);
      }
    }
    if (retractArchive.length || clearRequest.length) {
      await this.updateOwnDevice((d) => {
        for (const id of retractArchive) {
          const st = d.files[id];
          if (st) {
            delete st.archivedSha;
            delete st.archivedAt;
          }
        }
        for (const id of clearRequest) delete d.files[id]?.purgeRequested;
        return true;
      });
      if (retractArchive.length) warn("retracted stale archive acks:", retractArchive);
    }
  }

  /** Is a valid (current) archive of this split present locally? */
  async hasLocalArchive(manifest: SplitManifest): Promise<boolean> {
    const dir = this.archiveSetDirVault(manifest.id);
    for (const sh of manifest.shards) {
      if (!(await this.adapter.exists(vJoin(dir, sh.name)))) return false;
    }
    return true;
  }

  /** Keeper action: copy archived shards back into the synced folder to re-seed (heavy). */
  async reShareFromArchive(manifest: SplitManifest): Promise<boolean> {
    if (!(await this.hasLocalArchive(manifest))) return false;
    const srcDir = this.archiveSetDirVault(manifest.id);
    const dstDir = this.shardSetDirVault(manifest.id);
    for (const sh of manifest.shards) {
      await copyAtomic(
        this.absFromVault(vJoin(srcDir, sh.name)),
        this.absFromVault(vJoin(dstDir, sh.name))
      );
    }
    return true;
  }

  /** Whether it's safe to purge the synced shards, with human-readable reasons. */
  async purgeGate(manifest: SplitManifest): Promise<{
    canPurge: boolean;
    shardsPresent: boolean;
    activeCount: number;
    waitingOn: string[];
    keepers: string[];
    keepersUnarchived: string[];
    reasons: string[];
  }> {
    const id = manifest.id;
    const shardsPresent = await this.shardsPresentVault(manifest);
    const devices = await this.listDevices();
    const activeMs = this.s.activeDeviceDays * 86_400_000;
    const active = devices.filter((d) => Date.now() - d.updatedAt < activeMs);
    // Devices that opted out of this file don't need it and don't block the gate.
    const waitingOn = active
      .filter((d) => !d.files[id]?.originalAt && !d.files[id]?.optedOut)
      .map((d) => d.deviceName);
    const keepers = active.filter((d) => d.files[id]?.keeper);
    const keepersUnarchived = keepers
      .filter((d) => d.files[id]?.archivedSha !== manifest.originalSha256)
      .map((d) => d.deviceName);
    const reasons: string[] = [];
    if (!shardsPresent) reasons.push("shards already purged or incomplete");
    if (waitingOn.length) reasons.push(`waiting on: ${waitingOn.join(", ")}`);
    if (keepers.length === 0) reasons.push("no keeper designated");
    if (keepersUnarchived.length) reasons.push(`keeper not archived: ${keepersUnarchived.join(", ")}`);
    const canPurge =
      shardsPresent && waitingOn.length === 0 && keepers.length > 0 && keepersUnarchived.length === 0;
    return {
      canPurge,
      shardsPresent,
      activeCount: active.length,
      waitingOn,
      keepers: keepers.map((k) => k.deviceName),
      keepersUnarchived,
      reasons,
    };
  }

  /** Delete the synced shard set (propagates to all devices). Gated. */
  async purgeSyncedShards(manifest: SplitManifest): Promise<boolean> {
    const gate = await this.purgeGate(manifest);
    if (!gate.canPurge) return false;
    await this.adapter.rmdir(this.shardSetDirVault(manifest.id), true).catch(() => {});
    return true;
  }

  // --- purge suggestion → keeper review workflow ---

  /** Is this device a keeper for the given split? */
  async isSelfKeeper(manifestId: string): Promise<boolean> {
    const own = await this.readOwnDevice();
    return !!own.files[manifestId]?.keeper;
  }

  /** A non-keeper device suggests purging; queued for keeper review. */
  async requestPurge(manifestId: string): Promise<void> {
    await this.updateOwnDevice((d) => {
      const st = (d.files[manifestId] ??= {});
      st.purgeRequested = Date.now();
      return true;
    });
  }

  async cancelPurgeRequest(manifestId: string): Promise<void> {
    await this.updateOwnDevice((d) => {
      const st = d.files[manifestId];
      if (!st || !st.purgeRequested) return false;
      delete st.purgeRequested;
      return true;
    });
  }

  /** Pending purge suggestions for a split (from any active device). */
  async purgeRequestsFor(
    manifestId: string
  ): Promise<{ name: string; at: number; isSelf: boolean }[]> {
    const self = this.deviceId();
    const activeMs = this.s.activeDeviceDays * 86_400_000;
    const devices = await this.listDevices();
    return devices
      .filter((d) => d.files[manifestId]?.purgeRequested && Date.now() - d.updatedAt < activeMs)
      .map((d) => ({
        name: d.deviceName || d.deviceId.slice(0, 5),
        at: d.files[manifestId]!.purgeRequested!,
        isSelf: d.deviceId === self,
      }));
  }

  /** How many splits this (keeper) device has a pending purge suggestion to review. */
  async pendingKeeperApprovals(): Promise<number> {
    const own = await this.readOwnDevice();
    const devices = await this.listDevices();
    const activeMs = this.s.activeDeviceDays * 86_400_000;
    let n = 0;
    for (const [id, st] of Object.entries(own.files)) {
      if (!st.keeper) continue;
      const requested = devices.some(
        (d) =>
          d.deviceId !== own.deviceId &&
          d.files[id]?.purgeRequested &&
          Date.now() - d.updatedAt < activeMs
      );
      if (requested) n++;
    }
    return n;
  }

  /** Fresh hash re-verification of this device's local archive (heavy). */
  async verifyLocalArchive(manifest: SplitManifest): Promise<boolean> {
    const dir = this.archiveSetDirVault(manifest.id);
    for (const sh of manifest.shards) {
      if (!(await this.adapter.exists(vJoin(dir, sh.name)))) return false;
      const h = await hashFile(this.absFromVault(vJoin(dir, sh.name))).catch(() => "");
      if (h !== sh.sha256) return false;
    }
    return true;
  }

  /**
   * Keeper approval path: re-verify our own archive by hash RIGHT NOW, confirm the
   * gate, then purge. If our archive fails re-verification, retract the ack instead
   * of purging (so we never delete synced shards while our archive is bad).
   */
  async approveAndPurge(manifest: SplitManifest): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.isSelfKeeper(manifest.id))) {
      return { ok: false, reason: "This device is not a keeper for this file." };
    }
    if (!(await this.verifyLocalArchive(manifest))) {
      await this.updateOwnDevice((d) => {
        const st = d.files[manifest.id];
        if (st) {
          delete st.archivedSha;
          delete st.archivedAt;
        }
        return true;
      });
      return { ok: false, reason: "Local archive failed re-verification — ack retracted, re-archive first." };
    }
    const gate = await this.purgeGate(manifest);
    if (!gate.canPurge) return { ok: false, reason: gate.reasons.join(" · ") };
    await this.adapter.rmdir(this.shardSetDirVault(manifest.id), true).catch(() => {});
    // Clear our own outstanding request, if any.
    await this.cancelPurgeRequest(manifest.id);
    return { ok: true };
  }

  // --- conflict handling ---

  /** Materialize the synced (shard) version as a separate conflict file (heavy). */
  async writeConflictFile(manifest: SplitManifest): Promise<string | null> {
    const cfVault = this.conflictPathVault(manifest);
    if (await this.adapter.exists(cfVault)) return cfVault;
    if (!(await this.shardsPresentVault(manifest))) return null;
    try {
      await mergeShards(
        this.absFromVault(this.shardSetDirVault(manifest.id)),
        manifest.shards,
        this.absFromVault(cfVault),
        manifest.originalSha256
      );
      log("wrote conflict file:", cfVault);
      return cfVault;
    } catch (e) {
      warn("writeConflictFile failed:", e);
      return null;
    }
  }

  async resolveUseSynced(manifest: SplitManifest): Promise<boolean> {
    const ok = await this.reconstruct(manifest, { force: true, silent: true });
    if (ok) await this.deleteConflictFiles(manifest);
    return ok;
  }

  async resolveKeepLocal(manifest: SplitManifest): Promise<void> {
    await this.splitVaultFile(manifest.originalPath, { force: true, silent: true });
    await this.deleteConflictFiles(manifest);
  }

  async deleteConflictFiles(manifest: SplitManifest): Promise<void> {
    const ext = vExtname(manifest.originalPath);
    const stem = vBasename(manifest.originalPath.slice(0, manifest.originalPath.length - ext.length));
    const dir = vDirname(manifest.originalPath);
    if (!(await this.adapter.exists(dir || "/"))) return;
    let listed;
    try {
      listed = await this.adapter.list(dir);
    } catch {
      return;
    }
    const marker = `${stem}.sscconflict-`;
    for (const f of listed.files) {
      if (vBasename(f).startsWith(marker)) await this.adapter.remove(f).catch(() => {});
    }
  }

  // --- Syncthing mode: manage a .stignore block for local-only folders ---

  private static STIGNORE_START =
    "// >>> Sync Sentinel (managed) — excludes local-only folders; do not edit";
  private static STIGNORE_END = "// <<< Sync Sentinel";

  /**
   * Ensure/remove a managed `.stignore` block in the vault root so Syncthing
   * ignores the keeper archive folder (so purging synced shards can't touch it).
   * `include=false` removes the block. Returns the patterns written.
   */
  async updateStignore(include: boolean): Promise<string[]> {
    const p = ".stignore";
    let content = "";
    if (await this.adapter.exists(p)) content = await this.adapter.read(p).catch(() => "");

    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startEsc = esc(SplitRegistry.STIGNORE_START);
    const endEsc = esc(SplitRegistry.STIGNORE_END);
    content = content.replace(new RegExp(`\\n?${startEsc}[\\s\\S]*?${endEsc}\\n?`, "g"), "\n");

    const patterns: string[] = [];
    if (include && this.s.archiveFolder) {
      patterns.push("/" + this.s.archiveFolder.replace(/^\/+/, "").replace(/\/+$/, ""));
      const block =
        SplitRegistry.STIGNORE_START + "\n" + patterns.join("\n") + "\n" + SplitRegistry.STIGNORE_END + "\n";
      content = content.trimEnd() + (content.trim() ? "\n\n" : "") + block;
    }
    content = content.replace(/^\n+/, "");
    if (content.trim()) await this.adapter.write(p, content);
    else if (await this.adapter.exists(p)) await this.adapter.remove(p).catch(() => {});
    return patterns;
  }
}
