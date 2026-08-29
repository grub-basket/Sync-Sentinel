// Shared types for Sync Sentinel.

export interface SyncSentinelSettings {
  // --- Large-file splitter ---
  splitEnabled: boolean;
  /** Files at or above this size (bytes) become split candidates. */
  splitThresholdBytes: number;
  /** Size of each shard in bytes. Keep below your Obsidian Sync per-file limit. */
  chunkSizeBytes: number;
  /** Vault-relative folder where shards + manifests live. */
  shardFolder: string;
  /** File extension for shard parts (must be enabled in Obsidian Sync's file-type list). */
  shardExtension: string;
  /** Auto-split new/modified large files as they appear. */
  autoSplit: boolean;
  /** After a successful, hash-verified split, delete the bulky original locally. */
  removeOriginalAfterSplit: boolean;
  /** Auto-reconstruct originals from shards when manifests/shards arrive. */
  autoReconstruct: boolean;
  /** Glob-ish substrings; files whose path contains any are never split. */
  splitExcludes: string[];
  /**
   * Vault-relative folder for keeper cold-archives of shards. You must add this
   * folder to Obsidian Sync's EXCLUDED list once, so purging synced shards can't
   * delete these local archives.
   */
  archiveFolder: string;
  /** A device counts toward the "all safe" purge gate if its ledger updated within this many days. */
  activeDeviceDays: number;
  /**
   * Syncthing / P2P mode. When on, the plugin manages a `.stignore` block in the
   * vault root so the keeper archive folder is excluded from Syncthing — the
   * exclusion step it CAN'T do for Obsidian Sync, but can here (it's just a file).
   */
  syncthingMode: boolean;
  /**
   * What to do when a shard set wants to materialize but a DIFFERENT local
   * original already exists:
   *  - "manual": do nothing, just flag it in the registry (safest).
   *  - "newest-wins": whichever of (manifest, local file) is newer wins.
   *  - "conflict-file": write the synced version as a separate ".conflict-" file
   *    next to the local one so you can compare/merge, leaving the local intact.
   */
  conflictPolicy: "manual" | "newest-wins" | "conflict-file";

  // --- One-way backups ---
  backupEnabled: boolean;
  /** Absolute path outside the vault where backups are written. */
  backupDestination: string;
  /** Encrypt backup payloads with AES-256-GCM. */
  backupEncrypt: boolean;
  /** Interval in minutes between automatic backup runs (0 = manual only). */
  backupIntervalMinutes: number;
  /** Keep this many timestamped backup generations (0 = keep all). */
  backupKeep: number;

  // --- On-disk safety mirror (the "exclude this folder" feature) ---
  mirrorEnabled: boolean;
  /** Absolute path outside the vault for the live safety mirror. */
  mirrorDestination: string;
  /** Mirror files modified within this many minutes on each pass. */
  mirrorRecentMinutes: number;
  /** Interval in minutes between mirror passes. */
  mirrorIntervalMinutes: number;
  /** Vault-relative folder the user should EXCLUDE from sync; we note it here. */
  mirrorExcludeNote: string;

  // --- Local version history & file recovery ---
  /**
   * Keep a local, deduplicated version history of text files (snapshots into
   * `<archiveFolder>/_bases/`, sync-excluded). Powers the version-history
   * browser, the blank-file guard, and — when offline merge is on — the merge
   * ancestor. Independent of any sync tool: this is what recovers a note that a
   * flaky network drive truncated to empty while it was open. Off by default;
   * enabling offline merge turns it on implicitly.
   */
  versionHistoryEnabled: boolean;
  /**
   * Watch for a note's body being suddenly blanked (a known network/cloud-drive
   * failure that empties open files under Obsidian). A detected blanking is
   * recorded as "suspicious" (never a merge base, never the restore target),
   * you're alerted, and the pre-blank version stays one click away.
   */
  blankGuardEnabled: boolean;

  // --- Offline merge (multi-device edit safety on Syncthing) ---
  /**
   * Detect `*.sync-conflict-*` / "conflicted copy" siblings and three-way merge
   * them via the version-history ancestor. Off by default. Implies
   * `versionHistoryEnabled` (snapshots must exist for a merge to have a base).
   */
  offlineMergeEnabled: boolean;
  /**
   * Auto-apply a merge when the two variants touched DIFFERENT regions (a
   * clean diff3). Overlapping edits are always flagged for review regardless.
   */
  offlineMergeAuto: boolean;

