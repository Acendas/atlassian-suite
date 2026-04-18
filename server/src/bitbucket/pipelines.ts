// Bitbucket Pipelines tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerPipelineTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  server.addTool({
    name: "list_pipelines",
    description: "List pipeline runs for a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      sort: z.string().optional().describe("e.g. -created_on"),
      query: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/pipelines/`, {
          sort: args.sort ?? "-created_on",
          q: args.query,
          pagelen: args.pagelen ?? 25,
          page: args.page,
        }),
      ),
  });

  server.addTool({
    name: "get_pipeline",
    description: "Get details for a single pipeline run.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string().describe("UUID in {curly braces} or numeric build number"),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines/${encodeURIComponent(args.pipeline_uuid)}`,
        ),
      ),
  });

  server.addTool({
    name: "trigger_pipeline",
    description: "Trigger a new pipeline run on a branch, commit, or tag.",
    parameters: z.object({
      repo_slug: z.string(),
      branch: z.string().optional(),
      commit_hash: z.string().optional(),
      tag: z.string().optional(),
      pipeline_pattern: z.string().optional().describe("Custom pipeline name (e.g. 'release')"),
      variables: z
        .array(
          z.object({
            key: z.string(),
            value: z.string(),
            secured: z.boolean().default(false),
          }),
        )
        .optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        const target: any = {};
        if (args.branch) {
          target.ref_type = "branch";
          target.ref_name = args.branch;
          target.type = "pipeline_ref_target";
        }
        if (args.commit_hash) {
          target.type = "pipeline_commit_target";
          target.commit = { type: "commit", hash: args.commit_hash };
        }
        if (args.tag) {
          target.ref_type = "tag";
          target.ref_name = args.tag;
          target.type = "pipeline_ref_target";
        }
        if (args.pipeline_pattern) {
          target.selector = { type: "custom", pattern: args.pipeline_pattern };
        }
        const payload: any = { target };
        if (args.variables) payload.variables = args.variables;
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/pipelines/`, payload);
      }),
  });

  server.addTool({
    name: "stop_pipeline",
    description: "Stop a running pipeline.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines/${encodeURIComponent(args.pipeline_uuid)}/stopPipeline`,
        );
      }),
  });

  server.addTool({
    name: "list_pipeline_steps",
    description: "List steps for a pipeline run.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines/${encodeURIComponent(args.pipeline_uuid)}/steps/`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "get_pipeline_step_log",
    description: "Get the raw log output for a single pipeline step.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      step_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get<string>(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines/${encodeURIComponent(args.pipeline_uuid)}/steps/${encodeURIComponent(args.step_uuid)}/log`,
        ),
      ),
  });

  server.addTool({
    name: "list_pipeline_variables",
    description: "List repository-level pipeline variables.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines_config/variables/`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "create_pipeline_variable",
    description: "Create a repository-level pipeline variable.",
    parameters: z.object({
      repo_slug: z.string(),
      key: z.string(),
      value: z.string(),
      secured: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/pipelines_config/variables/`,
          { key: args.key, value: args.value, secured: args.secured },
        );
      }),
  });
}
