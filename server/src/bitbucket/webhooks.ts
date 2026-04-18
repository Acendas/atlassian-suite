// Bitbucket webhook tools (workspace + repo level).

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerWebhookTools(server: FastMCP, ctx: BitbucketContext): void {
  server.addTool({
    name: "list_webhooks",
    description: "List webhooks configured on a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `/repositories/${workspaceOf(ctx, args.workspace)}/${args.repo_slug}/hooks`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "list_workspace_webhooks",
    description: "List webhooks configured at the workspace level.",
    parameters: z.object({
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/workspaces/${workspaceOf(ctx, args.workspace)}/hooks`, {
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "create_webhook",
    description: "Create a webhook on a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      url: z.string().url(),
      description: z.string(),
      events: z.array(z.string()).min(1).describe("e.g. ['repo:push', 'pullrequest:created']"),
      active: z.boolean().default(true),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `/repositories/${workspaceOf(ctx, args.workspace)}/${args.repo_slug}/hooks`,
          {
            description: args.description,
            url: args.url,
            active: args.active,
            events: args.events,
          },
        );
      }),
  });

  server.addTool({
    name: "delete_webhook",
    description: "Delete a webhook from a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      webhook_uid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `/repositories/${workspaceOf(ctx, args.workspace)}/${args.repo_slug}/hooks/${args.webhook_uid}`,
        );
      }),
  });
}
