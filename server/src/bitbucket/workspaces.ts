// Bitbucket workspace metadata tools (separate file from workspace.ts which holds members).

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf } from "./_helpers.js";

export function registerWorkspaceMetadataTools(server: FastMCP, ctx: BitbucketContext): void {
  server.addTool({
    name: "list_workspaces",
    description: "List workspaces visible to the authenticated user.",
    parameters: z.object({
      role: z.enum(["owner", "collaborator", "member"]).optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/workspaces`, { role: args.role, pagelen: args.pagelen ?? 50 }),
      ),
  });

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