  // --- Retention (age-based purge of local safety copies) ---
  /** Newest versions kept per mirrored file (count-based, always on). */
  mirrorKeepVersions: number;
  /**
   * Age-based purge of LOCAL safety copies (mirror versions, ancestor
   * snapshots, resolved-conflict copies). OFF by default — nothing is ever
   * deleted by age until the user turns this on and chooses the age + cadence.
   * Keeper shard archives are NEVER age-purged (they answer to the keeper
   * protocol, not retention).
   */
  retentionPurgeEnabled: boolean;
  /** Delete safety copies older than this many days. */
  retentionPurgeAgeDays: number;
  /** How often (days) the purge pass runs. */
  retentionPurgeIntervalDays: number;
  /** Last completed purge pass (ms). Managed by the plugin. */
  lastRetentionPurgeAt: number;

  // --- Sync-log archiving ---
  syncLogEnabled: boolean;
  /** Absolute path to Obsidian's sync log (auto-detected if blank). */
  syncLogPath: string;
  /** Absolute destination folder for archived sync logs. */
  syncLogDestination: string;
  /** Interval in minutes between sync-log snapshots. */
  syncLogIntervalMinutes: number;

  /** Verbose console logging. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: SyncSentinelSettings = {
  splitEnabled: true,
  splitThresholdBytes: 200 * 1024 * 1024,
  chunkSizeBytes: 40 * 1024 * 1024,
  shardFolder: ".sync-sentinel/shards",
  shardExtension: "bin",
  autoSplit: false,
  removeOriginalAfterSplit: false,
  autoReconstruct: true,
  splitExcludes: [".sync-sentinel/"],
  archiveFolder: ".sync-sentinel-archive",
  activeDeviceDays: 30,
  syncthingMode: false,
  conflictPolicy: "manual",

  backupEnabled: false,
  backupDestination: "",
  backupEncrypt: false,
  backupIntervalMinutes: 0,
  backupKeep: 5,

  mirrorEnabled: false,
  mirrorDestination: "",
  mirrorRecentMinutes: 60,
  mirrorIntervalMinutes: 15,
  mirrorExcludeNote: ".sync-sentinel-mirror",

  versionHistoryEnabled: false,
  blankGuardEnabled: true,
  offlineMergeEnabled: false,
  offlineMergeAuto: true,

  mirrorKeepVersions: 10,
  retentionPurgeEnabled: false,
  retentionPurgeAgeDays: 60,
  retentionPurgeIntervalDays: 7,
  lastRetentionPurgeAt: 0,

  syncLogEnabled: false,
  syncLogPath: "",
  syncLogDestination: "",
  syncLogIntervalMinutes: 10,

  debug: false,
};

/** One shard within a split manifest. */
export interface ShardEntry {
  index: number;
  name: string; // file name within the shard set folder
  size: number;
  sha256: string;
}

/** Manifest describing one split original file. Synced as a small JSON. */
export interface SplitManifest {
  version: 1;
  id: string; // stable id for this original (hash of path)
  originalPath: string; // vault-relative
  originalSize: number;
  originalSha256: string;
  originalMtimeMs: number;
  chunkSizeBytes: number;
  shardExtension: string;
  shards: ShardEntry[];
  createdAt: number;
  updatedAt: number;
  host: string; // which device produced this split
}

/** Local per-vault state (not synced) tracking what we've materialized. */
export interface LocalState {
  /** manifestId -> sha256 of original we last materialized/split locally. */
  materialized: Record<string, string>;
}

/** Per-split state a device records about itself. */
export interface DeviceFileState {
  /** When this device obtained the full original (by split or merge). */
  originalAt?: number;
  /** This device is designated to keep a cold archive of the shards. */
  keeper?: boolean;
  /** When this device archived the shards into its excluded folder. */
  archivedAt?: number;
  /** originalSha256 of the split that was archived (invalidates on re-split). */
  archivedSha?: string;
  /** This device has suggested purging the synced shards (awaiting keeper approval). */
  purgeRequested?: number;
  /** This device deliberately won't hold this file — excluded from the purge gate. */
  optedOut?: boolean;
}

/**
 * One synced ledger file per device: `<shardFolder>/devices/<deviceId>.json`.
 * Each device writes ONLY its own file, so there are never write conflicts; every
 * device reads all of them to learn who holds what.
 */
export interface DeviceFile {
  deviceId: string;
  deviceName: string;
  updatedAt: number;
  /** manifestId -> this device's state for that split. */
  files: Record<string, DeviceFileState>;
}
