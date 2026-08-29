import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SyncSentinelPlugin from "./main";
import { humanBytes } from "./util/fsutil";
import { FolderSuggest } from "./util/folderSuggest";

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

  /**
   * True if a destination path would land INSIDE the vault — i.e. it's relative,
   * or it's absolute but under the vault's base path. Those need excluding from
   * sync, or the backup/mirror syncs right back and defeats its own purpose.
   * Pure string work (no Node `path`) so it can't trigger a module-load notice.
   */
  private isInsideVault(p: string): boolean {
    const v = p.trim();
    if (!v) return false;
    const isAbsolute =
      v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\");
    if (!isAbsolute) return true; // relative paths resolve inside the vault
    const norm = v.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm === "") return true; // "/" — the folder picker's vault-root entry
    const base = (this.plugin.base || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!base) return false;
    return norm === base || norm.startsWith(base + "/");
  }

  /**
   * A destination path field: ghost text, vault-folder autocomplete, and a live
   * "exclude this from sync" reminder when the chosen path is inside the vault.
   */
  private destinationField(
    setting: Setting,
    opts: {
      placeholder: string;
      get: () => string;
      set: (v: string) => void;
      what: string; // e.g. "backups"
    }
  ): void {
    const warnEl = setting.descEl.createDiv();
    warnEl.style.marginTop = "4px";
    warnEl.style.color = "var(--text-warning, var(--text-error))";

    const refreshWarning = (val: string) => {
      if (!this.isInsideVault(val)) {
        warnEl.setText("");
        return;
      }
      warnEl.setText(
        `⚠ That path is inside your vault, so your ${opts.what} would sync too — ` +
          (this.s.syncthingMode
            ? "add it to the plugin's managed .stignore (Syncthing mode is on: use “Update .stignore” after saving), "
            : "exclude it in Obsidian Sync → Excluded folders, ") +
          "or point it somewhere outside the vault."
      );
    };

    setting.addText((t) => {
      t.setPlaceholder(opts.placeholder).setValue(opts.get());
      t.inputEl.style.width = "20em";
      new FolderSuggest(this.app, t.inputEl, async (picked) => {
        opts.set(picked);
        await this.save();
        refreshWarning(picked);
      });
      t.onChange(async (v) => {
        opts.set(v.trim());
        await this.save();
        refreshWarning(v);
      });
    });

    refreshWarning(opts.get());
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.splitterSection(containerEl);
    this.versionHistorySection(containerEl);
    this.offlineMergeSection(containerEl);
    this.backupSection(containerEl);
    this.mirrorSection(containerEl);
    this.retentionSection(containerEl);
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
      .addText((t) => {
        t.setValue(this.s.shardFolder);
        new FolderSuggest(this.app, t.inputEl, async (p) => {
          this.s.shardFolder = p === "/" ? ".sync-sentinel/shards" : p;
          await this.save();
        });
        t.onChange(async (v) => {
          this.s.shardFolder = v.trim() || ".sync-sentinel/shards";
          await this.save();
        });
      });

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

    this.destinationField(
      new Setting(c)
        .setName("Backup destination")
        .setDesc("Absolute path OUTSIDE the vault. Start typing to pick a vault folder."),
      {
        placeholder: "/Users/you/Backups/MyVault",
        get: () => this.s.backupDestination,
        set: (v) => {
          this.s.backupDestination = v;
        },
        what: "backups",
      }
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
  // --- version history & file recovery ---
  private versionHistorySection(c: HTMLElement): void {
    c.createEl("h2", { text: "Version history & file recovery" });
    c.createEl("p", {
      text:
        "Keeps a local, deduplicated version history of your text files in the sync-excluded archive folder. This is the recovery cache for a nasty failure some network/cloud drives cause: while Obsidian is running, an open note's body gets suddenly blanked. With this on, Sync Sentinel remembers each note's content as you open and edit it, watches for a sudden blanking, alerts you, and lets you restore the last good version — right-click a file → 'Sync Sentinel: version history', or the recovery commands. Works on a single device with no sync at all. (Enabling offline edit merging below turns this on automatically.)",
      cls: "setting-item-description",
    });

    new Setting(c)
      .setName("Keep local version history")
      .setDesc(
        "Snapshot text files on open and on change (deduplicated). Powers the history browser and file recovery."
      )
      .addToggle((t) =>
        t.setValue(this.s.versionHistoryEnabled).onChange(async (v) => {
          this.s.versionHistoryEnabled = v;
          await this.save();
          if (v) {
            const n = await this.plugin.seedMergeBases().catch(() => 0);
            await this.plugin.recovery.captureOpenTabs().catch(() => {});
            if (n > 0) new Notice(`Sync Sentinel: remembered ${n} file(s) for recovery.`);
          }
        })
      );

    new Setting(c)
      .setName("Watch for sudden blanking")
      .setDesc(
        "Detect when a note's body is wiped out (a network-drive glitch), record it as suspicious rather than good history, and alert you so you can restore. Recommended on."
      )
      .addToggle((t) =>
        t.setValue(this.s.blankGuardEnabled).onChange(async (v) => {
          this.s.blankGuardEnabled = v;
          await this.save();
        })
      );

    new Setting(c)
      .addButton((b) =>
        b
          .setButtonText("Rescue blanked open notes now")
          .onClick(async () => {
            const { restored, skipped } = await this.plugin.recovery.rescueOpenTabs();
            new Notice(
              restored.length || skipped.length
                ? `Restored ${restored.length}${skipped.length ? `, ${skipped.length} without a healthy version` : ""}.`
                : "No open notes are currently blank."
            );
          })
      )
      .addButton((b) =>
        b.setButtonText("Version history of active note").onClick(() => {
          const f = this.plugin.app.workspace.getActiveFile();
          if (f) this.plugin.openHistory(f.path);
          else new Notice("No active file.");
        })
      );
  }

  // --- offline merge (multi-device edit safety) ---
  private offlineMergeSection(c: HTMLElement): void {
    c.createEl("h2", { text: "Offline edit merging" });
    c.createEl("p", {
      text:
        "Protects the habit of editing on multiple offline devices, whatever does the syncing. Sync Sentinel remembers versions of your text files locally (in the sync-excluded archive folder) as they change. When your sync tool drops a conflict copy next to a file (Syncthing '.sync-conflict-…', Dropbox/Nextcloud 'conflicted copy'), the two versions are three-way merged against their common ancestor: edits to different parts of a note combine automatically; edits to the same lines are flagged for review in the registry, never guessed. And because every version is remembered, a bad automatic merge or a silent last-writer-wins overwrite (e.g. by Obsidian Sync) is fixable whenever you notice — right-click any file → 'Sync Sentinel: version history' to preview and restore. There is no deadline: versions are kept until you enable the retention purge below.",
      cls: "setting-item-description",
    });

    new Setting(c)
      .setName("Enable offline edit merging")
      .setDesc(
        "Passively snapshots text files as they change (deduplicated by content) so a merge always has a common ancestor."
      )
      .addToggle((t) =>
        t.setValue(this.s.offlineMergeEnabled).onChange(async (v) => {
          this.s.offlineMergeEnabled = v;
          await this.save();
          if (v) {
            // Seed ancestors for uncovered files so the FIRST conflict after
            // enabling is already mergeable.
            const n = await this.plugin.seedMergeBases().catch(() => 0);
            if (n > 0) new Notice(`Sync Sentinel: remembered ${n} file(s) as merge ancestors.`);
          }
        })
      );

    new Setting(c)
      .setName("Auto-apply clean merges")
      .setDesc(
        "When the two versions changed different parts of the file, apply the merge automatically. Overlapping edits are always flagged for review regardless. Both originals are preserved before any merge."
      )
      .addToggle((t) =>
        t.setValue(this.s.offlineMergeAuto).onChange(async (v) => {
          this.s.offlineMergeAuto = v;
          await this.save();
        })
      );

    new Setting(c).addButton((b) =>
      b.setButtonText("Scan for conflicts now").onClick(() => this.plugin.weaver.scan())
    );
  }

  // --- retention (age-based purge of safety copies) ---
  private retentionSection(c: HTMLElement): void {
    c.createEl("h2", { text: "Retention" });
    c.createEl("p", {
      text:
        "Local safety copies (mirror versions, merge-base snapshots, resolved-conflict copies) accumulate forever by default — nothing is ever deleted by age until you turn this on. Keeper shard archives are NEVER age-purged; they answer to the keeper/purge-gate protocol instead.",
      cls: "setting-item-description",
    });

    new Setting(c)
      .setName("Enable scheduled retention purge")
      .setDesc("Deletes safety copies older than the age below, on the cadence below.")
      .addToggle((t) =>
        t.setValue(this.s.retentionPurgeEnabled).onChange(async (v) => {
          this.s.retentionPurgeEnabled = v;
          await this.save();
        })
      );

    new Setting(c)
      .setName("Purge copies older than (days)")
      .setDesc("Each file's newest copy always survives, regardless of age.")
      .addText((t) =>
        t.setValue(String(this.s.retentionPurgeAgeDays)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.retentionPurgeAgeDays = n;
            await this.save();
          }
        })
      );

    new Setting(c)
      .setName("Run every (days)")
      .addText((t) =>
        t.setValue(String(this.s.retentionPurgeIntervalDays)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.retentionPurgeIntervalDays = n;
            await this.save();
          }
        })
      );

    new Setting(c)
      .addButton((b) =>
        b
          .setButtonText("Preview purge (dry run)")
          .onClick(() => this.plugin.runRetentionPurge({ dryRun: true }))
      )
      .addButton((b) =>
        b.setButtonText("Purge now").onClick(async () => {
          if (!this.s.retentionPurgeEnabled) {
            new Notice("Enable the retention purge first — this deletes old safety copies.");
            return;
          }
          await this.plugin.runRetentionPurge({ dryRun: false });
        })
      );
  }

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

    this.destinationField(
      new Setting(c)
        .setName("Mirror destination")
        .setDesc("Absolute path OUTSIDE the vault. Start typing to pick a vault folder."),
      {
        placeholder: "/Users/you/Backups/MyVault-mirror",
        get: () => this.s.mirrorDestination,
        set: (v) => {
          this.s.mirrorDestination = v;
        },
        what: "mirrored copies",
      }
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

    new Setting(c)
      .setName("Versions kept per file")
      .setDesc(
        "Newest mirror copies kept for each file (count-based). Age-based cleanup is separate — see Retention below, off by default."
      )
      .addText((t) =>
        t.setValue(String(this.s.mirrorKeepVersions)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.s.mirrorKeepVersions = n;
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

    this.destinationField(
      new Setting(c)
        .setName("Archive destination")
        .setDesc("Absolute path for archived sync logs. Start typing to pick a vault folder."),
      {
        placeholder: "/Users/you/Backups/MyVault-synclogs",
        get: () => this.s.syncLogDestination,
        set: (v) => {
          this.s.syncLogDestination = v;
        },
        what: "archived logs",
      }
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
      .addText((t) => {
        t.setPlaceholder(".sync-sentinel-archive").setValue(this.s.archiveFolder);
        new FolderSuggest(this.app, t.inputEl, async (p) => {
          this.s.archiveFolder = p === "/" ? ".sync-sentinel-archive" : p;
          await this.save();
        });
        t.onChange(async (v) => {
          this.s.archiveFolder = v.trim() || ".sync-sentinel-archive";
          await this.save();
        });
      });

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
