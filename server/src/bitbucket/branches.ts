// Branch listing + lifecycle + branching model.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerBranchTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_branches",
    description: "List branches in a Bitbucket repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      query: z.string().optional().describe("Filter (e.g. name ~ \"feature/\")"),
      sort: z.string().optional().describe("Sort field (e.g. -target.date)"),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/refs/branches`, {
          q: args.query,
          sort: args.sort,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "create_branch",
    description: "Create a new branch from a target commit/branch.",
    parameters: z.object({
      repo_slug: z.string(),
      name: z.string(),
      target: z.string().describe("Branch name or commit SHA to branch from"),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/refs/branches`, {
          name: args.name,
          target: { hash: args.target },
        });
      }),
  });

  server.addTool({
    name: "delete_branch",
    description: "Delete a branch.",
    parameters: z.object({
      repo_slug: z.string(),
      name: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/refs/branches/${encodeURIComponent(args.name)}`,
        );
      }),
  });

  server.addTool({
    name: "get_branching_model",
    description: "Get the branching model configured on a repository (development/production branches, types).",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/branching-model`),
      ),
  });
}
