// Commit listing, single-commit details, diff/diffstat, commit comments, build statuses.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerCommitTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_commits",
    description: "List commits in a Bitbucket repository, optionally filtered by branch/path.",
    parameters: z.object({
      repo_slug: z.string(),
      include: z.string().optional().describe("Branch/tag/SHA to walk from"),
      exclude: z.string().optional().describe("Branch/tag/SHA to exclude"),
      path: z.string().optional().describe("Limit to commits touching this path"),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/commits`, {
          include: args.include,
          exclude: args.exclude,
          path: args.path,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "get_commit",
    description: "Get details for a single commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string().describe("Full or short SHA"),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/commit/${args.commit}`),
      ),
  });

  server.addTool({
    name: "get_commit_diff",
    description: "Get the unified diff for a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get<string>(`${repoBase(args.workspace, args.repo_slug)}/diff/${args.commit}`),
      ),
  });

  server.addTool({
    name: "get_commit_diffstat",
    description: "Get the diffstat (per-file change counts) for a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/diffstat/${args.commit}`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "list_commit_comments",
    description: "List comments on a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/commit/${args.commit}/comments`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "list_commit_statuses",
    description: "List build/CI statuses attached to a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/commit/${args.commit}/statuses`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "add_commit_comment",
    description: "Add a comment on a commit (top-level or inline on a file/line).",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      content: z.string(),
      path: z.string().optional().describe("File path for inline comment"),
      line_to: z.number().int().positive().optional(),
      line_from: z.number().int().positive().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = { content: { raw: args.content } };
        if (args.path) {
          payload.inline = { path: args.path };
          if (args.line_to !== undefined) payload.inline.to = args.line_to;
          if (args.line_from !== undefined) payload.inline.from = args.line_from;
        }
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/commit/${args.commit}/comments`,
          payload,
        );
      }),
  });

  server.addTool({
    name: "create_build_status",
    description: "Attach a build/CI status to a commit (state, name, url, description).",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      key: z.string().describe("Stable identifier for this build (e.g. 'ci.lint')"),
      state: z.enum(["INPROGRESS", "SUCCESSFUL", "FAILED", "STOPPED"]),
      name: z.string(),
      url: z.string().url(),
      description: z.string().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/commit/${args.commit}/statuses/build`,
          {
            key: args.key,
            state: args.state,
            name: args.name,
            url: args.url,
            description: args.description,
          },
        );
      }),
  });
}
