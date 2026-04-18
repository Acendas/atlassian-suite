// Pull request tools — list, get, create, update, merge, decline, approve flows, reviewers.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerPullRequestTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}/pullrequests`;

  // ---------- List / get ----------

  server.addTool({
    name: "list_pull_requests",
    description: "List pull requests in a Bitbucket repository, filtered by state.",
    parameters: z.object({
      repo_slug: z.string(),
      state: z
        .enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"])
        .optional()
        .describe("Default OPEN"),
      workspace: z.string().optional(),
      query: z.string().optional().describe("Bitbucket query (BBQL)"),
      sort: z.string().optional().describe("e.g. -updated_on"),
      pagelen: z.number().int().min(1).max(50).optional(),
      page: z.number().int().positive().optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(repoBase(args.workspace, args.repo_slug), {
          state: args.state ?? "OPEN",
          q: args.query,
          sort: args.sort,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "get_pull_request",
    description: "Get full details of a single pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}`),
      ),
  });

  server.addTool({
    name: "get_pull_request_diff",
    description: "Get the unified diff for a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get<string>(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/diff`,
        ),
      ),
  });

  server.addTool({
    name: "get_pull_request_diffstat",
    description: "Get a summary of files changed in a pull request (counts of additions/deletions per file).",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/diffstat`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "get_pull_request_commits",
    description: "List commits included in a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/commits`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "get_pull_request_activity",
    description: "Get the activity timeline of a pull request (approvals, change requests, comments).",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/activity`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "get_pull_request_merge_status",
    description:
      "Check whether a pull request can be merged. Inspects PR state, conflicts, and required reviewer approvals (read-only — does not initiate a merge).",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(async () => {
        const pr: any = await ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}`,
        );
        const reviewers: any[] = pr.participants ?? [];
        const approvals = reviewers.filter((p) => p.approved).length;
        const changesRequested = reviewers.filter((p) => p.state === "changes_requested").length;
        return {
          id: pr.id,
          state: pr.state,
          mergeable: pr.state === "OPEN",
          source_branch: pr.source?.branch?.name,
          destination_branch: pr.destination?.branch?.name,
          merge_commit: pr.merge_commit ?? null,
          closed_by: pr.closed_by ?? null,
          approvals,
          changes_requested: changesRequested,
          participant_count: reviewers.length,
          summary:
            pr.state === "MERGED"
              ? "Already merged"
              : pr.state === "DECLINED"
                ? "Declined; cannot merge"
                : changesRequested > 0
                  ? `Open with ${changesRequested} changes requested`
                  : `Open with ${approvals}/${reviewers.length} approvals`,
        };
      }),
  });

  server.addTool({
    name: "get_default_reviewers",
    description: "List default reviewers configured on a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(
          `/repositories/${workspaceOf(ctx, args.workspace)}/${args.repo_slug}/default-reviewers`,
        ),
      ),
  });

  // ---------- Create / update ----------

  server.addTool({
    name: "create_pull_request",
    description: "Create a Bitbucket pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      title: z.string(),
      source_branch: z.string(),
      destination_branch: z.string().default("main"),
      description: z.string().default(""),
      reviewers: z
        .array(z.string())
        .optional()
        .describe("Reviewer UUIDs (in {curly braces}) or account_ids"),
      use_default_reviewers: z.boolean().default(true),
      close_source_branch: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(async () => {
        ensureWritable(ctx);
        const ws = workspaceOf(ctx, args.workspace);
        const reviewerList: Array<Record<string, string>> = [];

        if (args.use_default_reviewers) {
          const defaults = await ctx.http.get<{
            values?: Array<{ uuid?: string }>;
          }>(`/repositories/${ws}/${args.repo_slug}/default-reviewers`);
          for (const r of defaults.values ?? []) {
            if (r.uuid) reviewerList.push({ uuid: r.uuid });
          }
        }
        if (args.reviewers) {
          for (const r of args.reviewers) {
            reviewerList.push(r.startsWith("{") ? { uuid: r } : { account_id: r });
          }
        }
        const seen = new Set<string>();
        const dedup = reviewerList.filter((r) => {
          const key = r.uuid ?? r.account_id ?? "";
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const payload: Record<string, unknown> = {
          title: args.title,
          source: { branch: { name: args.source_branch } },
          destination: { branch: { name: args.destination_branch } },
          close_source_branch: args.close_source_branch,
        };
        if (args.description) payload.description = args.description;
        if (dedup.length > 0) payload.reviewers = dedup;

        return ctx.http.post(`/repositories/${ws}/${args.repo_slug}/pullrequests`, payload);
      }),
  });

  server.addTool({
    name: "update_pull_request",
    description: "Update title, description, destination branch, or reviewers on a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      title: z.string().optional(),
      description: z.string().optional(),
      destination_branch: z.string().optional(),
      reviewers: z.array(z.string()).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: Record<string, unknown> = {};
        if (args.title !== undefined) payload.title = args.title;
        if (args.description !== undefined) payload.description = args.description;
        if (args.destination_branch !== undefined) {
          payload.destination = { branch: { name: args.destination_branch } };
        }
        if (args.reviewers !== undefined) {
          payload.reviewers = args.reviewers.map((r) =>
            r.startsWith("{") ? { uuid: r } : { account_id: r },
          );
        }
        return ctx.http.put(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}`,
          payload,
        );
      }),
  });

  // ---------- Approve / decline / merge ----------

  server.addTool({
    name: "approve_pull_request",
    description: "Approve a pull request as the authenticated user.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/approve`,
        );
      }),
  });

  server.addTool({
    name: "unapprove_pull_request",
    description: "Remove your approval from a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/approve`,
        );
      }),
  });

  server.addTool({
    name: "request_changes_pull_request",
    description: "Mark a pull request as requesting changes.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/request-changes`,
        );
      }),
  });

  server.addTool({
    name: "unrequest_changes_pull_request",
    description: "Withdraw a previous request-changes review from a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/request-changes`,
        );
      }),
  });

  server.addTool({
    name: "decline_pull_request",
    description: "Decline (close without merging) a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/decline`,
        );
      }),
  });

  server.addTool({
    name: "merge_pull_request",
    description: "Merge a pull request using the configured merge strategy.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      message: z.string().optional(),
      close_source_branch: z.boolean().optional(),
      merge_strategy: z.enum(["merge_commit", "squash", "fast_forward"]).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: Record<string, unknown> = {};
        if (args.message) payload.message = args.message;
        if (args.close_source_branch !== undefined) payload.close_source_branch = args.close_source_branch;
        if (args.merge_strategy) payload.merge_strategy = args.merge_strategy;
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}/merge`,
          payload,
        );
      }),
  });

  // ---------- Reviewers ----------

  server.addTool({
    name: "add_reviewer",
    description: "Add a reviewer to a pull request (supports UUID in {braces} or account_id).",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      reviewer: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(async () => {
        ensureWritable(ctx);
        const path = `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}`;
        const pr = await ctx.http.get<{
          reviewers?: Array<{ uuid?: string; account_id?: string }>;
        }>(path);
        const existing = pr.reviewers ?? [];
        const newRef = args.reviewer.startsWith("{")
          ? { uuid: args.reviewer }
          : { account_id: args.reviewer };
        const merged = [...existing, newRef];
        return ctx.http.put(path, { reviewers: merged });
      }),
  });

  server.addTool({
    name: "remove_reviewer",
    description: "Remove a reviewer from a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      reviewer: z.string().describe("UUID in {braces} or account_id to remove"),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(async () => {
        ensureWritable(ctx);
        const path = `${repoBase(args.workspace, args.repo_slug)}/${args.pull_request_id}`;
        const pr = await ctx.http.get<{
          reviewers?: Array<{ uuid?: string; account_id?: string }>;
        }>(path);
        const filtered = (pr.reviewers ?? []).filter(
          (r) => r.uuid !== args.reviewer && r.account_id !== args.reviewer,
        );
        return ctx.http.put(path, { reviewers: filtered });
      }),
  });
}
