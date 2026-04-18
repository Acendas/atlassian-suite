// Bidirectional ADF ↔ Markdown conversion.
// Markdown → ADF: @atlaskit/editor-markdown-transformer + JSONTransformer (heavy/accurate).
// ADF → Markdown: adf-to-md (mature standalone library).

import { JSONTransformer } from "@atlaskit/editor-json-transformer";
import { MarkdownTransformer } from "@atlaskit/editor-markdown-transformer";
import adfToMd from "adf-to-md";

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
 * incorrectly under some conditions). For maximum correctness on complex
 * content (panels/mentions/media/charts), pass ADF directly via body_adf.
 */
export function markdownToAdf(markdown: string): AdfDocument {
  if (!markdown || markdown.trim().length === 0) return EMPTY_DOC;
  const pmNode = markdownTransformer.parse(markdown);
  const adf = jsonTransformer.encode(pmNode) as AdfDocument;
  return reconcileHeadingLevels(adf, markdown);
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
 * Validate that a value looks like an ADF document. Used by tools that accept
 * raw ADF as input — fail fast with a useful error rather than letting the
 * Atlassian API return a generic 400.
 */
export function assertValidAdf(value: unknown, context: string): AdfDocument {
  if (!value || typeof value !== "object") {
    throw new Error(`${context}: expected ADF object, got ${typeof value}`);
  }
  const doc = value as AdfDocument;
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
