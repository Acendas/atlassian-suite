// Inline-comment anchor preservation across a page rewrite.
//
// Confluence binds an inline comment to the page BODY, not to a stable
// server-side coordinate:
//
//     <ac:inline-comment-marker ac:ref="8f3e…">Adjustment</ac:inline-comment-marker>
//
// The comment thread lives server-side keyed by that ref. Republish a body
// without the marker element and the comment survives as an orphan —
// Confluence reports it with resolution status `dangling` and it stops
// showing on the page. That is the exact loss a wholesale docs->Confluence
// sync causes, and why a full-body republish is unsafe on any page that has
// been reviewed.
//
// So a publisher has to carry markers across the rewrite: pull them off the
// old storage, re-wrap the same text in the newly rendered storage.
//
// The contract that makes this safe is NOT "always succeeds" — it can't.
// If a reviewer anchored a comment to a sentence the author has since
// deleted, no amount of cleverness re-anchors it. The contract is that
// every anchor is accounted for: each one comes back either `preserved` or
// `unmatched`, and callers surface `unmatched` BEFORE writing. Silent loss
// is the bug; reported loss is a decision.
//
// Like _storage.ts these are regex-on-XML, not a parser — same tradeoff,
// same reasoning (see that file's header).

import { escapeAttr } from "./_storage.js";

/** One inline-comment anchor lifted off a page body. */
export interface Anchor {
  /** The `ac:ref` value binding this marker to its server-side thread. */
  ref: string;
  /** Inner XML of the marker, verbatim. */
  innerRaw: string;
  /** Visible text of the anchor, tags stripped — what we re-match on. */
  text: string;
  /** Which occurrence of `text` within the old body this was (1-based).
   *  Used to disambiguate when the text repeats. */
  occurrence: number;
  /** Up to 40 chars of visible text immediately before / after the anchor.
   *  Tie-breaker when occurrence counts differ between old and new bodies. */
  before: string;
  after: string;
}

export interface ApplyResult {
  storage: string;
  preserved: Anchor[];
  unmatched: Anchor[];
}

const MARKER_RE =
  /<ac:inline-comment-marker\s+(?:ac:)?ref="([^"]+)"\s*>([\s\S]*?)<\/ac:inline-comment-marker>/gi;

const CONTEXT_CHARS = 40;

/** Strip inline tags and decode the common entities. Mirrors _storage.ts's
 *  private stripTags — duplicated rather than exported from there because
 *  these two callers want to diverge over time (this one must also drop
 *  CDATA payloads). */
function visibleText(s: string): string {
  return s
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Spans of the storage blob that are real text content — i.e. everything
 * that is not a tag, an XML comment, or the payload of a CDATA section.
 *
 * Anchors may only ever be placed in these spans. Wrapping text inside an
 * attribute value would corrupt the XML, and wrapping inside a CDATA block
 * (a code-macro body) would put literal marker markup on screen inside the
 * user's code sample rather than anchoring anything.
 */
export function textSpans(storage: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const skip = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = skip.exec(storage)) !== null) {
    if (m.index > cursor) spans.push({ start: cursor, end: m.index });
    cursor = m.index + m[0].length;
  }
  if (cursor < storage.length) spans.push({ start: cursor, end: storage.length });
  return spans;
}

/**
 * Every position at which `needle` occurs inside a text span, in document
 * order. A hit that would straddle a tag boundary is not a hit — the anchor
 * text has to live in one contiguous text node for us to be able to wrap it
 * without restructuring the markup.
 *
 * That restriction is why an anchor over `<strong>Adj</strong>ustment` comes
 * back unmatched rather than half-wrapped: splitting one marker across an
 * element boundary needs two markers sharing a ref, and Confluence treats
 * that as two anchors. Reporting it is the honest outcome.
 */
