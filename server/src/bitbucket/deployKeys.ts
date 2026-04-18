// Repository deploy keys + user SSH keys.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerKeyTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_deploy_keys",
    description: "List repository deploy keys.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/deploy-keys`, {
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "create_deploy_key",
    description: "Add a deploy key to a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      key: z.string().describe("SSH public key"),
      label: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/deploy-keys`, {
          key: args.key,
          label: args.label,
        });
      }),
  });

  server.addTool({
    name: "delete_deploy_key",
    description: "Delete a deploy key from a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      key_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/deploy-keys/${args.key_id}`,
        );
      }),
  });

  server.addTool({
    name: "list_user_ssh_keys",
    description: "List SSH keys for a user.",
    parameters: z.object({
      user_selector: z.string().describe("UUID in {braces}, account_id, or username"),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`/users/${encodeURIComponent(args.user_selector)}/ssh-keys`, {
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "add_user_ssh_key",
    description: "Add an SSH key to a user.",
    parameters: z.object({
      user_selector: z.string(),
      key: z.string().describe("SSH public key"),
      label: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(`/users/${encodeURIComponent(args.user_selector)}/ssh-keys`, {
          key: args.key,
          label: args.label,
        });
      }),
  });

  server.addTool({
    name: "delete_user_ssh_key",
    description: "Delete an SSH key from a user.",
    parameters: z.object({
      user_selector: z.string(),
      key_id: z.string(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `/users/${encodeURIComponent(args.user_selector)}/ssh-keys/${args.key_id}`,
        );
      }),
  });
}
