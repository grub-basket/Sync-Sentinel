// Node fs helpers used across modules. Desktop-only.
//
// IMPORTANT: Obsidian shows a per-module notification when a plugin require()s a
// Node/Electron module at the TOP LEVEL during plugin evaluation. Per Obsidian's
// own guidance we therefore load these modules LAZILY (on first use), not at
// module load. The proxies below only call require() when a property is first
// accessed, so a plain Obsidian reload triggers no module loads / no flurry.
import type * as fsTypes from "fs";

function lazyMod<T extends object>(load: () => T): T {
  let m: T | undefined;
  return new Proxy({} as T, {
    get: (_t, p) => (m ??= load())[p as keyof T],
    has: (_t, p) => p in (m ??= load()),
  });
}

export const fs = lazyMod(() => require("fs")) as typeof import("fs");
export const fsp = lazyMod(() => require("fs/promises")) as typeof import("fs/promises");
export const path = lazyMod(() => require("path")) as typeof import("path");
export const crypto = lazyMod(() => require("crypto")) as typeof import("crypto");
export const os = lazyMod(() => require("os")) as typeof import("os");

/** sha256 of an arbitrary file, streamed (constant memory). */
export async function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(absPath);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function hashString(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function exists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(absDir: string): Promise<void> {
  await fsp.mkdir(absDir, { recursive: true });
}

export async function statSafe(absPath: string): Promise<fsTypes.Stats | null> {
  try {
    return await fsp.stat(absPath);
  } catch {
    return null;
  }
}

/** Copy a file atomically-ish: write to a temp sibling then rename. */
export async function copyAtomic(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  const tmp = dest + ".sstmp-" + process.pid;
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dest);
}

/** Write a buffer/string atomically. */
export async function writeAtomic(
  dest: string,
  data: Buffer | string
): Promise<void> {
  await ensureDir(path.dirname(dest));
  const tmp = dest + ".sstmp-" + process.pid;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, dest);
}

/** Recursively list files under a dir, returning absolute paths. */
export async function walk(absDir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    let entries: fsTypes.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await rec(absDir);
  return out;
}

/**
 * A vault-relative path is safe iff it's relative, has no `..` escape, and is
 * not absolute. Synced manifests are untrusted input, so every path that came
 * from a manifest must pass this before we touch the filesystem with it.
 */
export function isSafeVaultRel(rel: string): boolean {
  if (!rel || typeof rel !== "string") return false;
  if (path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel.replace(/\\/g, "/"));
  if (norm === ".." || norm.startsWith("../") || norm.startsWith("..\\")) return false;
  if (norm.split(/[\\/]/).includes("..")) return false;
  return true;
}

/** A shard file name must be a bare name (no path separators, no `..`). */
export function isSafeShardName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

export function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
