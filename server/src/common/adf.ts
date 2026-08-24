// Bidirectional ADF ↔ Markdown conversion.
// Markdown → ADF: @atlaskit/editor-markdown-transformer + JSONTransformer (heavy/accurate).
// ADF → Markdown: adf-to-md (mature standalone library).

import { JSONTransformer } from "@atlaskit/editor-json-transformer";
import { MarkdownTransformer } from "@atlaskit/editor-markdown-transformer";
import adfToMd from "adf-to-md";
import { z } from "zod";

const adfToMdTranslate = (adfToMd as { translate: (adf: unknown) => string | { result: string } })
  .translate;

const jsonTransformer = new JSONTransformer();
const markdownTransformer = new MarkdownTransformer();

export interface AdfDocument {
  type: "doc";
  version: number;
  content: unknown[];
}

const EMPTY_DOC: AdfDocument = { type: "doc", version: 1, content: [] };

const HEADING_LEVEL_RE = /^(#{1,6})\s+(.+)$/gm;

/**
 * Convert Markdown to ADF. Post-processes the result to fix recurring
 * @atlaskit/editor-markdown-transformer issues (heading levels normalized
 * incorrectly under some conditions) and to turn Jira's `[~accountid:...]`
 * mention syntax into real ADF mention nodes. For maximum correctness on other
 * complex content (panels/media/charts), pass ADF directly via body_adf.
 */
export function markdownToAdf(markdown: string): AdfDocument {
  if (!markdown || markdown.trim().length === 0) return EMPTY_DOC;
  const pmNode = markdownTransformer.parse(markdown);
  const adf = jsonTransformer.encode(pmNode) as AdfDocument;
  return applyMentions(reconcileHeadingLevels(adf, markdown));
}

/**
 * Jira wiki-markup mention syntax, which is what users reach for first:
 *   [~accountid:557058:f58131cb-…]              → mention, Jira supplies the name
 *   [~accountid:557058:f58131cb-…|Eldon Wong]   → mention with fallback text
 *
 * The Markdown transformer has no notion of mentions, so `[~accountid:x]`
 * survives as a literal text node and the comment posts as plain text that
 * pings nobody. We rewrite those text runs into ADF mention nodes here.
 *
 * Account ids contain colons and hyphens but never `]` or `|`.
 */
const MENTION_RE = /\[~accountid:([^\]|]+?)(?:\|([^\]]*))?\]/g;

/** True when this text node is inline code — mentions must stay literal there. */
function isCodeText(node: Record<string, unknown>): boolean {
  const marks = node.marks;
  return Array.isArray(marks) && marks.some((m) => (m as { type?: string })?.type === "code");
}

/**
 * Split one text node into alternating text/mention nodes. Marks on the
 * original text (bold, links, …) are carried onto each surviving text run.
 */
