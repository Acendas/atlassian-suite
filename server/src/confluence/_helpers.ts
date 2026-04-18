// Shared helpers for Confluence tool modules.

export async function safeConfluence<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status;
    const body = err?.response?.data ?? err?.body;
    return JSON.stringify(
      {
        error: true,
        status: status ?? null,
        message: err?.message ?? String(err),
        body: body ?? null,
      },
      null,
      2,
    );
  }
}

export function ensureWritable(readOnly: boolean): void {
  if (readOnly) throw new Error("READ_ONLY_MODE is enabled — write operations are blocked.");
}

import { markdownToAdf, assertValidAdf } from "../common/adf.js";

export type Representation = "atlas_doc_format" | "storage" | "wiki" | "view";

/**
 * Build a Confluence body payload from one of several input formats. Inputs
 * are checked in priority order:
 *   1. body_adf       — raw ADF JSON object (best for ADF; bypasses conversion)
 *   2. body_storage   — raw Confluence storage XML (preserves <ac:image>, macros, charts)
 *   3. body_wiki      — Confluence wiki markup
 *   4. body_markdown  — Markdown converted to ADF
 *
 * If none provided, returns an empty ADF document.
 */
export function buildConfluenceBody(opts: {
  body_adf?: unknown;
  body_storage?: string;
  body_wiki?: string;
  body_markdown?: string;
  // Legacy kwargs (kept for back-compat with earlier tool versions):
  bodyMarkdown?: string;
  bodyRaw?: string;
  representation?: Representation;
}): {
  atlas_doc_format?: { value: string; representation: "atlas_doc_format" };
  storage?: { value: string; representation: "storage" };
  wiki?: { value: string; representation: "wiki" };
} {
  // Highest precedence: explicit raw ADF.
  if (opts.body_adf !== undefined) {
    const adf = assertValidAdf(opts.body_adf, "body_adf");
    return {
      atlas_doc_format: {
        value: JSON.stringify(adf),
        representation: "atlas_doc_format",
      },
    };
  }

  if (opts.body_storage !== undefined) {
    return { storage: { value: opts.body_storage, representation: "storage" } };
  }

  if (opts.body_wiki !== undefined) {
    return { wiki: { value: opts.body_wiki, representation: "wiki" } };
  }

  // Legacy fallback: representation flag picks the field for bodyRaw, otherwise Markdown→ADF.
  const repr = opts.representation;
  if (repr === "storage") {
    return {
      storage: { value: opts.bodyRaw ?? opts.bodyMarkdown ?? "", representation: "storage" },
    };
  }
  if (repr === "wiki") {
    return {
      wiki: { value: opts.bodyRaw ?? opts.bodyMarkdown ?? "", representation: "wiki" },
    };
  }

  const md = opts.body_markdown ?? opts.bodyMarkdown ?? opts.bodyRaw ?? "";
  return {
    atlas_doc_format: {
      value: JSON.stringify(markdownToAdf(md)),
      representation: "atlas_doc_format",
    },
  };
}
