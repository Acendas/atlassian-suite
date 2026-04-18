// Bitbucket workspace-level Projects tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerProjectTools(server: FastMCP, ctx: BitbucketContext): void {
  const wsBase = (workspace: string | undefined): string =>
    `/workspaces/${workspaceOf(ctx, workspace)}/projects`;

  server.addTool({
    name: "list_projects",
    description: "List projects in a workspace.",
    parameters: z.object({
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(wsBase(args.workspace), {
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "get_project",
    description: "Get a single project by key.",
    parameters: z.object({
      project_key: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => ctx.http.get(`${wsBase(args.workspace)}/${args.project_key}`)),
  });

  server.addTool({
    name: "create_project",
    description: "Create a project in a workspace.",
    parameters: z.object({
      key: z.string().describe("Project key (uppercase, alphanumeric)"),
      name: z.string(),
      description: z.string().optional(),
      is_private: z.boolean().default(true),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(wsBase(args.workspace), {
          key: args.key,
          name: args.name,
          description: args.description,
          is_private: args.is_private,
        });
      }),
  });
}
