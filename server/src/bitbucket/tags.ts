// Tag listing, creation, deletion.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerTagTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_tags",
    description: "List git tags in a Bitbucket repository.",
    parameters: z.object({
      repo_slug: z.string(),
      query: z.string().optional(),
      sort: z.string().optional().describe("e.g. -target.date"),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/refs/tags`, {
          q: args.query,
          sort: args.sort,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "create_tag",
    description: "Create a tag pointing at a target commit/branch.",
    parameters: z.object({
      repo_slug: z.string(),
      name: z.string(),
      target: z.string().describe("Branch name or commit SHA"),
      message: z.string().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/refs/tags`, {
          name: args.name,
          target: { hash: args.target },
          message: args.message,
        });
      }),
  });

  server.addTool({
    name: "delete_tag",
    description: "Delete a git tag.",
    parameters: z.object({
      repo_slug: z.string(),
      name: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/refs/tags/${encodeURIComponent(args.name)}`,
        );
      }),
  });
}
