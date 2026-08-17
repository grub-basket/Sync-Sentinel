// Tiny logger gated on the debug setting.

let debugEnabled = false;

export function setDebug(v: boolean): void {
  debugEnabled = v;
}

export function log(...args: unknown[]): void {
  if (debugEnabled) console.log("[Sync Sentinel]", ...args);
}

export function warn(...args: unknown[]): void {
  console.warn("[Sync Sentinel]", ...args);
}

export function error(...args: unknown[]): void {
  console.error("[Sync Sentinel]", ...args);
}
