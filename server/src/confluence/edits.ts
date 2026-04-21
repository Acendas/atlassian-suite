// Surgical Confluence page editing tools.
//
// Each tool fetches the current page's storage body, mutates it via pure
// string helpers from _storage.ts, and writes it back as a new version.
// Macros, images (<ac:image>), charts (<ac:structured-macro>), and other
// non-Markdown-representable content survive the round-trip because we
// never parse them — we splice around headings / regex-replace inside
// the raw XML.
//
// v2 for both read AND write — never split across API versions (v2-served
// storage normalization is minor but not byte-identical to v1, so a mixed
// read/write would corrupt macro ids in round-trip).

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV2 } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable, toPageProjection } from "./_helpers.js";
import {
  appendContent,
  prependContent,
  insertAfterHeading,
  replaceSection,
  removeSection,
  replaceText,
  renderImageMacro,
} from "./_storage.js";

export interface EditOpts {
  readOnly: boolean;
}

interface PageState {
  id: string;
  title: string;
  versionNumber: number;
  storage: string;
}

/** Fetch the current storage-format body + metadata needed to write back. */
async function fetchPageStorage(pageId: string): Promise<PageState> {
  const raw = await confluenceV2().get<{
    id?: string;
    title?: string;
    version?: { number?: number };
    body?: { storage?: { value?: string } };
  }>(`/pages/${encodeURIComponent(pageId)}`, { "body-format": "storage" });
  return {
    id: String(raw.id ?? pageId),
    title: String(raw.title ?? ""),
    versionNumber: raw.version?.number ?? 1,
    storage: raw.body?.storage?.value ?? "",
  };
}

/** Write back a new storage-format body, bumping the version. Returns
 *  the new PageProjection. */
async function postPageStorage(state: PageState, newStorage: string): Promise<unknown> {
  const payload = {
    id: state.id,
    status: "current",
    title: state.title,
    body: { representation: "storage", value: newStorage },
    version: { number: state.versionNumber + 1 },
  };
  const raw = await confluenceV2().put<unknown>(
    `/pages/${encodeURIComponent(state.id)}`,
    payload,
  );
  return toPageProjection(raw);
}

export function registerEditTools(server: FastMCP, opts: EditOpts): void {
  // ---------- Append ----------

  server.addTool({
    name: "confluence_append_to_page",
    description:
      "Append storage-format content to the end of a page. Preserves all existing content (macros, images, charts).",
    parameters: z.object({
      page_id: z.string(),
      content_storage: z
        .string()
        .describe("Confluence storage XML to append (e.g. '<p>New paragraph</p>')"),
    }),
    execute: async (args: { page_id: string; content_storage: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        return postPageStorage(state, appendContent(state.storage, args.content_storage));
      }),
  });

  // ---------- Prepend ----------

  server.addTool({
    name: "confluence_prepend_to_page",
    description: "Prepend storage-format content to the start of a page.",
    parameters: z.object({
      page_id: z.string(),
      content_storage: z.string(),
    }),
    execute: async (args: { page_id: string; content_storage: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        return postPageStorage(state, prependContent(state.storage, args.content_storage));
      }),
  });

  // ---------- Insert after heading ----------

  server.addTool({
    name: "confluence_insert_after_heading",
    description:
      "Insert content immediately after a heading (matched by level + text substring, case-insensitive). Throws if no heading matches.",
    parameters: z.object({
      page_id: z.string(),
      heading_level: z.number().int().min(1).max(6),
      heading_text: z.string().describe("Substring to match (case-insensitive)"),
      content_storage: z.string(),
    }),
    execute: async (args: {
      page_id: string;
      heading_level: number;
      heading_text: string;
      content_storage: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        const next = insertAfterHeading(
          state.storage,
          args.heading_level,
          args.heading_text,
          args.content_storage,
        );
        return postPageStorage(state, next);
      }),
  });

  // ---------- Replace section under heading ----------

  server.addTool({
    name: "confluence_replace_section",
    description:
      "Replace the body of a section (heading preserved; everything from end-of-heading until next same-or-shallower heading gets replaced). Preferred over confluence_replace_text for structured edits.",
    parameters: z.object({
      page_id: z.string(),
      heading_level: z.number().int().min(1).max(6),
      heading_text: z.string(),
      new_content_storage: z.string(),
    }),
    execute: async (args: {
      page_id: string;
      heading_level: number;
      heading_text: string;
      new_content_storage: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        const next = replaceSection(
          state.storage,
          args.heading_level,
          args.heading_text,
          args.new_content_storage,
        );
        return postPageStorage(state, next);
      }),
  });

  // ---------- Remove section ----------

  server.addTool({
    name: "confluence_remove_section",
    description:
      "Remove an entire section including its heading (from heading start to next same-or-shallower heading).",
    parameters: z.object({
      page_id: z.string(),
      heading_level: z.number().int().min(1).max(6),
      heading_text: z.string(),
    }),
    execute: async (args: { page_id: string; heading_level: number; heading_text: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        const next = removeSection(state.storage, args.heading_level, args.heading_text);
        return postPageStorage(state, next);
      }),
  });

  // ---------- Replace text (regex) ----------

  server.addTool({
    name: "confluence_replace_text",
    description:
      "Find/replace in the raw storage XML using a regex. Good for URL updates, version strings, or other one-off substitutions. Avoid for structured edits — prefer confluence_replace_section. Note: regex runs against storage XML (tags, macros, attributes), so patterns that assume attribute ordering can be brittle across tenants.",
    parameters: z.object({
      page_id: z.string(),
      pattern: z.string().describe("JavaScript regex source"),
      flags: z.string().default("g"),
      replacement: z.string(),
      max_replacements: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap (safety guard); default unlimited."),
    }),
    execute: async (args: {
      page_id: string;
      pattern: string;
      flags: string;
      replacement: string;
      max_replacements?: number;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        const { next, count } = replaceText(
          state.storage,
          args.pattern,
          args.flags,
          args.replacement,
          args.max_replacements,
        );
        if (count === 0) {
          throw new Error(
            `Pattern /${args.pattern}/${args.flags} matched zero times — no edit applied.`,
          );
        }
        const result = await postPageStorage(state, next);
        return { ...(result as object), _replacements_made: count };
      }),
  });

  // ---------- Render image macro (pure, no API) ----------

  server.addTool({
    name: "confluence_render_image_macro",
    description:
      "Produce the Confluence storage XML for embedding an attached image. Returns the snippet; pair with confluence_insert_after_heading or confluence_append_to_page to place it on the page.",
    parameters: z.object({
      filename: z.string().describe("Attachment filename, e.g. 'diagram.png'"),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      alt: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
    }),
    execute: async (args: {
      filename: string;
      width?: number;
      height?: number;
      alt?: string;
      align?: "left" | "center" | "right";
    }) => JSON.stringify({ storage_xml: renderImageMacro(args) }, null, 2),
  });
}
