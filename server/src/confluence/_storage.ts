// Pure string manipulation for Confluence storage-format XML.
//
// These helpers are deliberately separated from edits.ts so they can be
// unit-tested against captured storage XML fixtures without network or
// MCP machinery in the way. The storage format is XHTML-ish with
// Atlassian custom elements (<ac:image>, <ac:structured-macro>, etc.) —
// we treat it as text + regex, not a real DOM, because Confluence's
// accepted writeback format is lenient on whitespace but strict on
// preserving ac:/ri: prefixes and structured-macro `ac:macro-id`
// attributes.
//
// These helpers are regex-on-XML. They are best-effort, NOT a parser.
// If a heading contains a nested `<h2>` inside a macro body, or a code
// block contains a literal `</h1>`, results may be wrong. For the common
// case (normal Confluence pages with headings as real h1-h6 elements),
// they work and are fast.

export interface HeadingInfo {
  start: number;    // index of '<' in the heading open tag
  end: number;      // index just past the '>' of the heading close tag
  level: number;    // 1..6
  text: string;     // visible text (tags stripped)
}

/** Find every `<hN>...</hN>` in the storage blob, case-insensitive.
 *  Nested tags inside the heading content are kept but stripped for
 *  `text`. This tolerates attribute-bearing open tags like
 *  `<h2 id="foo">Bar</h2>` and lowercase/uppercase tag names. */
export function findHeadings(storage: string): HeadingInfo[] {
  const re = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
  const out: HeadingInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(storage)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      level: parseInt(m[1], 10),
      text: stripTags(m[2]).trim(),
    });
  }
  return out;
}

/** Strip inline HTML-ish tags and decode the most common entities.
 *  Used only for text-match comparison — not for rendering.
 *
 *  We intentionally do NOT attempt to decode numeric entities or the
 *  full HTML5 entity set. Heading text in Confluence is overwhelmingly
 *  plain, and full decoding would require a dependency.  */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Locate a section defined by a heading. A "section" is the heading
 *  itself plus everything up to (but not including) the next heading of
 *  the same or shallower level. Returns null if no heading matches.
 *  `textLocator` matches a case-insensitive substring of visible text. */
export function locateSection(
  storage: string,
  level: number,
  textLocator: string,
): {
  headingStart: number;
  headingEnd: number;
  sectionEnd: number;
} | null {
  const needle = textLocator.toLowerCase();
  const headings = findHeadings(storage);
  const target = headings.find(
    (h) => h.level === level && h.text.toLowerCase().includes(needle),
  );
  if (!target) return null;
  const nextBoundary = headings.find(
    (h) => h.start > target.start && h.level <= target.level,
  );
  return {
    headingStart: target.start,
    headingEnd: target.end,
    sectionEnd: nextBoundary ? nextBoundary.start : storage.length,
  };
}

/** Escape a string for use inside a double-quoted XML attribute value. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the storage XML for embedding an attachment as an image macro.
 *  Pure string function — used by confluence_render_image_macro. */
export function renderImageMacro(opts: {
  filename: string;
  width?: number;
  height?: number;
  alt?: string;
  align?: "left" | "center" | "right";
}): string {
  const attrs: string[] = [];
  if (opts.width) attrs.push(`ac:width="${opts.width}"`);
  if (opts.height) attrs.push(`ac:height="${opts.height}"`);
  if (opts.align) attrs.push(`ac:align="${opts.align}"`);
  if (opts.alt) attrs.push(`ac:alt="${escapeAttr(opts.alt)}"`);
  const open = attrs.length > 0 ? `<ac:image ${attrs.join(" ")}>` : `<ac:image>`;
  return `${open}<ri:attachment ri:filename="${escapeAttr(opts.filename)}" /></ac:image>`;
}

// ---------------------------------------------------------------------------
// Section-aware mutations — pure functions the tools compose.

/** Append content to the end of the page body. */
export function appendContent(storage: string, content: string): string {
  return storage + content;
}

/** Prepend content to the start of the page body. */
export function prependContent(storage: string, content: string): string {
  return content + storage;
}

/** Insert content immediately after the matched heading's close tag.
 *  Returns the mutated storage. Throws if the heading isn't found so the
 *  tool layer can surface an actionable error. */
export function insertAfterHeading(
  storage: string,
  level: number,
  textLocator: string,
  content: string,
): string {
  const loc = locateSection(storage, level, textLocator);
  if (!loc) {
    throw new HeadingNotFoundError(level, textLocator);
  }
  return (
    storage.slice(0, loc.headingEnd) +
    content +
    storage.slice(loc.headingEnd)
  );
}

/** Replace the body of a section (heading kept, everything under it
 *  replaced up to the next same-or-shallower heading). */
export function replaceSection(
  storage: string,
  level: number,
  textLocator: string,
  newContent: string,
): string {
  const loc = locateSection(storage, level, textLocator);
  if (!loc) {
    throw new HeadingNotFoundError(level, textLocator);
  }
  return (
    storage.slice(0, loc.headingEnd) +
    newContent +
    storage.slice(loc.sectionEnd)
  );
}

/** Remove a section including its heading. */
export function removeSection(
  storage: string,
  level: number,
  textLocator: string,
): string {
  const loc = locateSection(storage, level, textLocator);
  if (!loc) {
    throw new HeadingNotFoundError(level, textLocator);
  }
  return storage.slice(0, loc.headingStart) + storage.slice(loc.sectionEnd);
}

/** Run a regex replace over the storage body. Returns the new body and
 *  the number of replacements made. Enforces an optional max-replacement
 *  cap as a safety guard (accidental regex matching thousands of nodes). */
export function replaceText(
  storage: string,
  pattern: string,
  flags: string,
  replacement: string,
  maxReplacements?: number,
): { next: string; count: number } {
  const re = new RegExp(pattern, flags);
  const limit = maxReplacements ?? Infinity;
  let count = 0;
  const next = storage.replace(re, (match) => {
    if (count >= limit) return match;
    count++;
    return replacement;
  });
  return { next, count };
}

export class HeadingNotFoundError extends Error {
  constructor(
    public readonly level: number,
    public readonly locator: string,
  ) {
    super(`Heading h${level} matching "${locator}" not found.`);
    this.name = "HeadingNotFoundError";
  }
}
