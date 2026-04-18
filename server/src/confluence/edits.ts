// Granular Confluence page editing tools.
// Each tool fetches the current page in storage format, performs a targeted
// mutation in-memory, and posts the new version. No more "rewrite the whole page".
//
// All tools operate on STORAGE format (Confluence's XHTML-ish format) so that
// macros, images (<ac:image>), charts (<ac:structured-macro>), and other
// non-Markdown-representable content survive the round-trip intact.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceClient } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable } from "./_helpers.js";

export interface EditOpts {
  readOnly: boolean;
}

interface PageState {
  id: string;
  title: string;
  version: number;
  storage: string;
}

async function fetchPageStorage(pageId: string): Promise<PageState> {
  const page: any = await confluenceClient().content.getContentById({
    id: pageId,
    expand: ["body.storage", "version"],
  } as never);
  return {
    id: page.id,
    title: page.title,
    version: page.version?.number ?? 1,
    storage: page.body?.storage?.value ?? "",
  };
}

async function postPageStorage(state: PageState, newStorage: string): Promise<unknown> {
  return confluenceClient().content.updateContent({
    id: state.id,
    type: "page",
    title: state.title,
    version: { number: state.version + 1 },
    body: { storage: { value: newStorage, representation: "storage" } },
  } as never);
}

/**
 * Find the storage-format heading at the given level whose plain text matches
 * the locator (case-insensitive substring match). Returns the start index of
 * the heading tag and the start index of the next heading at the same-or-higher
 * level (so the section spans [start, sectionEnd)).
 */
function locateSection(
  storage: string,
  level: number,
  textLocator: string,
): { headingStart: number; headingEnd: number; sectionEnd: number } | null {
  const headingRe = new RegExp(`<h([1-6])(?:\\s[^>]*)?>([\\s\\S]*?)<\\/h\\1>`, "gi");
  const sections: Array<{ start: number; end: number; level: number; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(storage)) !== null) {
    const stripped = m[2].replace(/<[^>]+>/g, "").trim();
    sections.push({
      start: m.index,
      end: m.index + m[0].length,
      level: parseInt(m[1], 10),
      text: stripped,
    });
  }
  const target = sections.find(
    (s) => s.level === level && s.text.toLowerCase().includes(textLocator.toLowerCase()),
  );
  if (!target) return null;

  const nextSameOrHigher = sections.find(
    (s) => s.start > target.start && s.level <= target.level,
  );
  return {
    headingStart: target.start,
    headingEnd: target.end,
    sectionEnd: nextSameOrHigher ? nextSameOrHigher.start : storage.length,
  };
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
        return postPageStorage(state, state.storage + args.content_storage);
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
        return postPageStorage(state, args.content_storage + state.storage);
      }),
  });

  // ---------- Insert after heading ----------

  server.addTool({
    name: "confluence_insert_after_heading",
    description:
      "Insert content immediately after a specific heading (matched by level + text substring). All other content is preserved.",
    parameters: z.object({
      page_id: z.string(),
      heading_level: z.number().int().min(1).max(6),
      heading_text: z.string().describe("Substring to match in the heading text (case-insensitive)"),
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
        const loc = locateSection(state.storage, args.heading_level, args.heading_text);
        if (!loc) {
          throw new Error(
            `Heading h${args.heading_level} matching "${args.heading_text}" not found.`,
          );
        }
        const before = state.storage.slice(0, loc.headingEnd);
        const after = state.storage.slice(loc.headingEnd);
        return postPageStorage(state, before + args.content_storage + after);
      }),
  });

  // ---------- Replace section under heading ----------

  server.addTool({
    name: "confluence_replace_section",
    description:
      "Replace the body of a section (heading + everything until next same-or-higher heading). The heading line is preserved; only the content under it is replaced.",
    parameters: z.object({
      page_id: z.string(),
      heading_level: z.number().int().min(1).max(6),
      heading_text: z.string().describe("Substring to match (case-insensitive)"),
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
        const loc = locateSection(state.storage, args.heading_level, args.heading_text);
        if (!loc) {
          throw new Error(
            `Heading h${args.heading_level} matching "${args.heading_text}" not found.`,
          );
        }
        const before = state.storage.slice(0, loc.headingEnd);
        const after = state.storage.slice(loc.sectionEnd);
        return postPageStorage(state, before + args.new_content_storage + after);
      }),
  });

  // ---------- Remove section ----------

  server.addTool({
    name: "confluence_remove_section",
    description:
      "Remove an entire section including its heading (everything from the heading until the next same-or-higher heading).",
    parameters: z.object({
      page_id: z.string(),
      heading_level: z.number().int().min(1).max(6),
      heading_text: z.string(),
    }),
    execute: async (args: { page_id: string; heading_level: number; heading_text: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const state = await fetchPageStorage(args.page_id);
        const loc = locateSection(state.storage, args.heading_level, args.heading_text);
        if (!loc) {
          throw new Error(
            `Heading h${args.heading_level} matching "${args.heading_text}" not found.`,
          );
        }
        const before = state.storage.slice(0, loc.headingStart);
        const after = state.storage.slice(loc.sectionEnd);
        return postPageStorage(state, before + after);
      }),
  });

  // ---------- Replace text (regex) ----------

  server.addTool({
    name: "confluence_replace_text",
    description:
      "Find and replace text in the storage body using a regex. Useful for surgical edits like updating links or version numbers without touching the rest of the page. Use carefully — regex applies to the raw storage XML.",
    parameters: z.object({
      page_id: z.string(),
      pattern: z.string().describe("JavaScript regex source"),
      flags: z.string().default("g").describe("Regex flags, default 'g'"),
      replacement: z.string(),
      max_replacements: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap the number of replacements (safety guard)"),
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
        let count = 0;
        const re = new RegExp(args.pattern, args.flags);
        const limit = args.max_replacements ?? Infinity;
        const next = state.storage.replace(re, (match) => {
          if (count >= limit) return match;
          count++;
          return args.replacement;
        });
        if (count === 0) {
          throw new Error(`Pattern /${args.pattern}/${args.flags} matched zero times — no edit applied.`);
        }
        const result: any = await postPageStorage(state, next);
        return { ...result, _replacements_made: count };
      }),
  });

  // ---------- Render image macro (helper, no API call) ----------

  server.addTool({
    name: "confluence_render_image_macro",
    description:
      "Produce the Confluence storage XML for embedding an image attached to a page. Returns the snippet — pair with confluence_insert_after_heading or confluence_append_to_page to actually place it.",
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
    }) => {
      const attrs: string[] = [];
      if (args.width) attrs.push(`ac:width="${args.width}"`);
      if (args.height) attrs.push(`ac:height="${args.height}"`);
      if (args.align) attrs.push(`ac:align="${args.align}"`);
      if (args.alt) attrs.push(`ac:alt="${escapeAttr(args.alt)}"`);
      const open = attrs.length > 0 ? `<ac:image ${attrs.join(" ")}>` : `<ac:image>`;
      const xml = `${open}<ri:attachment ri:filename="${escapeAttr(args.filename)}" /></ac:image>`;
      return JSON.stringify({ storage_xml: xml }, null, 2);
    },
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
