# DIY Obsidian sync for free (desktop ↔ mobile, including iOS)

A practical, opinionated guide to syncing an Obsidian vault across your machines
and phone without paying for Obsidian Sync — and where Sync Sentinel fits in.

Everything here is free. The trade-off is setup effort and, in some cases, running
a small server yourself.

## Pick your path (30-second decision)

- **You want the simplest thing that works on iOS, and you already have (or can make)
  some cloud storage** → **Remotely Save** + an object-storage backend. Start here.
- **You want instant, real-time sync on every device and don't mind running one
  small server** → **Self-hosted LiveSync** (CouchDB). The most robust option.
- **You want true device-to-device sync with nothing sitting on anyone's server**
  → **Syncthing** (desktop/Android) + **SyncTrain** (iOS). This is the privacy
  and "transmission-only" answer.
- **Your vault is basically text and you like git** → **Obsidian Git**. Free via
  GitHub, but poor for large or binary files.

You can mix these: e.g. Syncthing between your laptops, Remotely Save for the phone.

---

## Option A — Remotely Save + object storage (easiest cross-platform)

[Remotely Save](https://github.com/remotely-save/remotely-save) is a community
plugin that syncs your vault to storage you control. It works on desktop **and**
mobile (iOS included), and supports end-to-end encryption.

Backends that have a free tier and speak S3:

- **Cloudflare R2** — 10 GB free, no egress fees. Good default.
- **Backblaze B2** — 10 GB free.
- **Supabase Storage** — S3-compatible; use it if you already run Supabase.

Steps:

1. Create a bucket on your chosen backend and an access key/secret scoped to it.
2. Install Remotely Save (Community plugins → Browse → "Remotely Save").
3. In its settings choose the S3 backend and paste the endpoint, region, bucket,
   access key, and secret.
4. Turn on **end-to-end encryption** and set a password. Write the password down
   somewhere safe — without it the remote copy is unrecoverable.
5. Repeat on each device (same bucket, same encryption password). Run a manual sync
   once, then enable auto-sync on an interval.

Notes:
- The whole vault round-trips through the bucket, so per-file size still matters on
  some backends — this is where **Sync Sentinel's splitter** earns its keep (below).
- Supabase specifically: create a Storage bucket, then use its S3 endpoint and
  service/access keys in Remotely Save.

---

## Option B — Self-hosted LiveSync (best real-time sync)

[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) syncs through a
**CouchDB** database and pushes changes live — edits appear on other devices in
about a second. Works on Windows, macOS, Linux, Android, and iOS.

You need a CouchDB somewhere both devices can reach. Free-ish ways to get one:

- Run it on a spare machine / home server (Docker: `couchdb:latest`).
- A small always-free or cheap VPS (fly.io, Oracle free tier, etc.).
- A managed CouchDB free tier (e.g. IBM Cloudant's free plan).

Steps (high level):

1. Stand up CouchDB and create a database for the vault.
2. Enable CORS on CouchDB (the plugin has a one-click "check and fix" for this).
3. Install Self-hosted LiveSync, run its **Setup wizard**, and point it at your
   CouchDB URL + credentials. Copy the generated **setup URI** to each other device
   so they join the same database with identical settings.
4. Turn on end-to-end encryption in the wizard.

It's the most capable option (real-time, conflict handling), and also the most
moving parts. If "instant" matters, it's worth it.

---

## Option C — Syncthing (+ SyncTrain on iOS): true peer-to-peer

[Syncthing](https://syncthing.net/) syncs folders **directly between your devices**.
Nothing is stored on a third party's server — a file only moves when two of your
devices are online and connected. That makes it the natural fit for privacy and for
the "files never sit on a server" model.

- Desktop (macOS/Windows/Linux) and Android: official Syncthing apps.
- **iOS: SyncTrain** — a free Syncthing-compatible client (2026). This is the piece
  that finally makes Syncthing practical on iPhone/iPad, working around iOS's
  restriction on background daemons and arbitrary folder access.

Steps:

1. Install Syncthing on your computer; add your vault folder as a shared folder.
2. Install the app on each other device and pair them by scanning/entering device
   IDs (they authenticate each other directly).
3. Share the vault folder to each paired device and let it sync.

Caveats:
- Both ends must be online at the same time to exchange changes (there's no
  always-on server holding a copy). On a LAN it's instant; across the internet it
  uses encrypted relays for connectivity only.
- On iOS, background sync is limited by the OS — you may need to open the app to
  let a sync finish.

**Sync Sentinel's Syncthing mode.** Turn on *Syncthing / P2P mode* in Sync
Sentinel's settings and it will manage a `.stignore` entry in your vault root that
excludes its keeper **archive** folder from Syncthing. This matters because when a
keeper stores a cold copy of shards to reclaim space, that copy must not sync — and
unlike Obsidian Sync (whose exclusions the plugin can't touch), Syncthing's
exclusions are just a file the plugin can write for you. It only touches its own
managed block and leaves your other `.stignore` rules alone.

---

## Option D — Obsidian Git (text-first)

[Obsidian Git](https://github.com/Vinzent03/obsidian-git) commits your vault to a
git repo (e.g. a free private GitHub repo) and works on mobile via a pure-JS git
implementation. Great for mostly-text vaults and full history; a poor fit for large
or binary attachments, which bloat the repo.

---

## Where Sync Sentinel fits

Sync Sentinel is **transport-agnostic** — it rides on top of whichever option above
you choose, and solves the problems those transports don't:

- **Large files that won't sync.** Many backends silently skip files past a size
  limit. Sync Sentinel splits them into small, sync-friendly shards and reassembles
  them, verified by hash, on your other devices.
- **Knowing which device has what.** Its device ledger and command center show which
  devices hold each large file, so you're never guessing.
- **Reclaiming space.** Once every device has a file (or has opted out), a keeper
  device archives the shards locally and you can purge the synced copies.
- **Safety nets.** One-way encrypted backups, an on-disk mirror of recently changed
  files (so a bad sync can't silently destroy work), and sync-log archiving.

## A note on secrets

Store backend credentials and encryption passwords carefully. Recent Obsidian
versions include a first-party keychain (**Secret Storage**, `app.secretStorage`),
and Sync Sentinel uses it for its own encryption key. Some sync plugins are moving
to it too; prefer that over pasting secrets into plain settings where a plugin
offers it. Whatever you do, keep an offline copy of any encryption password — losing
it means losing the encrypted data.

---

Sources and further reading: the plugin repos linked above, the Obsidian community
forum's self-hosting threads, and independent 2026 write-ups on free Obsidian sync.
