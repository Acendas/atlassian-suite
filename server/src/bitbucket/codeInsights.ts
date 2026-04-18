// Bitbucket Code Insights — commit reports + annotations.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";

export function registerCodeInsightsTools(server: FastMCP, ctx: BitbucketContext): void {
  const reportBase = (workspace: string | undefined, repo: string, commit: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}/commit/${commit}/reports`;

  server.addTool({
    name: "list_commit_reports",
    description: "List code insight reports attached to a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(reportBase(args.workspace, args.repo_slug, args.commit), {
          pagelen: args.pagelen ?? 50,
        }),
      ),
  });

  server.addTool({
    name: "get_commit_report",
    description: "Get a specific code insight report on a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}`,
        ),
      ),
  });

  server.addTool({
    name: "create_or_update_commit_report",
    description: "Create or replace a code insight report on a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      title: z.string(),
      details: z.string().optional(),
      report_type: z.enum(["SECURITY", "COVERAGE", "TEST", "BUG"]).optional(),
      result: z.enum(["PASSED", "FAILED", "PENDING"]).optional(),
      reporter: z.string().optional(),
      link: z.string().url().optional(),
      logo_url: z.string().url().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.put(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}`,
          {
            title: args.title,
            details: args.details,
            report_type: args.report_type,
            result: args.result,
            reporter: args.reporter,
            link: args.link,
            logo_url: args.logo_url,
          },
        );
      }),
  });

  server.addTool({
    name: "delete_commit_report",
    description: "Delete a code insight report from a commit.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}`,
        );
      }),
  });

  server.addTool({
    name: "list_report_annotations",
    description: "List annotations on a code insight report.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      workspace: z.string().optional(),
      pagelen: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}/annotations`,
          { pagelen: args.pagelen ?? 50 },
        ),
      ),
  });

  server.addTool({
    name: "get_report_annotation",
    description: "Get a single annotation by id.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      annotation_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}/annotations/${args.annotation_id}`,
        ),
      ),
  });

  server.addTool({
    name: "create_or_update_report_annotation",
    description: "Create or replace a single annotation on a code insight report.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      annotation_id: z.string(),
      annotation_type: z.enum(["VULNERABILITY", "CODE_SMELL", "BUG"]).optional(),
      summary: z.string(),
      details: z.string().optional(),
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
      path: z.string().optional(),
      line: z.number().int().positive().optional(),
      link: z.string().url().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.put(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}/annotations/${args.annotation_id}`,
          {
            annotation_type: args.annotation_type,
            summary: args.summary,
            details: args.details,
            severity: args.severity,
            path: args.path,
            line: args.line,
            link: args.link,
          },
        );
      }),
  });

  server.addTool({
    name: "bulk_create_report_annotations",
    description: "Create multiple annotations on a report in one call.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      annotations: z
        .array(
          z.object({
            external_id: z.string().describe("Unique annotation id (caller-supplied)"),
            annotation_type: z.enum(["VULNERABILITY", "CODE_SMELL", "BUG"]).optional(),
            summary: z.string(),
            details: z.string().optional(),
            severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
            path: z.string().optional(),
            line: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(100),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.post(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}/annotations`,
          args.annotations,
        );
      }),
  });

  server.addTool({
    name: "delete_report_annotation",
    description: "Delete a single annotation.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z.string(),
      report_id: z.string(),
      annotation_id: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        ensureWritable(ctx);
        return ctx.http.delete(
          `${reportBase(args.workspace, args.repo_slug, args.commit)}/${args.report_id}/annotations/${args.annotation_id}`,
        );
      }),
  });
}
