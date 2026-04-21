// Bitbucket PR tasks — actionable TODOs attached to a pull request.
//
// Distinct from comments: tasks are explicit trackable items ("fix this
// before merge"), resolved/unresolved states, show up in the reviewer
// checklist sidebar. Lead devs live in these during review; missing them
// is a real gap.
//
// Endpoints (Bitbucket Cloud v2):
//   GET    /repositories/{ws}/{repo}/pullrequests/{id}/tasks
//   POST   /repositories/{ws}/{repo}/pullrequests/{id}/tasks
//   GET    /repositories/{ws}/{repo}/pullrequests/{id}/tasks/{task_id}
//   PUT    /repositories/{ws}/{repo}/pullrequests/{id}/tasks/{task_id}
//   DELETE /repositories/{ws}/{repo}/pullrequests/{id}/tasks/{task_id}
//
// Tasks can optionally be anchored to a specific comment (reply-task)
// or float at the PR level (standalone). The POST body is:
//   { content: { raw: "..." }, comment?: { id: <comment_id> } }
// Resolving vs reopening is PUT with { state: "RESOLVED" | "UNRESOLVED" }.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, ensureWritable, workspaceOf } from "./_helpers.js";

export function registerPullRequestTaskTools(server: FastMCP, ctx: BitbucketContext): void {
  const base = (workspace: string | undefined, repo: string, prId: number): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${encodeURIComponent(repo)}/pullrequests/${prId}/tasks`;

  // ---------------- List PR tasks ----------------

  server.addTool({
    name: "list_pull_request_tasks",
    description:
      "List tasks (actionable TODOs) on a pull request. Distinct from comments — tasks have state (RESOLVED/UNRESOLVED) and show in the reviewer checklist. Supports filtering by state (`open` shows unresolved only).",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      state: z.enum(["open", "resolved", "all"]).default("open"),
      pagelen: z.number().int().min(1).max(100).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      pull_request_id: number;
      state: "open" | "resolved" | "all";
      pagelen?: number;
      workspace?: string;
    }) =>
      safeExecute(() => {
        const query: Record<string, string | number> = {
          pagelen: args.pagelen ?? 50,
        };
        // Bitbucket's `q` filter: state="RESOLVED" or state="UNRESOLVED".
        if (args.state === "open") query.q = 'state="UNRESOLVED"';
        else if (args.state === "resolved") query.q = 'state="RESOLVED"';
        return ctx.http.get(base(args.workspace, args.repo_slug, args.pull_request_id), query);
      }),
  });

  // ---------------- Get single task ----------------

  server.addTool({
    name: "get_pull_request_task",
    description: "Get a single PR task by its numeric id.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      task_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      pull_request_id: number;
      task_id: number;
      workspace?: string;
    }) =>
      safeExecute(() =>
        ctx.http.get(`${base(args.workspace, args.repo_slug, args.pull_request_id)}/${args.task_id}`),
      ),
  });

  // ---------------- Create task ----------------

  server.addTool({
    name: "create_pull_request_task",
    description:
      "Create a new task on a pull request. If `comment_id` is given, the task is anchored to that comment (reply-task). Otherwise it's a standalone PR-level task. Markdown content supported in `content`.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      content: z.string().describe("Task text (Markdown)"),
      comment_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Anchor this task to an existing comment"),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      pull_request_id: number;
      content: string;
      comment_id?: number;
      workspace?: string;
    }) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: Record<string, unknown> = {
          content: { raw: args.content },
        };
        if (args.comment_id) payload.comment = { id: args.comment_id };
        return ctx.http.post(
          base(args.workspace, args.repo_slug, args.pull_request_id),
          payload,
        );
      }),
  });

  // ---------------- Update (resolve / reopen / edit) task ----------------

  server.addTool({
    name: "update_pull_request_task",
    description:
      "Update a PR task — resolve it, reopen it, or edit its content. Pass `state` to change resolution; pass `content` to edit the body.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      task_id: z.number().int().positive(),
      state: z.enum(["RESOLVED", "UNRESOLVED"]).optional(),
      content: z.string().optional().describe("New task text (Markdown)"),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      pull_request_id: number;
      task_id: number;
      state?: "RESOLVED" | "UNRESOLVED";
      content?: string;
      workspace?: string;
    }) =>
      safeExecute(() => {
        ensureWritable(ctx);
        if (!args.state && !args.content) {
          throw new Error("update_pull_request_task requires at least one of: state, content");
        }
        const payload: Record<string, unknown> = {};
        if (args.state) payload.state = args.state;
        if (args.content) payload.content = { raw: args.content };
        return ctx.http.put(
          `${base(args.workspace, args.repo_slug, args.pull_request_id)}/${args.task_id}`,
          payload,
        );
      }),
  });

  // ---------------- Delete task ----------------

  server.addTool({
    name: "delete_pull_request_task",
    description: "Permanently delete a PR task. Destructive — no trash.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      task_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      pull_request_id: number;
      task_id: number;
      workspace?: string;
    }) =>
      safeExecute(async () => {
        ensureWritable(ctx);
        await ctx.http.delete(
          `${base(args.workspace, args.repo_slug, args.pull_request_id)}/${args.task_id}`,
        );
        return { deleted: true, task_id: args.task_id };
      }),
  });
}
