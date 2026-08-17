// Secret storage for the backup encryption key, in preference order:
//   1. Obsidian's first-party SecretStorage API (app.secretStorage, since
//      1.11.4) — stores in the OS keychain, keyed to the vault.
//   2. Electron safeStorage (OS keychain) when reachable from the renderer.
//   3. Obfuscated plugin-data storage (clearly flagged as insecure).
import { App } from "obsidian";
import { crypto } from "../util/fsutil";
import { warn, log } from "../util/log";

const SECRET_ID = "sync-sentinel-backup-key";

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

type ObsidianSecrets = {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
  listSecrets(): string[];
};

function probeSafeStorage(): SafeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron");
    const candidates = [electron?.safeStorage, electron?.remote?.safeStorage];
    for (const c of candidates) {
      if (c && typeof c.isEncryptionAvailable === "function") {
        return c as SafeStorage;
      }
    }
  } catch {
    /* not in electron */
  }
  return null;
}

export type KeyBackend = "obsidian" | "safeStorage" | "plain";

export interface KeyStoreData {
  backend?: KeyBackend;
  /** base64 of safeStorage-encrypted key (safeStorage backend only). */
  enc?: string;
  /** base64 of raw key (plain backend only — insecure). */
  plain?: string;
}

export class KeyStore {
  private safe: SafeStorage | null;
  private obs: ObsidianSecrets | null;

  constructor(app: App) {
    const maybe = (app as unknown as { secretStorage?: ObsidianSecrets })
      .secretStorage;
    this.obs =
      maybe && typeof maybe.getSecret === "function" ? maybe : null;

    // Only reach for Electron (which would `require("electron")`) if Obsidian's
    // own keychain isn't available — avoids loading a Node module needlessly.
    this.safe = this.obs ? null : probeSafeStorage();
    if (this.safe && !this.safe.isEncryptionAvailable()) this.safe = null;

    if (this.obs) log("KeyStore: using Obsidian SecretStorage (keychain).");
    else if (this.safe) log("KeyStore: using Electron safeStorage (keychain).");
    else
      warn(
        "KeyStore: no keychain available — key stored obfuscated in plugin data."
      );
  }

  get backend(): KeyBackend {
    if (this.obs) return "obsidian";
    if (this.safe) return "safeStorage";
    return "plain";
  }

  get isSecure(): boolean {
    return this.backend !== "plain";
  }

  get backendLabel(): string {
    switch (this.backend) {
      case "obsidian":
        return "Obsidian keychain (SecretStorage)";
      case "safeStorage":
        return "OS keychain (Electron safeStorage)";
      default:
        return "plugin data (insecure — no keychain available)";
    }
  }

  /** Persist a raw 32-byte key; returns the marker to store in plugin data. */
  seal(key: Buffer): KeyStoreData {
    const b64 = key.toString("base64");
    if (this.obs) {
      this.obs.setSecret(SECRET_ID, b64);
      return { backend: "obsidian" };
    }
    if (this.safe) {
      return {
        backend: "safeStorage",
        enc: this.safe.encryptString(b64).toString("base64"),
      };
    }
    return { backend: "plain", plain: b64 };
  }

  /** Recover the raw key, trying the keychain first then persisted fallbacks. */
  open(data: KeyStoreData | undefined): Buffer | null {
    // Prefer the keychain regardless of what the marker says.
    if (this.obs) {
      try {
        const b64 = this.obs.getSecret(SECRET_ID);
        if (b64) return Buffer.from(b64, "base64");
      } catch (e) {
        warn("SecretStorage.getSecret failed:", e);
      }
    }
    if (!data) return null;
    try {
      if (data.enc && this.safe) {
        const b64 = this.safe.decryptString(Buffer.from(data.enc, "base64"));
        return Buffer.from(b64, "base64");
      }
      if (data.plain) return Buffer.from(data.plain, "base64");
    } catch (e) {
      warn("KeyStore.open fallback failed:", e);
    }
    return null;
  }

  /** Remove the key from the keychain (best-effort; no delete API → blank it). */
  clear(): void {
    if (this.obs) {
      try {
        this.obs.setSecret(SECRET_ID, "");
      } catch {
        /* ignore */
      }
    }
  }

  static generateKey(): Buffer {
    return crypto.randomBytes(32);
  }
}