export function findInText(storage: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  for (const span of textSpans(storage)) {
    const chunk = storage.slice(span.start, span.end);
    let idx = chunk.indexOf(needle);
    while (idx !== -1) {
      out.push(span.start + idx);
      idx = chunk.indexOf(needle, idx + 1);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Lift every inline-comment marker off a page body. */
export function extractAnchors(storage: string): Anchor[] {
  const out: Anchor[] = [];
  const seenText = new Map<string, number>();
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(storage)) !== null) {
    const innerRaw = m[2];
    const text = visibleText(innerRaw).trim();
    const n = (seenText.get(text) ?? 0) + 1;
    seenText.set(text, n);
    out.push({
      ref: m[1],
      innerRaw,
      text,
      occurrence: n,
      before: visibleText(storage.slice(Math.max(0, m.index - 200), m.index)).slice(
        -CONTEXT_CHARS,
      ),
      after: visibleText(
        storage.slice(m.index + m[0].length, m.index + m[0].length + 200),
      ).slice(0, CONTEXT_CHARS),
    });
  }
  return out;
}

/** Remove marker elements, keeping their inner content. Used to compare an
 *  old body against a freshly rendered one without the markers themselves
 *  showing up as a difference. */
export function stripAnchors(storage: string): string {
  return storage.replace(MARKER_RE, "$2");
}

/**
 * Re-apply anchors to a freshly rendered body.
 *
 * Anchors are applied right-to-left by insertion offset so that each splice
 * leaves earlier offsets valid — the standard trick for multiple edits to one
 * string, and the reason this doesn't need to re-scan after every insert.
 *
 * Match selection, in order of preference:
 *   1. the same occurrence index the anchor had in the old body
 *   2. if the occurrence count changed, the candidate whose surrounding text
 *      best matches the remembered before/after context
 * A candidate already claimed by another anchor is never reused, so two
 * comments on the same repeated phrase can't collapse onto one spot.
 */
export function applyAnchors(storage: string, anchors: Anchor[]): ApplyResult {
  const preserved: Anchor[] = [];
  const unmatched: Anchor[] = [];
  const claimed = new Set<number>();
  const inserts: Array<{ at: number; len: number; anchor: Anchor }> = [];

  for (const anchor of anchors) {
    // Index occurrences against ALL hits, not just unclaimed ones — otherwise
    // claiming occurrence 1 shifts every later anchor's index by one and
    // occurrence 2 silently lands on occurrence 3.
    const all = findInText(storage, anchor.text);
    const free = all.filter((i) => !claimed.has(i));
    if (free.length === 0) {
      unmatched.push(anchor);
      continue;
    }

    const byOccurrence = all[anchor.occurrence - 1];
    let chosen: number;
    if (byOccurrence !== undefined && !claimed.has(byOccurrence)) {
      chosen = byOccurrence;
    } else if (free.length === 1) {
      chosen = free[0];
    } else {
      chosen = bestByContext(storage, free, anchor);
    }

    claimed.add(chosen);
    inserts.push({ at: chosen, len: anchor.text.length, anchor });
    preserved.push(anchor);
  }

  inserts.sort((a, b) => b.at - a.at);
  let next = storage;
  for (const ins of inserts) {
    const head = next.slice(0, ins.at);
    const body = next.slice(ins.at, ins.at + ins.len);
    const tail = next.slice(ins.at + ins.len);
    next = `${head}<ac:inline-comment-marker ac:ref="${escapeAttr(
      ins.anchor.ref,
    )}">${body}</ac:inline-comment-marker>${tail}`;
  }

  return { storage: next, preserved, unmatched };
}

/** Score candidates by how much of the remembered before/after context still
 *  surrounds them, and take the best. Ties resolve to the earliest candidate,
 *  which keeps the result deterministic. */
function bestByContext(storage: string, candidates: number[], anchor: Anchor): number {
  let best = candidates[0];
  let bestScore = -1;
  for (const at of candidates) {
    const before = visibleText(storage.slice(Math.max(0, at - 200), at)).slice(
      -CONTEXT_CHARS,
    );
    const after = visibleText(
      storage.slice(at + anchor.text.length, at + anchor.text.length + 200),
    ).slice(0, CONTEXT_CHARS);
    const score = commonSuffix(before, anchor.before) + commonPrefix(after, anchor.after);
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return best;
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
