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
import { OneWayBackup } from "./backup/oneway";
import { DiskMirror } from "./backup/mirror";
import { SyncLogArchiver } from "./backup/synclog";
import { KeyStore, KeyStoreData } from "./backup/keystore";
import { SyncSentinelSettingTab } from "./settings";
import { RegistryModal } from "./splitter/registryModal";

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
      this.updateStatusBar();
    });

    this.rescheduleTimers();
    log("loaded.");
  }

  onunload(): void {
    this.clearTimers();
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

  private registerVaultEvents(): void {
    const onChange = (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      const p = file.path;
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
  }

  async updateStatusBar(): Promise<void> {
    if (!this.statusEl) return;
    try {
      const statuses = await this.registry.statuses();
      const pending = statuses.filter((s) => s.state === "ready-to-merge").length;
      const conflicts = statuses.filter((s) => s.state === "conflict").length;
      const approvals = await this.registry.pendingKeeperApprovals();
      let txt = `Sentinel: ${statuses.length} split`;
      if (pending) txt += ` · ${pending} to merge`;
      if (conflicts) txt += ` · ⚠ ${conflicts}`;
      if (approvals) txt += ` · ${approvals} to approve`;
      this.statusEl.setText(txt);
      this.statusEl.title = approvals
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
