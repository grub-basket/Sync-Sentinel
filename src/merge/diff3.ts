// Pure three-way merge engine (no Obsidian, no Node — unit-testable anywhere).
//
// Why this and not a "real" CRDT: a CRDT needs every edit to flow through an
// operation log, but Obsidian writes plain markdown and Syncthing syncs whole
// files — neither will ever emit CRDT ops. The practical equivalent for
// file-synced markdown is ancestor-based three-way merging: given the last
// common version (the base), edits that touch DIFFERENT regions merge cleanly
// and automatically — which is the actual multi-offline-device convergence
// people want from a CRDT — while true overlapping edits are surfaced as
// conflicts instead of being silently lost. The base store (baseStore.ts)
// supplies the ancestors; this file supplies the merge.
//
// Diff: patience diff (match lines unique to both sides, longest increasing
// subsequence, recurse between anchors). Robust on prose/markdown, never
// O(n*m) memory, and degrades gracefully (unmatched region = replace).

/** Map from a-index to b-index for matched (equal) lines; -1 = unmatched. */
export function matchLines(a: string[], b: string[]): Int32Array {
  const m = new Int32Array(a.length).fill(-1);
  patience(a, 0, a.length, b, 0, b.length, m);
  return m;
}

function patience(
  a: string[], lo1: number, hi1: number,
  b: string[], lo2: number, hi2: number,
  out: Int32Array
): void {
  // Trim common prefix.
  while (lo1 < hi1 && lo2 < hi2 && a[lo1] === b[lo2]) {
    out[lo1] = lo2;
    lo1++; lo2++;
  }
  // Trim common suffix.
  while (hi1 > lo1 && hi2 > lo2 && a[hi1 - 1] === b[hi2 - 1]) {
    out[hi1 - 1] = hi2 - 1;
    hi1--; hi2--;
  }
  if (lo1 >= hi1 || lo2 >= hi2) return;

  // Lines unique within each side, present in both.
  const countA = new Map<string, number>();
  const posA = new Map<string, number>();
  for (let i = lo1; i < hi1; i++) {
    countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
    posA.set(a[i], i);
  }
  const countB = new Map<string, number>();
  const posB = new Map<string, number>();
  for (let j = lo2; j < hi2; j++) {
    countB.set(b[j], (countB.get(b[j]) ?? 0) + 1);
    posB.set(b[j], j);
  }
  const pairs: Array<[number, number]> = [];
  for (const [line, c] of countA) {
    if (c === 1 && countB.get(line) === 1) {
      pairs.push([posA.get(line)!, posB.get(line)!]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  if (pairs.length === 0) return; // no anchors — whole region is a replace

  // Longest increasing subsequence on the b-indices (classic patience sort).
  const tailsIdx: number[] = []; // indices into `pairs` of pile tops
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const bv = pairs[k][1];
    let lo = 0, hi = tailsIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tailsIdx[mid]][1] < bv) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tailsIdx[lo - 1];
    tailsIdx[lo] = k;
  }
  const anchors: Array<[number, number]> = [];
  let k = tailsIdx.length ? tailsIdx[tailsIdx.length - 1] : -1;
  while (k !== -1) {
    anchors.push(pairs[k]);
    k = prev[k];
  }
  anchors.reverse();

  // Record anchors, recurse between them.
  let pa = lo1, pb = lo2;
  for (const [ai, bi] of anchors) {
    patience(a, pa, ai, b, pb, bi, out);
    out[ai] = bi;
    pa = ai + 1;
    pb = bi + 1;
  }
  patience(a, pa, hi1, b, pb, hi2, out);
}

export interface Diff3Result {
  /** True when every region merged without overlap. */
  clean: boolean;
  /** Merged text. When not clean, conflicting regions carry git-style markers. */
  text: string;
  /** Number of conflicting regions. */
  conflicts: number;
}

/** One change hunk: base[bs..be) was replaced by side[ss..se). */
interface Hunk {
  bs: number;
  be: number;
  ss: number;
  se: number;
}

/** Extract change hunks from a match array (base → side). */
function hunksOf(m: Int32Array, baseLen: number, sideLen: number): Hunk[] {
  const res: Hunk[] = [];
  let i = 0;
  let s = 0;
  while (i < baseLen || s < sideLen) {
    if (i < baseLen && m[i] === s) {
      i++;
      s++;
      continue;
    }
    // Hunk start: scan to the next base line matched at-or-after the cursor.
    const bs = i;
    const ss = s;
    let j = i;
    while (j < baseLen && (m[j] === -1 || m[j] < s)) j++;
    const se = j < baseLen ? m[j] : sideLen;
    res.push({ bs, be: j, ss, se });
    i = j;
    s = se;
  }
  return res;
}

