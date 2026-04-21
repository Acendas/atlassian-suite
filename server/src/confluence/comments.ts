// Confluence FOOTER comments — v2 dedicated endpoints.
//
// v2 splits comments into footer (page-level) and inline (text-anchored).
// This file owns footer comments. Inline comments live in
// inlineComments.ts. Both flow through `/api/v2/{footer|inline}-comments`
// and need `read:comment:confluence` + `write:comment:confluence` scopes.

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

export interface CommentOpts {
  readOnly: boolean;
}

export function registerCommentTools(server: FastMCP, opts: CommentOpts): void {
  // ---------------- List footer comments on a page ----------------

  server.addTool({
    name: "confluence_get_comments",
    description:
      "List FOOTER comments on a Confluence page (page-level annotations). Cursor-paginated. For text-anchored comments on selections, use confluence_get_inline_comments.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(25),
      cursor: z.string().optional(),
      body_format: z
        .enum(["atlas_doc_format", "storage", "view"])
        .default("atlas_doc_format"),
    }),
    execute: async (args: {
      page_id: string;
      limit: number;
      cursor?: string;
      body_format: "atlas_doc_format" | "storage" | "view";
    }) =>
      safeConfluence(async () => {
        const query: Record<string, string | number | undefined> = {
          limit: args.limit,
          cursor: args.cursor,
          "body-format": args.body_format,
        };
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/footer-comments`,
          query,
        );
        return {
          comments: (res.results ?? []).map((c) => toCommentProjection(c, "footer")),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // ---------------- Add footer comment ----------------

  server.addTool({
    name: "confluence_add_comment",
    description:
      "Add a footer comment to a Confluence page. Body accepts one of: body_adf, body_storage, body_wiki, or body_markdown (default). Returns a CommentProjection.",
    parameters: z.object({
      page_id: z.string(),
      body_markdown: z.string().optional(),
      body_adf: z.any().optional(),
      body_storage: z.string().optional(),
      body_wiki: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
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
        const raw = await confluenceV2().post<unknown>("/footer-comments", {
          pageId: args.page_id,
          body,
        });
        return toCommentProjection(raw, "footer");
      }),
  });

  // ---------------- Reply to footer comment ----------------

  server.addTool({
    name: "confluence_reply_to_comment",
    description:
      "Reply to an existing footer comment (nests under parent_comment_id).",
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
        const raw = await confluenceV2().post<unknown>("/footer-comments", {
          parentCommentId: args.parent_comment_id,
          body,
        });
        return toCommentProjection(raw, "footer");
      }),
  });
}
