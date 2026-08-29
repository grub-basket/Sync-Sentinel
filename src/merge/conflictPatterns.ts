// Conflict-copy filename patterns for the sync tools people actually use.
// Pure (no Obsidian, no Node) so it's unit-testable.
//
// The weaver is deliberately TOOL-AGNOSTIC: anything that resolves offline
// divergence by dropping a renamed sibling next to the "winner" feeds the same
// merge machinery. (Obsidian Sync is the exception — it merges .md content
// itself rather than writing conflict files; the base-store version history is
// what protects those users, since a bad automatic merge or last-writer-wins
// overwrite can be restored from local snapshots at any time.)

interface Pattern {
  tool: string;
  re: RegExp;
  /** Build the original path from the regex match. */
  original: (m: RegExpExecArray) => string;
}

const PATTERNS: Pattern[] = [
  {
    // Syncthing: `Note.sync-conflict-20260825-101010-ABC1234.md`
    tool: "syncthing",
    re: /^(.*)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+(\.[^.\/]+)?$/,
    original: (m) => m[1] + (m[2] ?? ""),
  },
  {
    // Dropbox: `Note (Devicename's conflicted copy 2026-08-25).md`
    // Also bare `Note (conflicted copy 2026-08-25).md`.
    tool: "dropbox",
    re: /^(.*) \([^)]*conflicted copy[^)]*\)(\.[^.\/]+)?$/,
    original: (m) => m[1] + (m[2] ?? ""),
  },
  {
    // Nextcloud/ownCloud: `Note (conflict 2026-08-25 101010).md` and older
    // `Note_conflict-20260825-101010.md` styles.
    tool: "nextcloud",
    re: /^(.*) \(conflict[^)]*\)(\.[^.\/]+)?$/,
    original: (m) => m[1] + (m[2] ?? ""),
  },
  {
    tool: "nextcloud",
    re: /^(.*)_conflict-\d{8}-\d{6}(\.[^.\/]+)?$/,
    original: (m) => m[1] + (m[2] ?? ""),
  },
];

/** If `path` is a conflict copy, return the original's path; else null. */
export function conflictOriginalPath(path: string): string | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(path);
    if (m) {
      const orig = p.original(m);
      // A "conflict copy" whose reconstructed original is empty or identical
      // is not a conflict copy (defensive).
      if (orig && orig !== path) return orig;
    }
  }
  return null;
}

export function isSyncConflictPath(path: string): boolean {
  return conflictOriginalPath(path) !== null;
}
