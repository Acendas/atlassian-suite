// Pipeline schedules + workspace/project-level pipeline variables.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerPipelineExtraTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  // ---------- Schedules ----------

  server.addTool({
    name: "list_pipeline_schedules",
    description: "List scheduled pipeline runs for a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/pipelines_config/schedules/`, {
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "create_pipeline_schedule",
    description: "Create a new scheduled pipeline run.",
    parameters: z.object({
      repo_slug: z.string(),
      target: z.object({
        ref_type: z.enum(["branch", "tag"]),
        ref_name: z.string(),
        selector: z
          .object({
            type: z.enum(["custom", "branches", "default", "pull-requests"]),
            pattern: z.string(),
          })
          .optional(),
      }),
      cron_pattern: z.string().describe("Crontab format (UTC)"),
      enabled: z.boolean().default(true),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines_config/schedules/`,
          {
            target: { ...args.target, type: "pipeline_ref_target" },
            cron_pattern: args.cron_pattern,
            enabled: args.enabled,
          },
        );
      }),
  });

  server.addTool({
    name: "update_pipeline_schedule",
    description: "Update a pipeline schedule (e.g. enable/disable).",
    parameters: z.object({
      repo_slug: z.string(),
      schedule_uuid: z.string(),
      cron_pattern: z.string().optional(),
      enabled: z.boolean().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const payload: any = {};
        if (args.cron_pattern !== undefined) payload.cron_pattern = args.cron_pattern;
        if (args.enabled !== undefined) payload.enabled = args.enabled;
        return ctx.http.put(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines_config/schedules/${encodeURIComponent(args.schedule_uuid)}`,
          payload,
        );
      }),
  });

  server.addTool({
    name: "delete_pipeline_schedule",
    description: "Delete a pipeline schedule.",
    parameters: z.object({
      repo_slug: z.string(),
      schedule_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines_config/schedules/${encodeURIComponent(args.schedule_uuid)}`,
        );
      }),
  });

  // ---------- Workspace pipeline variables ----------

  server.addTool({
    name: "list_workspace_pipeline_variables",
    description: "List workspace-level pipeline variables.",
    parameters: z.object({
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `/workspaces/${workspaceOf(ctx, args.workspace)}/pipelines-config/variables/`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "create_workspace_pipeline_variable",
    description: "Create a workspace-level pipeline variable.",
    parameters: z.object({
      key: z.string(),
      value: z.string(),
      secured: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `/workspaces/${workspaceOf(ctx, args.workspace)}/pipelines-config/variables/`,
          { key: args.key, value: args.value, secured: args.secured },
        );
      }),
  });

  server.addTool({
    name: "delete_workspace_pipeline_variable",
    description: "Delete a workspace-level pipeline variable.",
    parameters: z.object({
      variable_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `/workspaces/${workspaceOf(ctx, args.workspace)}/pipelines-config/variables/${encodeURIComponent(args.variable_uuid)}`,
        );
      }),
  });

  // ---------- Project pipeline variables ----------

  server.addTool({
    name: "list_project_pipeline_variables",
    description: "List project-level pipeline variables.",
    parameters: z.object({
      project_key: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `/workspaces/${workspaceOf(ctx, args.workspace)}/projects/${args.project_key}/pipelines-config/variables/`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "create_project_pipeline_variable",
    description: "Create a project-level pipeline variable.",
    parameters: z.object({
      project_key: z.string(),
      key: z.string(),
      value: z.string(),
      secured: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `/workspaces/${workspaceOf(ctx, args.workspace)}/projects/${args.project_key}/pipelines-config/variables/`,
          { key: args.key, value: args.value, secured: args.secured },
        );
      }),
  });
}
