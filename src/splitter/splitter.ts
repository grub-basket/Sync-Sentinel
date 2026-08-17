// Core split/merge engine operating on absolute filesystem paths.
// Streams data chunk-by-chunk so memory stays flat regardless of file size.
import { fs, fsp, path, crypto } from "../util/fsutil";
import { ensureDir, exists, writeAtomic } from "../util/fsutil";
import type { ShardEntry } from "../types";

export interface SplitResult {
  originalSize: number;
  originalSha256: string;
  shards: ShardEntry[];
}

/**
 * Split `srcAbs` into chunk files inside `shardDirAbs`.
 * Shards are named NNNN.<ext> (zero-padded). Returns hashes + sizes.
 */
export async function splitFile(
  srcAbs: string,
  shardDirAbs: string,
  chunkSize: number,
  ext: string,
  onProgress?: (done: number, total: number) => void
): Promise<SplitResult> {
  await ensureDir(shardDirAbs);
  const total = (await fsp.stat(srcAbs)).size;
  const overall = crypto.createHash("sha256");
  const shards: ShardEntry[] = [];

  const fd = await fsp.open(srcAbs, "r");
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let index = 0;
    let done = 0;
    while (true) {
      const { bytesRead } = await fd.read(buf, 0, chunkSize, done);
      if (bytesRead === 0) break;
      const slice = buf.subarray(0, bytesRead);
      overall.update(slice);
      const shardHash = crypto.createHash("sha256").update(slice).digest("hex");
      const name = `${String(index).padStart(5, "0")}.${ext}`;
      await writeAtomic(path.join(shardDirAbs, name), slice);
      shards.push({ index, name, size: bytesRead, sha256: shardHash });
      index++;
      done += bytesRead;
      onProgress?.(done, total);
      if (bytesRead < chunkSize) break;
    }
  } finally {
    await fd.close();
  }

  return {
    originalSize: total,
    originalSha256: overall.digest("hex"),
    shards,
  };
}

/**
 * Reassemble shards (in order) into `destAbs`, verifying each shard hash and
 * the overall hash. Writes to a temp file then renames into place.
 */
export async function mergeShards(
  shardDirAbs: string,
  shards: ShardEntry[],
  destAbs: string,
  expectedSha256: string,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const ordered = [...shards].sort((a, b) => a.index - b.index);
  const total = ordered.reduce((s, x) => s + x.size, 0);
  await ensureDir(path.dirname(destAbs));
  const tmp = destAbs + ".ssmerge-" + process.pid;
  const overall = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let done = 0;
  try {
    for (const sh of ordered) {
      const shardPath = path.join(shardDirAbs, sh.name);
      const data = await fsp.readFile(shardPath);
      const h = crypto.createHash("sha256").update(data).digest("hex");
      if (h !== sh.sha256) {
        throw new Error(
          `Shard hash mismatch for ${sh.name} (got ${h.slice(0, 8)}, want ${sh.sha256.slice(0, 8)})`
        );
      }
      overall.update(data);
      await new Promise<void>((res, rej) =>
        out.write(data, (e) => (e ? rej(e) : res()))
      );
      done += data.length;
      onProgress?.(done, total);
    }
    await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));
    const got = overall.digest("hex");
    if (got !== expectedSha256) {
      throw new Error(
        `Reassembled file hash mismatch (got ${got.slice(0, 8)}, want ${expectedSha256.slice(0, 8)})`
      );
    }
    await fsp.rename(tmp, destAbs);
  } catch (e) {
    try {
      if (await exists(tmp)) await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** True when every shard file exists in the dir. (cheap presence check) */
export async function allShardsPresent(
  shardDirAbs: string,
  shards: ShardEntry[]
): Promise<boolean> {
  for (const sh of shards) {
    if (!(await exists(path.join(shardDirAbs, sh.name)))) return false;
  }
  return true;
}
