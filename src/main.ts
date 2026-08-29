import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  debounce,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  SyncSentinelSettings,
} from "./types";
import { setDebug, log, warn } from "./util/log";
import { SplitRegistry } from "./splitter/registry";
import type { ArchiveValidationReport } from "./splitter/registry";
import { OneWayBackup } from "./backup/oneway";
import { DiskMirror } from "./backup/mirror";
import { SyncLogArchiver } from "./backup/synclog";
import { KeyStore, KeyStoreData } from "./backup/keystore";
import { SyncSentinelSettingTab } from "./settings";
import { RegistryModal } from "./splitter/registryModal";
import { BaseStore } from "./merge/baseStore";
import { ConflictWeaver, isSyncConflictPath } from "./merge/conflictMerge";
import { HistoryModal } from "./merge/historyModal";
import { RecoveryService } from "./merge/recovery";

interface PersistedData {
  settings: SyncSentinelSettings;
  keystore?: KeyStoreData;
}

export default class SyncSentinelPlugin extends Plugin {
  settings!: SyncSentinelSettings;
  base!: string;

  registry!: SplitRegistry;
  backup!: OneWayBackup;
  mirror!: DiskMirror;
  syncLog!: SyncLogArchiver;
  keystore!: KeyStore;
  bases!: BaseStore;
  weaver!: ConflictWeaver;
  recovery!: RecoveryService;
  /** Last archive-validation report, for the registry modal. */
  lastValidation: ArchiveValidationReport | null = null;

  /** Is local version-history capture active? (its own setting, or implied by offline merge) */
  get historyOn(): boolean {
    return this.settings.versionHistoryEnabled || this.settings.offlineMergeEnabled;
  }

  private keystoreData?: KeyStoreData;
  private backupKey: Buffer | null = null;
  private statusEl?: HTMLElement;

  // interval handles
  private timers: number[] = [];

  async onload(): Promise<void> {
    await this.loadPersisted();
    setDebug(this.settings.debug);

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Sync Sentinel requires the desktop app (filesystem access).");
      warn("adapter is not FileSystemAdapter; plugin inert.");
      return;
    }
    this.base = adapter.getBasePath();

    this.keystore = new KeyStore(this.app);
    this.backupKey = this.keystore.open(this.keystoreData);

    this.registry = new SplitRegistry(this.app, this.base, () => this.settings);
    this.backup = new OneWayBackup(
      this.app,
      this.base,
      () => this.settings,
      () => this.backupKey
    );
    this.mirror = new DiskMirror(this.app, this.base, () => this.settings);
    this.syncLog = new SyncLogArchiver(this.app, this.base, () => this.settings);
    this.bases = new BaseStore(this.app, () => this.settings);
    this.weaver = new ConflictWeaver(
      this.app,
      this.bases,
      () => this.settings,
      () => this.updateStatusBar()
    );
    this.recovery = new RecoveryService(
      this.app,
      this.bases,
      () => this.settings,
      () => this.updateStatusBar()
    );

    this.addSettingTab(new SyncSentinelSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultEvents();

    this.addRibbonIcon("split-square-horizontal", "Sync Sentinel: split registry", () =>
      new RegistryModal(this.app, this).open()
    );
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => new RegistryModal(this.app, this).open());
    this.registerInterval(
      window.setInterval(() => this.updateStatusBar(), 60_000)
    );

