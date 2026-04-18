// Bitbucket code search.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf } from "./_helpers.js";

export function registerSearchTools(server: FastMCP, ctx: BitbucketContext): void {
  server.addTool({
    name: "search_code",
    description: "Search code across all repositories in a workspace.",
    parameters: z.object({
      query: z
        .string()
        .describe(
          "Bitbucket search query. Supports filters like `repo:my-repo`, `lang:python`, `path:src/`.",
        ),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/workspaces/${workspaceOf(ctx, args.workspace)}/search/code`, {
          search_query: args.query,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });
}
