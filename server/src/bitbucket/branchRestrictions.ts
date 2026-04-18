// Bitbucket branch restrictions.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerBranchRestrictionTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_branch_restrictions",
    description: "List branch restrictions on a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      kind: z
        .enum([
          "push",
          "force",
          "delete",
          "restrict_merges",
          "require_tasks_to_be_completed",
          "require_passing_builds_to_merge",
          "require_default_reviewer_approvals_to_merge",
          "require_no_changes_requested",
          "require_approvals_to_merge",
          "enforce_merge_checks",
        ])
        .optional(),
      pattern: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/branch-restrictions`, {
          kind: args.kind,
          pattern: args.pattern,
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "create_branch_restriction",
    description: "Create a branch restriction (e.g. block force push, require approvals).",
    parameters: z.object({
      repo_slug: z.string(),
      kind: z.enum([
        "push",
        "force",
        "delete",
        "restrict_merges",
        "require_tasks_to_be_completed",
        "require_passing_builds_to_merge",
        "require_default_reviewer_approvals_to_merge",
        "require_no_changes_requested",
        "require_approvals_to_merge",
        "enforce_merge_checks",
      ]),
      pattern: z.string().describe("Branch pattern, e.g. 'main' or 'release/*'"),
      value: z.number().int().optional().describe("e.g. number of approvals for require_*_approvals_*"),
      users: z.array(z.string()).optional().describe("UUIDs allowed to bypass"),
      groups: z
        .array(
          z.object({
            owner: z.object({ username: z.string() }),
            slug: z.string(),
          }),
        )
        .optional(),
      branch_match_kind: z.enum(["glob", "branching_model"]).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = { kind: args.kind, pattern: args.pattern };
        if (args.value !== undefined) payload.value = args.value;
        if (args.users) payload.users = args.users.map((u: string) => ({ uuid: u }));
        if (args.groups) payload.groups = args.groups;
        if (args.branch_match_kind) payload.branch_match_kind = args.branch_match_kind;
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/branch-restrictions`,
          payload,
        );
      }),
  });

  server.addTool({
    name: "update_branch_restriction",
    description: "Update an existing branch restriction.",
    parameters: z.object({
      repo_slug: z.string(),
      restriction_id: z.string(),
      pattern: z.string().optional(),
      value: z.number().int().optional(),
      users: z.array(z.string()).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = {};
        if (args.pattern !== undefined) payload.pattern = args.pattern;
        if (args.value !== undefined) payload.value = args.value;
        if (args.users !== undefined) payload.users = args.users.map((u: string) => ({ uuid: u }));
        return ctx.http.put(
          `${repoBase(args.workspace, args.repo_slug)}/branch-restrictions/${args.restriction_id}`,
          payload,
        );
      }),
  });

  server.addTool({
    name: "delete_branch_restriction",
    description: "Delete a branch restriction.",
    parameters: z.object({
      repo_slug: z.string(),
      restriction_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/branch-restrictions/${args.restriction_id}`,
        );
      }),
  });

  server.addTool({
    name: "get_branching_model_settings",
    description: "Get branching model settings (default reviewers, branch types) for a repo.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/branching-model/settings`),
      ),
  });

  server.addTool({
    name: "update_branching_model_settings",
    description: "Update branching model settings (development/production branches, branch types).",
    parameters: z.object({
      repo_slug: z.string(),
      development_branch: z
        .object({ name: z.string(), use_mainbranch: z.boolean().optional() })
        .optional(),
      production_branch: z
        .object({ name: z.string(), use_mainbranch: z.boolean().optional(), enabled: z.boolean().optional() })
        .optional(),
      branch_types: z
        .array(
          z.object({
            kind: z.enum(["feature", "bugfix", "release", "hotfix"]),
            prefix: z.string(),
            enabled: z.boolean().default(true),
          }),
        )
        .optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = {};
        if (args.development_branch) payload.development = args.development_branch;
        if (args.production_branch) payload.production = args.production_branch;
        if (args.branch_types) payload.branch_types = args.branch_types;
        return ctx.http.put(
          `${repoBase(args.workspace, args.repo_slug)}/branching-model/settings`,
          payload,
        );
      }),
  });
}