/**
 * Reconstruct one side's content for a coalesced region [bs..be): walk the
 * base positions, emitting this side's hunk replacements where they apply and
 * the (matched) base lines everywhere else. Positions inside the region not
 * covered by this side's hunks are guaranteed matched — hunksOf covers every
 * unmatched line.
 */
function sideContent(
  S: string[],
  m: Int32Array,
  sideHunks: Hunk[],
  bs: number,
  be: number
): string[] {
  const out: string[] = [];
  let pos = bs;
  let hi = 0;
  while (pos < be || hi < sideHunks.length) {
    if (hi < sideHunks.length && sideHunks[hi].bs === pos) {
      const h = sideHunks[hi++];
      for (let j = h.ss; j < h.se; j++) out.push(S[j]);
      pos = h.be; // zero-length hunk: pos stays; the stable line at pos follows
    } else {
      out.push(S[m[pos]]);
      pos++;
    }
  }
  return out;
}

const eqArr = (x: string[], y: string[]): boolean =>
  x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * GNU/git-style diff3: change hunks from each side are computed independently
 * and coalesced only when their base ranges overlap — so a deletion on one
 * device and an edit on the very next line from another still merge cleanly.
 * Regions where only ONE side diverged take that side; identical changes
 * collapse; true overlaps become conflict regions with git-style markers.
 * (Deliberately more merging than the "formal diff3" walk, matching what
 * `git merge-file` / GNU `diff3 -m` users expect.)
 */
export function diff3(
  baseText: string,
  localText: string,
  otherText: string,
  labels: { local?: string; other?: string } = {}
): Diff3Result {
  const base = baseText.split("\n");
  const A = localText.split("\n");
  const B = otherText.split("\n");
  const ma = matchLines(base, A);
  const mb = matchLines(base, B);
  const hA = hunksOf(ma, base.length, A.length);
  const hB = hunksOf(mb, base.length, B.length);

  // Coalesce hunks from both sides into regions by overlapping base ranges.
  // Zero-length hunks (pure insertions) glue to anything touching their
  // position — two devices appending at the same spot must conflict, not be
  // silently concatenated in arbitrary order. Each region keeps its own hunks
  // per side so side content can be reconstructed exactly.
  interface Region {
    bs: number;
    be: number;
    a: Hunk[];
    b: Hunk[];
  }
  const all: Array<{ h: Hunk; side: "a" | "b" }> = [
    ...hA.map((h) => ({ h, side: "a" as const })),
    ...hB.map((h) => ({ h, side: "b" as const })),
  ].sort((x, y) => x.h.bs - y.h.bs || x.h.be - y.h.be);
  const regions: Region[] = [];
  for (const { h, side } of all) {
    const last = regions[regions.length - 1];
    const touches =
      last &&
      (h.bs < last.be ||
        (h.bs === last.be && (h.bs === h.be || last.bs === last.be)));
    if (touches) {
      last.be = Math.max(last.be, h.be);
      last[side].push(h);
    } else {
      regions.push({ bs: h.bs, be: h.be, a: [], b: [] });
      regions[regions.length - 1][side].push(h);
    }
  }

  const out: string[] = [];
  let conflicts = 0;
  let cursor = 0;
  const flushStable = (to: number) => {
    for (let i = cursor; i < to; i++) out.push(base[i]);
    cursor = to;
  };
  for (const r of regions) {
    flushStable(r.bs);
    const chunkBase = base.slice(r.bs, r.be);
    const chunkA = sideContent(A, ma, r.a, r.bs, r.be);
    const chunkB = sideContent(B, mb, r.b, r.bs, r.be);
    if (eqArr(chunkA, chunkBase)) {
      out.push(...chunkB); // only B changed
    } else if (eqArr(chunkB, chunkBase)) {
      out.push(...chunkA); // only A changed
    } else if (eqArr(chunkA, chunkB)) {
      out.push(...chunkA); // identical change on both sides
    } else {
      conflicts++;
      out.push(`<<<<<<< ${labels.local ?? "local"}`);
      out.push(...chunkA);
      out.push("||||||| base");
      out.push(...chunkBase);
      out.push("=======");
      out.push(...chunkB);
      out.push(`>>>>>>> ${labels.other ?? "other"}`);
    }
    cursor = r.be;
  }
  flushStable(base.length);

  return { clean: conflicts === 0, text: out.join("\n"), conflicts };
}