function splitMentions(node: Record<string, unknown>): unknown[] {
  const text = node.text;
  if (typeof text !== "string" || !text.includes("[~accountid:")) return [node];
  if (isCodeText(node)) return [node];

  const out: unknown[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const id = m[1].trim();
    if (!id) continue;
    if (m.index > last) out.push({ ...node, text: text.slice(last, m.index) });
    const attrs: Record<string, string> = { id };
    const display = m[2]?.trim();
    if (display) attrs.text = display.startsWith("@") ? display : `@${display}`;
    out.push({ type: "mention", attrs });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [node];
  if (last < text.length) out.push({ ...node, text: text.slice(last) });
  return out;
}

/** Walk the ADF tree rewriting mention syntax, skipping code blocks. */
function applyMentions<T>(node: T): T {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  if (n.type === "codeBlock") return node;
  if (Array.isArray(n.content)) {
    const next: unknown[] = [];
    for (const child of n.content) {
      const c = child as Record<string, unknown> | null;
      if (c && typeof c === "object" && c.type === "text") next.push(...splitMentions(c));
      else next.push(applyMentions(child));
    }
    n.content = next;
  }
  return node;
}

/**
 * Walk top-level ADF nodes and reconcile heading levels against the original
 * Markdown. Only fixes top-level headings (the common breakage point).
 */
function reconcileHeadingLevels(adf: AdfDocument, markdown: string): AdfDocument {
  if (!adf?.content || !Array.isArray(adf.content)) return adf;

  const expectedLevels: number[] = [];
  let m: RegExpExecArray | null;
  HEADING_LEVEL_RE.lastIndex = 0;
  while ((m = HEADING_LEVEL_RE.exec(markdown)) !== null) {
    expectedLevels.push(m[1].length);
  }
  if (expectedLevels.length === 0) return adf;

  let headingIdx = 0;
  for (const node of adf.content) {
    if (
      node &&
      typeof node === "object" &&
      (node as any).type === "heading" &&
      headingIdx < expectedLevels.length
    ) {
      const expected = expectedLevels[headingIdx];
      const attrs = (node as any).attrs ?? ((node as any).attrs = {});
      if (attrs.level !== expected) attrs.level = expected;
      headingIdx++;
    }
  }
  return adf;
}

export function adfToMarkdown(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  try {
    const result = adfToMdTranslate(adf as never);
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "result" in result) {
      return String((result as { result: unknown }).result ?? "");
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Some MCP clients serialize a nested object argument as a JSON string rather
 * than as a real object — the tool then sees `"{\"type\":\"doc\"…}"` and the
 * caller has no way to encode around it. Accept that form transparently.
 *
 * Non-strings, and strings that are not JSON objects, pass through untouched so
 * the caller still gets the specific validation error below.
 */
export function coerceAdf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Shared schema for every `*_adf` tool parameter.
 *
 * Declared as a real object (not `z.any()`) on purpose: `z.any()` renders to an
 * empty JSON Schema with no `type`, so a client has no signal that an object is
 * wanted and may send a JSON string instead. The `preprocess` step keeps that
 * string form working anyway.
 */
export const adfParam = z.preprocess(
  coerceAdf,
  z
    .object({
      type: z.literal("doc"),
      version: z.number(),
      content: z.array(z.any()),
    })
    .passthrough(),
);

/**
 * Validate that a value looks like an ADF document. Used by tools that accept
 * raw ADF as input — fail fast with a useful error rather than letting the
 * Atlassian API return a generic 400.
 */
export function assertValidAdf(value: unknown, context: string): AdfDocument {
  const candidate = coerceAdf(value);
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      `${context}: expected ADF object, got ${typeof candidate}. ` +
        `Pass a JSON object like {"type":"doc","version":1,"content":[…]}, ` +
        `or use the Markdown body field instead ` +
        `(mentions are supported there as [~accountid:<id>]).`,
    );
  }
  const value_ = candidate;
  const doc = value_ as AdfDocument;
  if (doc.type !== "doc") {
    throw new Error(`${context}: ADF root must have type:"doc", got "${(doc as any).type}"`);
  }
  if (typeof doc.version !== "number") {
    throw new Error(`${context}: ADF root must have a numeric version`);
  }
  if (!Array.isArray(doc.content)) {
    throw new Error(`${context}: ADF root must have a content array`);
  }
  return doc;
}

/**
 * Resolve a body argument from the family of inputs Jira tools expose:
 *   - body_adf: pre-built ADF object (preferred for charts/panels/mentions)
 *   - body_markdown / body: Markdown text (auto-converted, with heading fix)
 */
export function resolveAdfBody(opts: {
  body_adf?: unknown;
  body_markdown?: string;
  body?: string;
  context: string;
}): AdfDocument {
  if (opts.body_adf !== undefined) {
    return assertValidAdf(opts.body_adf, opts.context);
  }
  const md = opts.body_markdown ?? opts.body ?? "";
  return markdownToAdf(md);
}
