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

### Recovering blanked notes (network-drive glitch)
Some network and cloud drives have a nasty failure mode: while Obsidian is
running, an open note's body gets suddenly **blanked** — wiped to empty on disk
under the editor. (A long-standing headache on shared/corporate drives.) It's
not a sync conflict and no conflict file is written, so nothing catches it — you
just notice, maybe much later, that notes are empty.

With **version history** on (see below), Sync Sentinel guards against exactly
this:

- It remembers each note's content **when you open it** and as you edit, into
  the sync-excluded archive folder — so the pre-blank version exists even for a
  note you only read.
- When a save wipes a note's body, it's recorded as **suspicious** (never used
  as good history or a merge base), the status bar and a notice flag it, and the
  registry lists it under *Blanked notes — recoverable*.
- Restore is **editor-aware and non-destructive**: *Restore active note to last
  healthy version*, *Rescue blanked notes now (open tabs)*, or review the full
  timeline via right-click → *version history*. Because the blanked buffer is
  still loaded, restoring writes into the **editor** (and flushes to disk), so
  Obsidian can't re-save the blank over your recovered text. The blanked version
  stays in history too, so nothing is lost either way.

This works on a **single device with no sync at all** — it's about the drive,
not about syncing.

### Offline edit merging & local version history
If you habitually edit on multiple offline devices, sync reconciliation is where
edits get hurt: file-sync tools either keep one version and drop the other next
to it as a conflict copy (Syncthing `.sync-conflict-…`, Dropbox/Nextcloud
"conflicted copy"), or silently pick a winner / auto-merge (Obsidian Sync). With
**offline edit merging** on, Sync Sentinel:

- remembers every version of your text files as they change (immediately, on
  each save — deduplicated by content, compacted over time, stored in the
  sync-excluded archive folder so each device keeps the ancestors *it* saw),
- three-way merges conflict copies against the common ancestor, whatever tool
  wrote them: edits to **different parts** of a note combine automatically;
  edits to the **same lines** are flagged in the registry for one-click
  resolution (merge with markers / keep this device's / take the synced copy) —
  never guessed, and
- gives every file a **local version history**: right-click → *Sync Sentinel:
  version history* (or the command) to preview and restore any remembered
  version. That is what removes the deadline — a silent last-writer-wins
  overwrite or a bad automatic merge is fixable **whenever** you notice, not
  only while your sync service's server-side history lasts. Restores are
  non-destructive: the replaced content becomes a version too.

Both originals are always preserved before any merge (a copy of every resolved
conflict is kept), and the conflict file goes to Obsidian's trash, not deletion.
Off by default. Auto-apply of clean merges can be disabled separately.

### Archive validation
*Validate keeper archives against synced shards* hash-checks every tracked file
both ways: are the synced shards complete and uncorrupted, and does this
device's cold archive still match what the manifest promised? Orphaned archive
sets (no matching manifest) are surfaced too. Results show in the registry.

### Retention
Local safety copies (mirror versions, merge ancestors, resolved-conflict
copies) accumulate forever by default — **nothing is deleted by age until you
opt in**, choosing the age threshold and cadence. Each file's newest copy
always survives, and keeper shard archives are never age-purged (they answer to
the keeper/purge-gate protocol instead). A dry-run preview command shows what a
purge would remove before you enable anything.

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
- Scan for sync conflicts and merge offline edits
- Recover active note: browse & restore version history
- Restore active note to last healthy version
- Rescue blanked notes now (open tabs)
- Validate keeper archives against synced shards
- Preview retention purge (dry run) / Run retention purge now

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
