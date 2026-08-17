import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SyncSentinelPlugin from "./main";
import { humanBytes } from "./util/fsutil";

const MB = 1024 * 1024;

export class SyncSentinelSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SyncSentinelPlugin) {
    super(app, plugin);
  }

  private get s() {
    return this.plugin.settings;
  }

  private async save() {
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.splitterSection(containerEl);
    this.backupSection(containerEl);
    this.mirrorSection(containerEl);
    this.syncLogSection(containerEl);
    this.miscSection(containerEl);
  }

  // --- large file splitter ---
  private splitterSection(c: HTMLElement): void {
    c.createEl("h2", { text: "Large-file splitter" });
    c.createEl("p", {
      text:
        "Splits files at/above the threshold into small shards that Obsidian Sync will happily sync, then reassembles them on your other devices. Make sure the shard file type is enabled in Obsidian Sync's 'Selective sync' file-type list.",
      cls: "setting-item-description",
    });

    new Setting(c)
      .setName("Enable splitter")
      .addToggle((t) =>
        t.setValue(this.s.splitEnabled).onChange(async (v) => {
          this.s.splitEnabled = v;
          await this.save();
        })
      );

    new Setting(c)
      .setName("Split threshold")
      .setDesc("Files at or above this size become split candidates.")
      .addText((t) =>
        t
          .setPlaceholder("MB")
          .setValue(String(Math.round(this.s.splitThresholdBytes / MB)))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n > 0) {
              this.s.splitThresholdBytes = Math.round(n * MB);
              await this.save();
            }
          })
      )
      .addExtraButton((b) =>
        b.setIcon("info").setTooltip(humanBytes(this.s.splitThresholdBytes))
      );

    new Setting(c)
      .setName("Shard size")
      .setDesc(
        "Size of each shard in MB. Keep below your Obsidian Sync per-file limit."
      )
      .addText((t) =>
        t
          .setValue(String(Math.round(this.s.chunkSizeBytes / MB)))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n > 0) {
              this.s.chunkSizeBytes = Math.round(n * MB);
              await this.save();
            }
          })
      );

    new Setting(c)
      .setName("Shard folder")
      .setDesc("Vault-relative folder where shards and manifests live.")
      .addText((t) =>
        t.setValue(this.s.shardFolder).onChange(async (v) => {
          this.s.shardFolder = v.trim() || ".sync-sentinel/shards";
          await this.save();
        })
      );

    new Setting(c)
      .setName("Shard extension")
      .setDesc(
        "Extension for shard parts. Must be enabled in Obsidian Sync's file-type list."
      )
      .addText((t) =>
        t.setValue(this.s.shardExtension).onChange(async (v) => {
          this.s.shardExtension = v.replace(/^\./, "").trim() || "bin";
          await this.save();
        })
      );

    new Setting(c)
      .setName("Auto-split new/changed large files")
      .setDesc("Split automatically as large files appear or change.")
      .addToggle((t) =>
        t.setValue(this.s.autoSplit).onChange(async (v) => {
          this.s.autoSplit = v;
          await this.save();
        })
      );

    new Setting(c)
      .setName("Auto-reconstruct from shards")
      .setDesc("Rebuild originals automatically when shards arrive via sync.")
      .addToggle((t) =>
        t.setValue(this.s.autoReconstruct).onChange(async (v) => {
          this.s.autoReconstruct = v;
          await this.save();
        })
      );

    new Setting(c)
      .setName("Remove original after split")
      .setDesc(
        "After a hash-verified split, delete the bulky original locally (shards become the source of truth). Off by default."
      )
      .addToggle((t) =>
        t.setValue(this.s.removeOriginalAfterSplit).onChange(async (v) => {
          this.s.removeOriginalAfterSplit = v;
          await this.save();
        })
      );

    new Setting(c)
      .setName("Split excludes")
      .setDesc("One path substring per line; matching files are never split.")
      .addTextArea((t) =>
        t.setValue(this.s.splitExcludes.join("\n")).onChange(async (v) => {
          this.s.splitExcludes = v
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean);
          await this.save();
        })
      );

    new Setting(c)
      .setName("Conflict policy")
      .setDesc(
        "When synced shards and a different local file disagree: flag only, " +
          "let the newer one win, or save the synced version as a separate file to compare."
      )
      .addDropdown((d) =>
        d
          .addOption("manual", "Flag only (manual)")
          .addOption("newest-wins", "Newest wins")
          .addOption("conflict-file", "Save a conflict file")
          .setValue(this.s.conflictPolicy)
          .onChange(async (v) => {
            this.s.conflictPolicy = v as typeof this.s.conflictPolicy;
            await this.save();
          })
      );

    new Setting(c).addButton((b) =>
      b
        .setButtonText("Open split registry")
        .setCta()
        .onClick(() => {
          // lazy import to avoid cycle at module top
          import("./splitter/registryModal").then(({ RegistryModal }) =>
            new RegistryModal(this.app, this.plugin).open()
          );
        })
    );
  }

  // --- one-way backup ---
  private backupSection(c: HTMLElement): void {
    c.createEl("h2", { text: "One-way backups" });

    new Setting(c).setName("Enable scheduled backups").addToggle((t) =>
      t.setValue(this.s.backupEnabled).onChange(async (v) => {
        this.s.backupEnabled = v;
        await this.save();
      })
    );

    new Setting(c)
      .setName("Backup destination")
      .setDesc("Absolute path OUTSIDE the vault.")
      .addText((t) =>
        t
          .setPlaceholder("/Users/you/Backups/MyVault")
          .setValue(this.s.backupDestination)
          .onChange(async (v) => {
            this.s.backupDestination = v.trim();
            await this.save();
          })
      );

    new Setting(c)
      .setName("Backup interval (minutes)")
      .setDesc("0 = manual only.")
      .addText((t) =>
        t.setValue(String(this.s.backupIntervalMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 0) {
            this.s.backupIntervalMinutes = n;
            await this.save();
          }
        })
      );

    new Setting(c)
      .setName("Generations to keep")
      .setDesc("0 = keep all.")
      .addText((t) =>
        t.setValue(String(this.s.backupKeep)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 0) {
            this.s.backupKeep = n;
            await this.save();
          }
        })
      );

    new Setting(c)
      .setName("Encrypt backups (AES-256-GCM)")
      .setDesc(`Key storage: ${this.plugin.keyBackendLabel}.`)
      .addToggle((t) =>
        t.setValue(this.s.backupEncrypt).onChange(async (v) => {
          this.s.backupEncrypt = v;
          await this.save();
          if (v) await this.plugin.ensureBackupKey();
          this.display();
        })
      );

    if (this.s.backupEncrypt) {
      new Setting(c)
        .setName("Encryption key")
        .setDesc(
          this.plugin.hasBackupKey
            ? "A key is set. Export and store it somewhere safe — without it, encrypted backups are unrecoverable."
            : "No key yet."
        )
        .addButton((b) =>
          b.setButtonText("Export key").onClick(() => {
            const k = this.plugin.exportKeyB64();
            if (!k) {
              new Notice("No key to export.");
              return;
            }
            navigator.clipboard.writeText(k);
            new Notice("Backup key copied to clipboard (base64).");
          })
        )
        .addButton((b) =>
          b.setButtonText("Import key").onClick(async () => {
            const v = window.prompt("Paste base64 backup key (32 bytes):");
            if (!v) return;
            const ok = await this.plugin.importKeyB64(v);
            new Notice(ok ? "Key imported." : "Invalid key.");
            this.display();
          })
        )
        .addButton((b) =>
          b
            .setButtonText("Regenerate")
            .setWarning()
            .onClick(async () => {
              await this.plugin.regenerateBackupKey();
              this.display();
            })
        );
    }

    new Setting(c).addButton((b) =>
      b
        .setButtonText("Back up now")
        .setCta()
        .onClick(async () => {
          if (this.s.backupEncrypt) await this.plugin.ensureBackupKey();
          await this.plugin.backup.run();
        })
    );
  }

  // --- disk mirror ---
  private mirrorSection(c: HTMLElement): void {
    c.createEl("h2", { text: "On-disk safety mirror" });
    c.createEl("p", {
      text:
        "Continuously copies recently-modified vault files into an external folder (keeping a short version history), so a bad sync can't silently destroy recent work. Put this folder OUTSIDE your vault, or exclude it from sync.",
      cls: "setting-item-description",
    });

    new Setting(c).setName("Enable mirror").addToggle((t) =>
      t.setValue(this.s.mirrorEnabled).onChange(async (v) => {
        this.s.mirrorEnabled = v;
        await this.save();
      })
    );

    new Setting(c)
      .setName("Mirror destination")
      .setDesc("Absolute path OUTSIDE the vault.")
      .addText((t) =>
        t.setValue(this.s.mirrorDestination).onChange(async (v) => {
          this.s.mirrorDestination = v.trim();
          await this.save();
        })
      );

    new Setting(c)
      .setName("Recent window (minutes)")
      .setDesc("Each pass mirrors files modified within this window.")
      .addText((t) =>
        t.setValue(String(this.s.mirrorRecentMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.mirrorRecentMinutes = n;
            await this.save();
          }
        })
      );

    new Setting(c)
      .setName("Mirror interval (minutes)")
      .addText((t) =>
        t.setValue(String(this.s.mirrorIntervalMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.mirrorIntervalMinutes = n;
            await this.save();
          }
        })
      );

    new Setting(c).addButton((b) =>
      b.setButtonText("Mirror now").onClick(() => this.plugin.mirror.run())
    );
  }

  // --- sync log ---
  private syncLogSection(c: HTMLElement): void {
    c.createEl("h2", { text: "Sync-log archiving" });

    new Setting(c).setName("Enable sync-log snapshots").addToggle((t) =>
      t.setValue(this.s.syncLogEnabled).onChange(async (v) => {
        this.s.syncLogEnabled = v;
        await this.save();
      })
    );

    new Setting(c)
      .setName("Sync log path")
      .setDesc("Leave blank to auto-detect under the vault config folder.")
      .addText((t) =>
        t
          .setPlaceholder("(auto-detect)")
          .setValue(this.s.syncLogPath)
          .onChange(async (v) => {
            this.s.syncLogPath = v.trim();
            await this.save();
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("search")
          .setTooltip("Detect now")
          .onClick(async () => {
            const p = await this.plugin.syncLog.detectLogPath();
            new Notice(p ? `Found: ${p}` : "Sync log not found.");
          })
      );

    new Setting(c)
      .setName("Archive destination")
      .setDesc("Absolute path for archived sync logs.")
      .addText((t) =>
        t.setValue(this.s.syncLogDestination).onChange(async (v) => {
          this.s.syncLogDestination = v.trim();
          await this.save();
        })
      );

    new Setting(c)
      .setName("Snapshot interval (minutes)")
      .addText((t) =>
        t.setValue(String(this.s.syncLogIntervalMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.syncLogIntervalMinutes = n;
            await this.save();
          }
        })
      );

    new Setting(c).addButton((b) =>
      b.setButtonText("Snapshot now").onClick(() => this.plugin.syncLog.run())
    );
  }

  private miscSection(c: HTMLElement): void {
    c.createEl("h2", { text: "Misc" });

    new Setting(c)
      .setName("This device's name")
      .setDesc(
        "Shown in the split registry so you can tell which devices hold each file. Stored locally (never synced), unique per device."
      )
      .addText((t) =>
        t
          .setValue(this.plugin.registry.deviceName())
          .onChange(async (v) => {
            await this.plugin.registry.setDeviceName(v);
          })
      );

    new Setting(c)
      .setName("Keeper archive folder")
      .setDesc(
        "Vault-relative folder where keeper devices stash a cold copy of shards. " +
          "You MUST add this folder to Obsidian Sync's excluded list once, or purging " +
          "synced shards would delete these archives too."
      )
      .addText((t) =>
        t.setValue(this.s.archiveFolder).onChange(async (v) => {
          this.s.archiveFolder = v.trim() || ".sync-sentinel-archive";
          await this.save();
        })
      );

    new Setting(c)
      .setName("Syncthing / P2P mode")
      .setDesc(
        "If your vault syncs via Syncthing (true peer-to-peer, nothing on a server), " +
          "turn this on and the plugin will manage a .stignore entry that excludes the " +
          "keeper archive folder — the exclusion step it can't do for Obsidian Sync."
      )
      .addToggle((t) =>
        t.setValue(this.s.syncthingMode).onChange(async (v) => {
          this.s.syncthingMode = v;
          await this.save();
          const patterns = await this.plugin.registry.updateStignore(v);
          new Notice(
            v
              ? `Syncthing mode on — .stignore now excludes ${patterns.join(", ")}.`
              : "Syncthing mode off — removed Sync Sentinel's .stignore block."
          );
        })
      );

    if (this.s.syncthingMode) {
      new Setting(c)
        .setName("Update .stignore now")
        .setDesc("Re-apply the managed exclusion block (run after changing the archive folder).")
        .addButton((b) =>
          b.setButtonText("Update .stignore").onClick(async () => {
            const patterns = await this.plugin.registry.updateStignore(true);
            new Notice(`.stignore excludes: ${patterns.join(", ")}`);
          })
        );
    }

    new Setting(c)
      .setName("Active device window (days)")
      .setDesc(
        "A device counts toward the 'safe to purge' check only if its ledger updated within this many days. Lets you retire dead devices."
      )
      .addText((t) =>
        t.setValue(String(this.s.activeDeviceDays)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.activeDeviceDays = n;
            await this.save();
          }
        })
      );
    new Setting(c)
      .setName("Debug logging")
      .addToggle((t) =>
        t.setValue(this.s.debug).onChange(async (v) => {
          this.s.debug = v;
          await this.save();
        })
      );
  }
}
