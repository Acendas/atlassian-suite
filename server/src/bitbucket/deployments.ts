// Bitbucket deployments + environments + environment variables.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerDeploymentTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  // ---------- Deployments ----------

  server.addTool({
    name: "list_deployments",
    description: "List deployments for a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
      sort: z.string().optional().describe("e.g. -created_on"),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/deployments/`, {
          pagelen: args.pagelen ?? 25,
          sort: args.sort ?? "-created_on",
        }),
      ),
  });

  server.addTool({
    name: "get_deployment",
    description: "Get a single deployment by UUID.",
    parameters: z.object({
      repo_slug: z.string(),
      deployment_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/deployments/${encodeURIComponent(args.deployment_uuid)}`,
        ),
      ),
  });

  // ---------- Environments ----------

  server.addTool({
    name: "list_environments",
    description: "List deployment environments for a repository.",
    parameters: z.object({
      repo_slug: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${repoBase(args.workspace, args.repo_slug)}/environments/`, {
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "get_environment",
    description: "Get a single environment by UUID.",
    parameters: z.object({
      repo_slug: z.string(),
      environment_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/environments/${encodeURIComponent(args.environment_uuid)}`,
        ),
      ),
  });

  server.addTool({
    name: "create_environment",
    description: "Create a deployment environment.",
    parameters: z.object({
      repo_slug: z.string(),
      name: z.string(),
      environment_type: z.enum(["Test", "Staging", "Production"]),
      rank: z.number().int().min(0).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(`${repoBase(args.workspace, args.repo_slug)}/environments/`, {
          name: args.name,
          environment_type: { name: args.environment_type, rank: args.rank ?? 0 },
        });
      }),
  });

  server.addTool({
    name: "delete_environment",
    description: "Delete a deployment environment.",
    parameters: z.object({
      repo_slug: z.string(),
      environment_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/environments/${encodeURIComponent(args.environment_uuid)}`,
        );
      }),
  });

  // ---------- Environment variables ----------

  server.addTool({
    name: "list_environment_variables",
    description: "List variables for a deployment environment.",
    parameters: z.object({
      repo_slug: z.string(),
      environment_uuid: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${repoBase(args.workspace, args.repo_slug)}/deployments_config/environments/${encodeURIComponent(args.environment_uuid)}/variables`,
          { pagelen: args.pagelen ?? 100 },
        ),
      ),
  });

  server.addTool({
    name: "create_environment_variable",
    description: "Add a variable to a deployment environment.",
    parameters: z.object({
      repo_slug: z.string(),
      environment_uuid: z.string(),
      key: z.string(),
      value: z.string(),
      secured: z.boolean().default(false),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${repoBase(args.workspace, args.repo_slug)}/deployments_config/environments/${encodeURIComponent(args.environment_uuid)}/variables`,
          { key: args.key, value: args.value, secured: args.secured },
        );
      }),
  });

  server.addTool({
    name: "delete_environment_variable",
    description: "Delete a deployment environment variable.",
    parameters: z.object({
      repo_slug: z.string(),
      environment_uuid: z.string(),
      variable_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${repoBase(args.workspace, args.repo_slug)}/deployments_config/environments/${encodeURIComponent(args.environment_uuid)}/variables/${encodeURIComponent(args.variable_uuid)}`,
        );
      }),
  });
}
