// Bitbucket user lookup tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf } from "./_helpers.js";

export function registerUserTools(server: FastMCP, ctx: BitbucketContext): void {
  server.addTool({
    name: "get_current_user",
    description: "Get the authenticated Bitbucket user.",
    parameters: z.object({}),
    execute: async () => safeExecute(() => ctx.http.get(`/user`)),
  });

  server.addTool({
    name: "get_user_profile",
    description: "Look up a Bitbucket user by UUID, account_id, or username.",
    parameters: z.object({
      selector: z.string().describe("UUID in {braces}, account_id, or username"),
    }),
    execute: async (args: any) =>
      safeExecute(() => ctx.http.get(`/users/${encodeURIComponent(args.selector)}`)),
  });

  server.addTool({
    name: "get_user_permissions",
    description: "Get the authenticated user's repository permissions in the workspace.",
    parameters: z.object({
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/user/permissions/repositories`, {
          q: `workspace.slug = "${workspaceOf(ctx, args.workspace)}"`,
          pagelen: args.pagelen ?? 100,
        }),
      ),
  });
}