    // Initial reconstruction pass once the layout is ready.
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.splitEnabled) {
        try {
          if (this.settings.autoReconstruct) await this.registry.reconstructAll({ silent: true });
          // Register this device as holding any originals already present.
          await this.registry.ackPresentOriginals();
          // Retract any archive acks whose local archive has since vanished.
          await this.registry.auditOwnArchives();
        } catch (e) {
          warn(e);
        }
      }
      if (this.historyOn) {
        // Seed ancestors + snapshot open tabs so a blanking has something to
        // restore, then flag any open note that's ALREADY blank on disk (the
        // glitch persisted across a restart) if we have a good version for it.
        try {
          await this.seedMergeBases();
          await this.recovery.captureOpenTabs();
          await this.recovery.flagAlreadyBlankOpen();
          this.recovery.notifyIfBlanked();
        } catch (e) {
          warn(e);
        }
      }
      if (this.settings.offlineMergeEnabled) {
        this.weaver.scan({ silent: true }).catch((e) => warn(e));
      }
      this.updateStatusBar();
    });

    this.rescheduleTimers();
    log("loaded.");
  }

  onunload(): void {
    this.clearTimers();
    void this.bases?.flush();
  }

  // --- persistence ---

  private async loadPersisted(): Promise<void> {
    const raw = (await this.loadData()) as PersistedData | SyncSentinelSettings | null;
    if (raw && (raw as PersistedData).settings) {
      const p = raw as PersistedData;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, p.settings);
      this.keystoreData = p.keystore;
    } else if (raw) {
      // migrate flat settings
      this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  async saveSettings(): Promise<void> {
    setDebug(this.settings.debug);
    const data: PersistedData = {
      settings: this.settings,
      keystore: this.keystoreData,
    };
    await this.saveData(data);
    this.rescheduleTimers();
  }

  // --- key management ---

  get hasBackupKey(): boolean {
    return this.backupKey != null;
  }

  get keyIsSecure(): boolean {
    return this.keystore?.isSecure ?? false;
  }

  async ensureBackupKey(): Promise<void> {
    if (this.backupKey) return;
    this.backupKey = KeyStore.generateKey();
    this.keystoreData = this.keystore.seal(this.backupKey);
    await this.saveSettings();
    new Notice(
      this.keyIsSecure
        ? "Sync Sentinel: backup key generated and stored in the OS keychain."
        : "Sync Sentinel: backup key generated (stored in plugin data — keychain unavailable)."
    );
  }

  async regenerateBackupKey(): Promise<void> {
    this.backupKey = KeyStore.generateKey();
    this.keystoreData = this.keystore.seal(this.backupKey);
    await this.saveSettings();
    new Notice(
      "Sync Sentinel: NEW backup key generated. Older encrypted backups can no longer be decrypted with it."
    );
  }

  async clearBackupKey(): Promise<void> {
    this.keystore.clear();
    this.backupKey = null;
    this.keystoreData = undefined;
    await this.saveSettings();
    new Notice("Sync Sentinel: backup key cleared.");
  }

  get keyBackendLabel(): string {
    return this.keystore?.backendLabel ?? "unknown";
  }

  /** Export the raw key as base64 so the user can stash it safely. */
  exportKeyB64(): string | null {
    return this.backupKey ? this.backupKey.toString("base64") : null;
  }

  async importKeyB64(b64: string): Promise<boolean> {
    try {
      const key = Buffer.from(b64.trim(), "base64");
      if (key.length !== 32) return false;
      this.backupKey = key;
      this.keystoreData = this.keystore.seal(key);
      await this.saveSettings();
      return true;
    } catch {
      return false;
    }
  }

  // --- commands ---

  private registerCommands(): void {
    this.addCommand({
      id: "split-active-file",
      name: "Split active file into sync-friendly shards",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) {
          new Notice("No active file.");
          return;
        }
        await this.registry.splitVaultFile(f.path, { force: true });
      },
    });
    this.addCommand({
      id: "split-all-large",
      name: "Split all large files now",
      callback: () => this.registry.scanAndAutoSplit(),
    });
    this.addCommand({
      id: "reconstruct-all",
      name: "Reconstruct all originals from shards",
      callback: () => this.registry.reconstructAll(),
    });
    this.addCommand({
      id: "show-registry",
      name: "Show split registry",
      callback: () => new RegistryModal(this.app, this).open(),
    });
    this.addCommand({
      id: "show-large-files",
      name: "Show largest files in vault",
      callback: () => new RegistryModal(this.app, this).open(),
    });
    this.addCommand({
      id: "run-backup",
      name: "Run one-way backup now",
      callback: async () => {
        if (this.settings.backupEncrypt) await this.ensureBackupKey();
        await this.backup.run();
      },
    });
    this.addCommand({
      id: "run-mirror",
      name: "Run disk safety mirror now",
      callback: () => this.mirror.run(),
    });
    this.addCommand({
      id: "snapshot-sync-log",
      name: "Snapshot sync log now",
      callback: () => this.syncLog.run(),
    });
    this.addCommand({
      id: "update-stignore",
      name: "Update Syncthing .stignore (exclude local folders)",
      callback: async () => {
        const patterns = await this.registry.updateStignore(true);
        new Notice(`Sync Sentinel: .stignore excludes ${patterns.join(", ")}`);
      },
    });
    this.addCommand({
      id: "scan-sync-conflicts",
      name: "Scan for sync conflicts and merge offline edits",
      callback: () => this.weaver.scan(),
    });
    this.addCommand({
      id: "file-history",
      name: "Recover active note: browse & restore version history",
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) {
          new Notice("No active file.");
          return;
        }
        this.openHistory(f.path);
      },
    });
    this.addCommand({
      id: "restore-active-healthy",
      name: "Restore active note to last healthy version",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) {
          new Notice("No active file.");
          return;
        }
        const ok = await this.recovery.restoreLatestHealthy(f.path);
        new Notice(
          ok
            ? `Sync Sentinel: restored ${f.path} to its last healthy version (previous content kept in history).`
            : `Sync Sentinel: no healthy version remembered for ${f.path}.`
        );
      },
    });
    this.addCommand({
      id: "rescue-blanked",
      name: "Rescue blanked notes now (open tabs)",
      callback: async () => {
        const { restored, skipped } = await this.recovery.rescueOpenTabs();
        if (!restored.length && !skipped.length) {
          new Notice("Sync Sentinel: no open notes are currently blank.");
          return;
        }
        new Notice(
          `Sync Sentinel: restored ${restored.length} blanked note(s)` +
            (skipped.length ? `; ${skipped.length} had no healthy version to restore.` : "."),
          10_000
        );
      },
    });
    this.addCommand({
      id: "validate-archives",
      name: "Validate keeper archives against synced shards",
      callback: async () => {
        const notice = new Notice("Sync Sentinel: validating archives (hashing)…", 0);
        try {
          const report = await this.registry.validateArchives();
          this.lastValidation = report;
          const bad = report.rows.filter((r) => !r.ok).length;
          notice.setMessage(
            bad || report.orphanedArchiveSets.length
              ? `Sync Sentinel: validation found ${bad} unhealthy file(s)` +
                (report.orphanedArchiveSets.length
                  ? `, ${report.orphanedArchiveSets.length} orphaned archive set(s)`
                  : "") +
                ". See the registry."
              : `Sync Sentinel: all ${report.rows.length} tracked file(s) validated clean.`
          );
          window.setTimeout(() => notice.hide(), 8000);
          new RegistryModal(this.app, this).open();
        } catch (e) {
          notice.hide();
          warn(e);
          new Notice("Sync Sentinel: validation failed — see console.");
        }
      },
    });
    this.addCommand({
      id: "retention-purge-preview",
      name: "Preview retention purge (dry run)",
      callback: () => this.runRetentionPurge({ dryRun: true }),
    });
    this.addCommand({
      id: "retention-purge-now",
      name: "Run retention purge now",
      callback: async () => {
        if (!this.settings.retentionPurgeEnabled) {
          new Notice(
            "Sync Sentinel: retention purge is off. Enable it in settings first (this deletes old safety copies)."
          );
          return;
        }
        await this.runRetentionPurge({ dryRun: false });
      },
    });
  }

  /** Open the local version-history browser for a file. */
  openHistory(path: string): void {
    new HistoryModal(this.app, this.bases, path, async (text) => {
      // Snapshot the current content first (non-destructive), then restore via
      // the editor-aware path so an open, blanked buffer can't re-save over it.
      await this.snapshotNow(path);
      await this.recovery.restoreInto(path, text);
    }).open();
  }

  /**
   * Seed ancestor snapshots for text files that have none yet, so the FIRST
   * conflict after enabling offline merge is still mergeable. Skips conflict
   * files and plugin-managed folders. Cheap after the first run.
   */
  async seedMergeBases(): Promise<number> {
    const files = this.app.vault
      .getFiles()
      .filter(
        (f) =>
          !isSyncConflictPath(f.path) &&
          !f.path.startsWith(this.settings.shardFolder) &&
          !f.path.startsWith(this.settings.archiveFolder)
      )
      .map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
    const n = await this.bases.seedMissing(files, (p) => this.app.vault.adapter.read(p));
    if (n > 0) log("seeded", n, "merge-base snapshot(s)");
    return n;
  }

  // --- retention purge (opt-in, age-based) ---

  async runRetentionPurge(opts: { dryRun: boolean }): Promise<void> {
    const s = this.settings;
    const ageMs = Math.max(1, s.retentionPurgeAgeDays) * 86_400_000;
    const mirrorN = await this.mirror
      .pruneOlderThan(ageMs, opts.dryRun)
      .catch((e) => (warn(e), 0));
    const baseR = await this.bases
      .pruneOlderThan(ageMs, opts.dryRun)
      .catch((e) => (warn(e), { snaps: 0, blobs: 0, resolved: 0 }));
    const verb = opts.dryRun ? "would remove" : "removed";
    new Notice(
      `Sync Sentinel retention (${opts.dryRun ? "dry run" : "purge"}): ${verb} ` +
        `${mirrorN} mirror version(s), ${baseR.snaps} merge-base snapshot(s) ` +
        `(${baseR.blobs} blob(s)), ${baseR.resolved} resolved-conflict cop${baseR.resolved === 1 ? "y" : "ies"}. ` +
        `Older than ${s.retentionPurgeAgeDays}d. Keeper shard archives are never age-purged.`,
      10_000
    );
    if (!opts.dryRun) {
      this.settings.lastRetentionPurgeAt = Date.now();
      await this.saveSettings();
    }
  }

  private maybeScheduledRetentionPurge(): void {
    const s = this.settings;
    if (!s.retentionPurgeEnabled) return;
    const due =
      Date.now() - (s.lastRetentionPurgeAt || 0) >=
      Math.max(1, s.retentionPurgeIntervalDays) * 86_400_000;
    if (due) void this.runRetentionPurge({ dryRun: false });
  }

  // --- vault events ---

  private autoSplitDebounced = debounce(
    (path: string) => {
      this.registry
        .splitVaultFile(path, { silent: true })
        .catch((e) => warn(e))
        .finally(() => this.updateStatusBar());
    },
    4000,
    true
  );

  private reconstructDebounced = debounce(
    () => {
      this.registry
        .reconstructAll({ silent: true })
        .catch((e) => warn(e))
        .finally(() => this.updateStatusBar());
    },
    3000,
    true
  );

  /**
   * Snapshot a file's CURRENT content immediately. Called on every modify —
   * deliberately no debounce and no throttle: any deferral window is a race a
   * sync clobber can win (the deferred read would see the clobbered content
   * and the user's last edit would be unrecoverable). Cost stays sane because
   * the store dedups by hash and compacts typing bursts (see BaseStore).
   */
  private async snapshotNow(path: string): Promise<void> {
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return;
      const content = await this.app.vault.cachedRead(f);
      await this.bases.snapshot(path, content, f.stat.mtime);
    } catch (e) {
      warn("snapshot failed:", path, e);
    }
  }

  private registerVaultEvents(): void {
    const onChange = (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      const p = file.path;
      // Offline merge: a sync-conflict sibling appeared → try to weave it.
      if (this.settings.offlineMergeEnabled && isSyncConflictPath(p)) {
        window.setTimeout(() => {
          this.weaver.handleConflictFile(p).catch((e) => warn(e));
        }, 3000); // let sync finish writing the pair
      } else if (this.historyOn) {
        // Any other mergeable-text change → version-history capture, which also
        // detects a blanking (network-drive glitch) and alerts on it.
        const wasClean = this.recovery.blanked.size === 0;
        this.recovery
          .onModify(file)
          .then((blanked) => {
            if (blanked && wasClean) this.recovery.notifyIfBlanked();
          })
          .catch((e) => warn(e));
      }
      // Anything under the shard folder changed (likely via sync) — device ledger
      // files included — so refresh the cached ledger view promptly.
      if (p.startsWith(this.settings.shardFolder)) {
        this.registry.invalidateDevices();
        if (this.settings.autoReconstruct) {
          this.reconstructDebounced();
          return;
        }
      }
      // A big file appeared/changed → auto-split if enabled. Skip files we
      // just wrote ourselves (e.g. a reconstruct) to avoid a sync feedback loop.
      if (
        this.settings.splitEnabled &&
        this.settings.autoSplit &&
        !this.registry.isExcluded(p) &&
        !this.registry.isRecentWrite(p) &&
        file.stat.size >= this.settings.splitThresholdBytes
      ) {
        this.autoSplitDebounced(p);
      }
    };
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    // Baseline capture on open: the blanking hits notes you've OPENED, so the
    // pre-blank content must be remembered the moment a note is opened, even if
    // you only read it.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (this.historyOn && file instanceof TFile) {
          this.recovery.captureBaseline(file).catch((e) => warn(e));
        }
      })
    );
    // "Version history" in the file context menu — the restore path must be
    // discoverable without memorizing a command name.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle("Sync Sentinel: version history")
            .setIcon("history")
            .onClick(() => this.openHistory(file.path))
        );
      })
    );
  }

  // --- timers ---

  rescheduleTimers(): void {
    this.clearTimers();
    const add = (mins: number, fn: () => void) => {
      if (mins > 0) {
        const id = window.setInterval(fn, mins * 60_000);
        this.timers.push(id);
        this.registerInterval(id);
      }
    };
    if (this.settings.backupEnabled)
      add(this.settings.backupIntervalMinutes, () =>
        this.backup.run({ silent: true }).catch((e) => warn(e))
      );
    if (this.settings.mirrorEnabled)
      add(this.settings.mirrorIntervalMinutes, () =>
        this.mirror.run({ silent: true }).catch((e) => warn(e))
      );
    if (this.settings.syncLogEnabled)
      add(this.settings.syncLogIntervalMinutes, () =>
        this.syncLog.run({ silent: true }).catch((e) => warn(e))
      );
    // Retention purge: check hourly whether the (day-scale) interval elapsed.
    if (this.settings.retentionPurgeEnabled)
      add(60, () => this.maybeScheduledRetentionPurge());
  }

  async updateStatusBar(): Promise<void> {
    if (!this.statusEl) return;
    try {
      const statuses = await this.registry.statuses();
      const pending = statuses.filter((s) => s.state === "ready-to-merge").length;
      const conflicts = statuses.filter((s) => s.state === "conflict").length;
      const approvals = await this.registry.pendingKeeperApprovals();
      const editConflicts = this.weaver?.flagged.size ?? 0;
      const blanked = this.recovery?.blanked.size ?? 0;
      let txt = `Sentinel: ${statuses.length} split`;
      if (pending) txt += ` · ${pending} to merge`;
      if (conflicts) txt += ` · ⚠ ${conflicts}`;
      if (approvals) txt += ` · ${approvals} to approve`;
      if (editConflicts) txt += ` · ✎⚠ ${editConflicts}`;
      if (blanked) txt += ` · ␀ ${blanked} blanked`;
      this.statusEl.setText(txt);
      this.statusEl.title = blanked
        ? `Sync Sentinel — ${blanked} note(s) went blank. Run "Rescue blanked notes now" to restore, or click for the registry.`
        : approvals
          ? `Sync Sentinel — ${approvals} purge suggestion(s) awaiting your approval. Click to review.`
          : "Sync Sentinel — click for split registry";
    } catch {
      /* ignore */
    }
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearInterval(id);
    this.timers = [];
  }
}
