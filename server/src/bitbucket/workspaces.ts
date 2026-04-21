// Bitbucket workspace metadata tools (separate file from workspace.ts which holds members).

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf } from "./_helpers.js";

export function registerWorkspaceMetadataTools(server: FastMCP, ctx: BitbucketContext): void {
  // list_workspaces was removed in v0.3.0. Atlassian deprecated both
  // GET /workspaces and GET /user/permissions/workspaces via CHANGE-2770
  // (April 2026) — both now return 410 Gone with no working replacement
  // on scoped API tokens. Users must know their workspace slug in advance
  // (it's stored in bitbucket.workspace config and surfaced by
  // get_workspace_details).

  server.addTool({
    name: "get_workspace_details",
    description: "Get details for a workspace.",
    parameters: z.object({ workspace: z.string().optional() }),
    execute: async (args: any) =>
      safeExecute(() => ctx.http.get(`/workspaces/${workspaceOf(ctx, args.workspace)}`)),
  });

  server.addTool({
    name: "list_workspace_permissions",
    description: "List members and their permissions in the workspace.",
    parameters: z.object({
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/workspaces/${workspaceOf(ctx, args.workspace)}/permissions`, {
          pagelen: args.pagelen ?? 100,
        }),
      ),
  });
}
