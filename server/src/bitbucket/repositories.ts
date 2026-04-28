// Repository CRUD + file contents + forks.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerRepositoryTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_repositories",
    description: "List repositories in the configured Bitbucket workspace.",
    parameters: z.object({
      workspace: z.string().optional(),
      role: z.enum(["admin", "contributor", "member", "owner"]).optional(),
      sort: z.string().optional().describe("e.g. -updated_on, name"),
      query: z.string().optional().describe("Bitbucket query string (BBQL)"),
      page: z.number().int().positive().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/repositories/${workspaceOf(ctx, args.workspace)}`, {
          role: args.role,
          sort: args.sort,
          q: args.query,
          page: args.page,
          pagelen: args.pagelen ?? 25,
        }),
      ),
  });

  server.addTool({
    name: "get_repository",
    description: "Get details for a single Bitbucket repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) => safeExecute(() => ctx.http.get(repoBase(args.workspace, args.repo_slug))),
  });

  server.addTool({
    name: "get_file_contents",
    description: "Read a file at a specific commit/branch/tag from a Bitbucket repository.",
    parameters: z.object({
      repo_slug: z.string(),
      path: z.string().describe("Path inside the repo, no leading slash"),
      commit: z.string().describe("Branch name, tag, or commit SHA"),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.request("GET", `${repoBase(args.workspace, args.repo_slug)}/src/${encodeURIComponent(args.commit)}/${args.path}`, { headers: { Accept: "*/*" } }),
      ),
  });

  server.addTool({
    name: "create_repository",
    description: "Create a new repository in the workspace.",
    parameters: z.object({
      repo_slug: z.string(),
      project_key: z.string().optional().describe("Project to place this repo under"),
      scm: z.enum(["git"]).default("git"),
      is_private: z.boolean().default(true),
      description: z.string().optional(),
      fork_policy: z.enum(["allow_forks", "no_public_forks", "no_forks"]).optional(),
      language: z.string().optional(),
      mainbranch: z.string().optional().describe("Default branch name (e.g. main)"),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = {
          scm: args.scm,
          is_private: args.is_private,
          description: args.description,
          fork_policy: args.fork_policy,
          language: args.language,
        };
        if (args.project_key) payload.project = { key: args.project_key };
        if (args.mainbranch) payload.mainbranch = { name: args.mainbranch };
        return ctx.http.post(repoBase(args.workspace, args.repo_slug), payload);
      }),
  });

  server.addTool({
    name: "update_repository",
    description: "Update repository metadata (description, privacy, default branch, project).",
    parameters: z.object({
      repo_slug: z.string(),
      description: z.string().optional(),
      is_private: z.boolean().optional(),
      mainbranch: z.string().optional(),
      project_key: z.string().optional(),
      language: z.string().optional(),
      fork_policy: z.enum(["allow_forks", "no_public_forks", "no_forks"]).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = {};
        if (args.description !== undefined) payload.description = args.description;
        if (args.is_private !== undefined) payload.is_private = args.is_private;
        if (args.language !== undefined) payload.language = args.language;
        if (args.fork_policy !== undefined) payload.fork_policy = args.fork_policy;
        if (args.mainbranch !== undefined) payload.mainbranch = { name: args.mainbranch };
        if (args.project_key !== undefined) payload.project = { key: args.project_key };
        return ctx.http.put(repoBase(args.workspace, args.repo_slug), payload);
      }),
  });

  server.addTool({
    name: "delete_repository",
    description: "Delete a repository (irreversible).",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      redirect_to: z.string().url().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}${args.redirect_to ? `?redirect_to=${encodeURIComponent(args.redirect_to)}` : ""}`,
        );
      }),
  });

  server.addTool({
    name: "fork_repository",
    description: "Fork a repository into a workspace.",
    parameters: z.object({
      repo_slug: z.string(),
      target_workspace: z.string().describe("Workspace to fork into"),
      name: z.string().optional().describe("Name for the fork (defaults to repo_slug)"),
      is_private: z.boolean().optional(),
      project_key: z.string().optional(),
      workspace: z.string().optional().describe("Source workspace"),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = { workspace: { slug: args.target_workspace } };
        if (args.name) payload.name = args.name;
        if (args.is_private !== undefined) payload.is_private = args.is_private;
        if (args.project_key) payload.project = { key: args.project_key };
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/forks`, payload);
      }),
  });

  server.addTool({
    name: "list_repository_forks",
    description: "List forks of a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/forks`, {
          pagelen: args.pagelen ?? 25,
        }),
      ),
  });
}
