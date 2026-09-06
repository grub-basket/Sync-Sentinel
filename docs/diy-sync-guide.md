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
- **You're on a locked-down work computer with no admin rights** (can't install
  Syncthing or run a server) → **Supabase Storage + Remotely Save**. Everything is
  an Obsidian plugin plus a cloud account — nothing to install on the machine, so
  it slips past corporate IT restrictions. See **Option A-Supabase** below.

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

---

## Option A-Supabase — Supabase Storage step-by-step (no admin install needed)

This is the same Remotely Save mechanism as Option A, spelled out for
[Supabase](https://supabase.com) — the path to reach for when you **can't install
anything** on the computer (locked-down work laptop, no admin rights). Remotely
Save is just an Obsidian community plugin, and Supabase is a website, so there's
nothing for IT to block.

Why it works: Supabase Storage exposes an **S3-compatible API**, and Remotely Save
already speaks S3. So Supabase is "your own S3 bucket" with a free tier and a
friendly dashboard.

> **Verify the specifics against your own account.** Supabase changes its
> dashboard and free-tier limits over time. The exact menu path for the S3
> credentials, whether path-style addressing is required, and the current free
> Storage cap may differ from what's written here — treat the steps below as a
> map, not gospel, and confirm as you go.

1. **Make a project.** Sign up at supabase.com, create a new project (pick the
   region closest to you). Wait for it to finish provisioning.
2. **Create a bucket.** Left sidebar → **Storage** → **New bucket**. Name it
   (e.g. `obsidian`), and keep it **Private**. (Your notes should never be a
   public bucket.)
3. **Get S3 credentials.** Project **Settings → Storage → S3 Connection**. Note
   the **Endpoint** (looks like `https://<project-ref>.supabase.co/storage/v1/s3`)
   and the **Region** shown there. Then generate an **S3 access key** — this gives
   you an **Access key ID** and a **Secret access key**. Copy both now; the secret
   is shown only once.
4. **Configure Remotely Save.** In Obsidian → Community plugins → Browse →
   install **Remotely Save**. Open its settings, choose the **S3** backend, and
   fill in: Endpoint, Region, Bucket (`obsidian`), Access key ID, Secret access
   key. If there's an **S3 URL style / "force path-style"** option, set it to
   **path-style** (Supabase uses path-style addressing).
5. **Turn on end-to-end encryption.** Set a Remotely Save encryption password.
   This matters more here than usual: without it, your notes sit in Supabase as
   plaintext that Supabase (and anyone with the keys) could read. **Write the
   password down** — lose it and the remote copy is unrecoverable.
6. **First sync + repeat.** Run one manual sync, confirm files land in the bucket
   (Storage view), then enable auto-sync. Do the same on your phone and other
   machines — **same bucket, same encryption password**.

Watch-outs:
- **Free-tier limits.** Supabase's free plan caps storage and monthly egress
  (on the order of ~1 GB storage — check the current number on their pricing
  page). A media-heavy vault will outgrow it; a text vault is fine for a long
  time. Sync Sentinel's splitter also keeps any single object under a per-file
  ceiling, so large attachments don't fail the upload.
- **Path-style addressing:** if syncing errors out with bucket/endpoint errors,
  the path-style vs virtual-host setting is the first thing to flip.
- This is transmission-through-a-server, not peer-to-peer. If you specifically
  want "nothing sits on a server," that's **Option C (Syncthing)** — but that
  needs an install, which is exactly what this option avoids.

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
