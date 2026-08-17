// Streaming AES-256-GCM file encryption.
// Output layout: [magic "SSE1"(4)] [iv(12)] [ciphertext...] [authTag(16)]
import { fs, fsp, crypto } from "../util/fsutil";
import { ensureDir, path } from "../util/fsutil";

const MAGIC = Buffer.from("SSE1");
const IV_LEN = 12;
const TAG_LEN = 16;

export async function encryptFile(
  srcAbs: string,
  destAbs: string,
  key: Buffer
): Promise<void> {
  await ensureDir(path.dirname(destAbs));
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const tmp = destAbs + ".ssenc-" + process.pid;
  const out = fs.createWriteStream(tmp);
  out.write(MAGIC);
  out.write(iv);

  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(srcAbs);
    input.on("error", reject);
    cipher.on("error", reject);
    cipher.on("data", (d) => out.write(d));
    cipher.on("end", () => {
      const tag = cipher.getAuthTag();
      out.end(tag, () => resolve());
    });
    out.on("error", reject);
    input.pipe(cipher);
  });
  await fsp.rename(tmp, destAbs);
}

export async function decryptFile(
  srcAbs: string,
  destAbs: string,
  key: Buffer
): Promise<void> {
  await ensureDir(path.dirname(destAbs));
  const stat = await fsp.stat(srcAbs);
  const headerLen = MAGIC.length + IV_LEN;
  if (stat.size < headerLen + TAG_LEN) {
    throw new Error("Encrypted file too small / corrupt.");
  }
  const fd = await fsp.open(srcAbs, "r");
  try {
    const header = Buffer.allocUnsafe(headerLen);
    await fd.read(header, 0, headerLen, 0);
    if (!header.subarray(0, 4).equals(MAGIC)) {
      throw new Error("Bad magic — not a Sync Sentinel encrypted file.");
    }
    const iv = header.subarray(4, 4 + IV_LEN);
    const tag = Buffer.allocUnsafe(TAG_LEN);
    await fd.read(tag, 0, TAG_LEN, stat.size - TAG_LEN);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const tmp = destAbs + ".ssdec-" + process.pid;
    const out = fs.createWriteStream(tmp);
    const bodyStart = headerLen;
    const bodyEnd = stat.size - TAG_LEN - 1; // inclusive
    await new Promise<void>((resolve, reject) => {
      const input = fs.createReadStream(srcAbs, {
        start: bodyStart,
        end: bodyEnd,
      });
      input.on("error", reject);
      decipher.on("error", reject);
      decipher.on("data", (d) => out.write(d));
      decipher.on("end", () => out.end(() => resolve()));
      out.on("error", reject);
      input.pipe(decipher);
    });
    await fsp.rename(tmp, destAbs);
  } finally {
    await fd.close();
  }
}
