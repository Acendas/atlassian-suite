// PR comment tools (top-level, inline, replies, deletions).

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerCommentTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string, prId: number): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}/pullrequests/${prId}`;

  server.addTool({
    name: "get_pull_request_comments",
    description: "List comments on a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "add_pull_request_comment",
    description: "Add a top-level (non-inline) comment to a pull request.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      content: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments`,
          { content: { raw: args.content } },
        );
      }),
  });

  server.addTool({
    name: "add_inline_comment",
    description: "Add an inline comment anchored to a file/line in a pull request diff.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      content: z.string(),
      path: z.string().describe("Path of the file in the diff"),
      line_to: z.number().int().positive().optional().describe("Destination-side line number"),
      line_from: z.number().int().positive().optional().describe("Source-side line number (for deletions)"),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const inline: Record<string, unknown> = { path: args.path };
        if (args.line_to !== undefined) inline.to = args.line_to;
        if (args.line_from !== undefined) inline.from = args.line_from;
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments`,
          { content: { raw: args.content }, inline },
        );
      }),
  });

  server.addTool({
    name: "reply_to_comment",
    description: "Reply to an existing pull request comment.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      parent_comment_id: z.number().int().positive(),
      content: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments`,
          {
            content: { raw: args.content },
            parent: { id: args.parent_comment_id },
          },
        );
      }),
  });

  server.addTool({
    name: "resolve_pull_request_comment",
    description: "Mark a pull request comment thread as resolved.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      comment_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments/${args.comment_id}/resolve`,
        );
      }),
  });

  server.addTool({
    name: "reopen_pull_request_comment",
    description: "Reopen (un-resolve) a pull request comment thread.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      comment_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments/${args.comment_id}/resolve`,
        );
      }),
  });

  server.addTool({
    name: "delete_comment",
    description: "Delete a pull request comment by ID.",
    parameters: z.object({
      repo_slug: z.string(),
      pull_request_id: z.number().int().positive(),
      comment_id: z.number().int().positive(),
      workspace: z.string().optional(),
    }),
    execute: async (args) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug, args.pull_request_id)}/comments/${args.comment_id}`,
        );
      }),
  });
}
