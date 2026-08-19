# Sync Sentinel

An Obsidian plugin (desktop-only) for surviving sync, especially with large files.

## Features

### 1. Large-file splitter (the headline feature)
Obsidian Sync silently refuses files past its per-file size limit, so your 200 MB
video never leaves your laptop. Sync Sentinel splits such files into small
**shards** that Sync *will* happily replicate, and reassembles the original
byte-for-byte on your other devices.

- Configurable **threshold** (default 200 MB) and **shard size** (default 40 MB).
- Each split produces a small JSON **manifest** (synced) plus a folder of shards.
  The manifest carries SHA-256 hashes for every shard and the whole file, so
  reassembly is verified — a corrupted or partial shard is rejected, never
  silently written.
- **Auto-split** new/changed large files, and **auto-reconstruct** originals as
  shards arrive on another device.
- A **registry view** (command: *Show split registry*) lists every tracked file
  with its state: in-sync, ready-to-merge, conflict, or missing-shards.
- A **vault size overview** at the top of that view (also *Show largest files in
  vault*) shows your largest file, how close it is to the threshold, counts of
  files at/over and within 50% of it, and a ranked list — so you can see what's
  approaching the limit before it becomes a problem.

### Device tracking & space reclaim
Because shards live in a *synced* folder, they replicate to every device — which
is what forces the sync, but also means you're storing the shards everywhere.
Sync Sentinel tracks who has what and lets you reclaim that space safely:

- **Device ledger** — each device writes its own small synced JSON file (so Sync
  never conflicts them) recording which originals it holds. The command center
  shows, per file, **"On 2/3 devices: ✓ Laptop (this), ✓ Desktop, · Phone"**.
- **Keepers** — designate one or more devices as keepers. A keeper copies the
  shard set into an **excluded archive folder** (a cold copy that survives a purge
  and can re-seed a new device later).
- **Suggest → keeper approves → purge** — any device can *suggest* a purge (queued
  for review). Only a **keeper** can approve it, and only once **every active
  device holds the original** and **a keeper has archived the current shards**. At
  approval the keeper **re-verifies its own archive by hash** (retracting its ack
  if it fails, rather than purging). Purge then deletes the shards from the synced
  folder on all devices — reconstructed files and keeper archives stay put. This
  is verified self-attestation: the excluded archive can't be checked remotely, so
  the device that holds it is the one that confirms and executes.

> **One-time setup:** add the keeper archive folder (default
> `.sync-sentinel-archive/`) to **Obsidian Sync → excluded folders**, otherwise a
> purge would delete the archives too. The plugin can't set this for you.

- **Per-file opt-out** — a device that deliberately won't hold a given file can
  *opt out* of it: it stops auto-reconstructing that file and no longer blocks its
  purge gate (manual reconstruct still works, and you can opt back in anytime).
- **Keeper notifications** — the status bar shows `· N to approve` when purge
  suggestions are waiting on this keeper device, so you notice without opening the
  registry.
- Streaming I/O — memory stays flat regardless of file size.

> **Important:** shards use the `bin` extension by default. Enable that file type
> in **Obsidian Sync → Selective sync → file types** (or change the extension in
> settings to one you already sync), otherwise the shards themselves won't sync.

### 2. One-way encrypted backups
Timestamped, generational snapshots of the whole vault to a folder outside it.
Optional **AES-256-GCM** encryption. The key is stored, in preference order, in:
1. **Obsidian's own keychain** — the first-party `app.secretStorage` API
   (Obsidian 1.11.4+), backed by the OS keychain and keyed to the vault;
2. Electron `safeStorage` (OS keychain) if the Obsidian API isn't present;
3. obfuscated plugin-data storage, clearly flagged, as a last resort.

The settings panel shows which backend is active. Export/import the key as
base64 so you can keep an offline copy — without it, encrypted backups are
unrecoverable.

**Conflict handling.** When synced shards and a different local file disagree,
the **conflict policy** setting decides: *flag only* (default — surfaced in the
registry for manual resolution), *newest wins*, or *save a conflict file* (writes
the synced version alongside the local one so you can compare/merge). The registry
view gives one-click *Use synced version* / *Keep local* / *Open synced copy*.

### 3. On-disk safety mirror
Continuously copies recently-modified vault files into an external folder,
keeping a short **version history** per file. This is the "exclude this folder
from sync" safety net: if a bad sync deletes or clobbers recent work, you have
local versioned copies it never touched.

### 4. Aggressive sync-log archiving
Snapshots Obsidian's own sync log (auto-detected, or set manually) to an external
folder on an interval, deduplicated by content hash, so you can diagnose a sync
incident even after Obsidian rotates or truncates its log.

### 5. Pause sync for an interval — *TODO*
On the backlog. Low priority (mainly helps
first-time setup), and there's no public Obsidian API to toggle Sync, so it would
likely be UI automation or a guided manual flow.

## Commands
- Split active file into sync-friendly shards
- Split all large files now
- Reconstruct all originals from shards
- Show split registry
- Run one-way backup now
- Run disk safety mirror now
- Snapshot sync log now

## Development
```bash
pnpm install
pnpm run dev        # watch build
pnpm run build      # production bundle -> main.js
pnpm run typecheck  # tsc --noEmit
```

## Safety notes
- Reconstruction never overwrites a locally-present file that differs from the
  manifest; it flags a **conflict** and waits for you to choose in the registry.
- "Remove original after split" only deletes after the shards are verified to
  reassemble to the original hash. It's off by default.
- All destination folders for backups/mirror/sync-log should live **outside**
  your synced vault.
