// Pure helpers for detecting a "blanked" note — the network/cloud-drive failure
// where an open file is truncated to empty (or its body wiped, frontmatter left
// behind) while Obsidian holds it. No Obsidian, no Node — unit-testable.

/** Strip a leading YAML frontmatter block, returning just the body. */
export function bodyOf(content: string): string {
  // Frontmatter must be the very first thing: `---\n ... \n---`.
  if (!content.startsWith("---")) return content;
  // Match the opening fence line, then content, then a closing `---` line.
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return content; // unterminated frontmatter → treat whole thing as body
  return content.slice(m[0].length);
}

/** Count of non-whitespace characters. */
export function nonWsLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // skip space, tab, CR, LF, form feed, vertical tab, and the BOM/nbsp
    if (c === 32 || c === 9 || c === 13 || c === 10 || c === 12 || c === 11 || c === 0xfeff || c === 0xa0) {
      continue;
    }
    n++;
  }
  return n;
}

/** A note "looks blank" when its body has no meaningful (non-whitespace) text. */
export function looksBlank(content: string): boolean {
  return nonWsLen(bodyOf(content)) === 0;
}

/** Minimum prior body size for a blanking to be worth flagging. */
export const BLANK_MIN_PRIOR = 20;

/**
 * Is going from `prev` → `next` a suspicious blanking (as opposed to a normal
 * edit that happens to shorten the file)? True only when the body had real
 * content and is now entirely empty. Deliberately conservative: a partial
 * shrink is NOT flagged — only a full body wipe, which is what the drive glitch
 * produces and what a human almost never does by accident to an open note.
 */
export function isBlankingEvent(prev: string, next: string): boolean {
  return nonWsLen(bodyOf(prev)) >= BLANK_MIN_PRIOR && nonWsLen(bodyOf(next)) === 0;
}
