// Confluence comment tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceClient } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable, buildConfluenceBody } from "./_helpers.js";

export interface CommentOpts {
  readOnly: boolean;
}

export function registerCommentTools(server: FastMCP, opts: CommentOpts): void {
  server.addTool({
    name: "confluence_get_comments",
    description: "List footer comments on a Confluence page.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
      start: z.number().int().min(0).default(0),
    }),
    execute: async (args: { page_id: string; limit: number; start: number }) =>
      safeConfluence(() =>
        confluenceClient().contentComments.getContentComments({
          id: args.page_id,
          limit: args.limit,
          start: args.start,
          expand: ["body.atlas_doc_format", "version"],
        } as never),
      ),
  });

  server.addTool({
    name: "confluence_add_comment",
    description: "Add a footer comment to a Confluence page. Body is Markdown by default.",
    parameters: z.object({
      page_id: z.string(),
      body: z.string(),
      representation: z.enum(["atlas_doc_format", "storage", "wiki"]).default("atlas_doc_format"),
    }),
    execute: async (args: {
      page_id: string;
      body: string;
      representation: "atlas_doc_format" | "storage" | "wiki";
    }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBody({
          bodyMarkdown: args.body,
          bodyRaw: args.body,
          representation: args.representation,
        });
        return confluenceClient().content.createContent({
          type: "comment",
          title: "",
          container: { id: args.page_id, type: "page" },
          body,
        } as never);
      }),
  });

  server.addTool({
    name: "confluence_reply_to_comment",
    description: "Reply to an existing Confluence comment.",
    parameters: z.object({
      parent_comment_id: z.string(),
      body: z.string(),
      representation: z.enum(["atlas_doc_format", "storage", "wiki"]).default("atlas_doc_format"),
    }),
    execute: async (args: {
      parent_comment_id: string;
      body: string;
      representation: "atlas_doc_format" | "storage" | "wiki";
    }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBody({
          bodyMarkdown: args.body,
          bodyRaw: args.body,
          representation: args.representation,
        });
        return confluenceClient().content.createContent({
          type: "comment",
          title: "",
          ancestors: [{ id: args.parent_comment_id }],
          body,
        } as never);
      }),
  });
}
