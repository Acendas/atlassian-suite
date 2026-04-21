// Confluence INLINE comments — v2 dedicated endpoints.
//
// Inline comments are text-anchored (highlight some words in a page, add
// a comment to them). They're distinct from footer comments which live
// at the page level. Creation requires `inlineCommentProperties.textSelection`
// — the text the comment anchors to.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV2 } from "../common/confluenceClient.js";
import {
  safeConfluence,
  ensureWritable,
  buildConfluenceBodyV2,
  toCommentProjection,
  extractNextCursor,
  type PagedResponse,
} from "./_helpers.js";

export interface InlineCommentOpts {
  readOnly: boolean;
}

export function registerInlineCommentTools(
  server: FastMCP,
  opts: InlineCommentOpts,
): void {
  // ---------------- List inline comments on a page ----------------

  server.addTool({
    name: "confluence_get_inline_comments",
    description:
      "List inline (text-anchored) comments on a Confluence page. Each comment points to a selection of text; `textSelection` in the response identifies the anchor. Cursor-paginated.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(25),
      cursor: z.string().optional(),
      body_format: z
        .enum(["atlas_doc_format", "storage", "view"])
        .default("atlas_doc_format"),
      resolution_status: z
        .enum(["open", "resolved", "reopened", "dangling"])
        .optional()
        .describe("Filter by resolution state; default returns all"),
    }),
    execute: async (args: {
      page_id: string;
      limit: number;
      cursor?: string;
      body_format: "atlas_doc_format" | "storage" | "view";
      resolution_status?: "open" | "resolved" | "reopened" | "dangling";
    }) =>
      safeConfluence(async () => {
        const query: Record<string, string | number | undefined> = {
          limit: args.limit,
          cursor: args.cursor,
          "body-format": args.body_format,
        };
        if (args.resolution_status) {
          query["resolution-status"] = args.resolution_status;
        }
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/inline-comments`,
          query,
        );
        return {
          comments: (res.results ?? []).map((c) => toCommentProjection(c, "inline")),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // ---------------- Add inline comment ----------------

  server.addTool({
    name: "confluence_add_inline_comment",
    description:
      "Add an inline comment anchored to selected text on a page. `selection_text` must match text in the page body (use the text-as-seen, not XML). `selection_match_count` is which occurrence to anchor to (1-based; default 1). Body via body_markdown (default), body_adf, body_storage, or body_wiki.",
    parameters: z.object({
      page_id: z.string(),
      selection_text: z
        .string()
        .describe("Exact text in the page to anchor the comment to"),
      selection_match_count: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Which occurrence (1-based) when the text appears multiple times"),
      body_markdown: z.string().optional(),
      body_adf: z.any().optional(),
      body_storage: z.string().optional(),
      body_wiki: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
      selection_text: string;
      selection_match_count: number;
      body_markdown?: string;
      body_adf?: unknown;
      body_storage?: string;
      body_wiki?: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBodyV2({
          body_adf: args.body_adf,
          body_storage: args.body_storage,
          body_wiki: args.body_wiki,
          body_markdown: args.body_markdown,
        });
        const raw = await confluenceV2().post<unknown>("/inline-comments", {
          pageId: args.page_id,
          body,
          inlineCommentProperties: {
            textSelection: args.selection_text,
            textSelectionMatchCount: args.selection_match_count,
          },
        });
        return toCommentProjection(raw, "inline");
      }),
  });

  // ---------------- Reply to inline comment ----------------

  server.addTool({
    name: "confluence_reply_to_inline_comment",
    description: "Reply to an existing inline comment thread.",
    parameters: z.object({
      parent_comment_id: z.string(),
      body_markdown: z.string().optional(),
      body_adf: z.any().optional(),
      body_storage: z.string().optional(),
      body_wiki: z.string().optional(),
    }),
    execute: async (args: {
      parent_comment_id: string;
      body_markdown?: string;
      body_adf?: unknown;
      body_storage?: string;
      body_wiki?: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBodyV2({
          body_adf: args.body_adf,
          body_storage: args.body_storage,
          body_wiki: args.body_wiki,
          body_markdown: args.body_markdown,
        });
        const raw = await confluenceV2().post<unknown>("/inline-comments", {
          parentCommentId: args.parent_comment_id,
          body,
        });
        return toCommentProjection(raw, "inline");
      }),
  });

  // ---------------- Resolve / reopen inline comment ----------------

  server.addTool({
    name: "confluence_resolve_inline_comment",
    description:
      "Resolve or reopen an inline comment thread. Resolving hides the comment from the default view. Useful when a reviewer's concern has been addressed by a page edit.",
    parameters: z.object({
      comment_id: z.string(),
      resolved: z.boolean().default(true),
    }),
    execute: async (args: { comment_id: string; resolved: boolean }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const raw = await confluenceV2().put<unknown>(
          `/inline-comments/${encodeURIComponent(args.comment_id)}`,
          { resolved: args.resolved },
        );
        return toCommentProjection(raw, "inline");
      }),
  });
}
