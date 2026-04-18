// Bitbucket Snippets tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerSnippetTools(server: FastMCP, ctx: BitbucketContext): void {
  const wsBase = (workspace: string | undefined): string =>
    `/snippets/${workspaceOf(ctx, workspace)}`;

  server.addTool({
    name: "list_snippets",
    description: "List snippets in the workspace.",
    parameters: z.object({
      role: z.enum(["owner", "contributor", "member"]).optional(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(wsBase(args.workspace), {
          role: args.role,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "get_snippet",
    description: "Get details for a single snippet.",
    parameters: z.object({
      snippet_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => ctx.http.get(`${wsBase(args.workspace)}/${args.snippet_id}`)),
  });

  server.addTool({
    name: "create_snippet",
    description: "Create a snippet (file content provided inline).",
    parameters: z.object({
      title: z.string(),
      filename: z.string(),
      content: z.string(),
      is_private: z.boolean().default(true),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(wsBase(args.workspace), {
          title: args.title,
          is_private: args.is_private,
          files: { [args.filename]: { content: args.content } },
        });
      }),
  });

  server.addTool({
    name: "delete_snippet",
    description: "Delete a snippet.",
    parameters: z.object({
      snippet_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(`${wsBase(args.workspace)}/${args.snippet_id}`);
      }),
  });
}
