// Workspace member listing.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf } from "./_helpers.js";

export function registerWorkspaceTools(server: FastMCP, ctx: BitbucketContext): void {
  server.addTool({
    name: "list_workspace_members",
    description: "List members of a Bitbucket workspace.",
    parameters: z.object({
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(`/workspaces/${workspaceOf(ctx, args.workspace)}/members`, {
          pagelen: args.pagelen ?? 50,
          page: args.page,
        }),
      ),
  });
}
