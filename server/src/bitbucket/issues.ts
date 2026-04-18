// Bitbucket native issue tracker tools (separate from Jira).

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerBitbucketIssueTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_issues",
    description: "List Bitbucket native issues in a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      query: z.string().optional(),
      sort: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/issues`, {
          q: args.query,
          sort: args.sort,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "get_issue",
    description: "Get a Bitbucket native issue by id.",
    parameters: z.object({
      repo_slug: z.string(),
      issue_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/issues/${args.issue_id}`),
      ),
  });

  server.addTool({
    name: "create_issue",
    description: "Create a Bitbucket native issue.",
    parameters: z.object({
      repo_slug: z.string(),
      title: z.string(),
      content: z.string().optional(),
      kind: z.enum(["bug", "enhancement", "proposal", "task"]).optional(),
      priority: z.enum(["trivial", "minor", "major", "critical", "blocker"]).optional(),
      assignee_uuid: z.string().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = { title: args.title };
        if (args.content) payload.content = { raw: args.content };
        if (args.kind) payload.kind = args.kind;
        if (args.priority) payload.priority = args.priority;
        if (args.assignee_uuid) payload.assignee = { uuid: args.assignee_uuid };
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/issues`, payload);
      }),
  });

  server.addTool({
    name: "update_issue",
    description: "Update a Bitbucket native issue.",
    parameters: z.object({
      repo_slug: z.string(),
      issue_id: z.number().int().positive(),
      title: z.string().optional(),
      content: z.string().optional(),
      state: z
        .enum(["new", "open", "resolved", "closed", "on hold", "invalid", "duplicate", "wontfix"])
        .optional(),
      kind: z.enum(["bug", "enhancement", "proposal", "task"]).optional(),
      priority: z.enum(["trivial", "minor", "major", "critical", "blocker"]).optional(),
      assignee_uuid: z.string().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = {};
        if (args.title !== undefined) payload.title = args.title;
        if (args.content !== undefined) payload.content = { raw: args.content };
        if (args.state !== undefined) payload.state = args.state;
        if (args.kind !== undefined) payload.kind = args.kind;
        if (args.priority !== undefined) payload.priority = args.priority;
        if (args.assignee_uuid !== undefined) payload.assignee = { uuid: args.assignee_uuid };
        return ctx.http.put(
          `${repoBase(args.workspace, args.repo_slug)}/issues/${args.issue_id}`,
          payload,
        );
      }),
  });

  server.addTool({
    name: "list_issue_comments",
    description: "List comments on a Bitbucket native issue.",
    parameters: z.object({
      repo_slug: z.string(),
      issue_id: z.number().int().positive(),
      pagelen: z.number().int().min(1).max(100).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/issues/${args.issue_id}/comments`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "add_issue_comment",
    description: "Add a comment to a Bitbucket native issue.",
    parameters: z.object({
      repo_slug: z.string(),
      issue_id: z.number().int().positive(),
      content: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/issues/${args.issue_id}/comments`,
          { content: { raw: args.content } },
        );
      }),
  });
}
