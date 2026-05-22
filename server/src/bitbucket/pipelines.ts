// Bitbucket Pipelines tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";
import { BitbucketHttpError } from "../common/http.js";

export function registerPipelineTools(server: FastMCP, ctx: BitbucketContext): void {
  const repoBase = (workspace: string | undefined, repo: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${repo}`;

  const stepBase = (workspace: string | undefined, repo: string, pipeline: string, step: string): string =>
    `${repoBase(workspace, repo)}/pipelines/${encodeURIComponent(pipeline)}/steps/${encodeURIComponent(step)}`;

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

  // get_pipeline_step_log returns the step's stdout/stderr. Bitbucket has two
  // log surfaces:
  //   /steps/{uuid}/log     — legacy single concatenated log. Returns 406 Not
  //                           Acceptable for steps whose log is fronted by an
  //                           S3/CDN spool (large logs, multi-command Gradle
  //                           steps, anything with structured test reports).
  //   /steps/{uuid}/logs/   — newer per-command log index. Each entry has a
  //                           uuid; /steps/{uuid}/logs/{log_uuid} returns the
  //                           individual command body.
  // We try the legacy endpoint first (cheap one-shot for steps where it
  // works), and on 406 (or 404) we fall back to enumerating /logs/ and
  // concatenating the per-command bodies. Accept */* because the underlying
  // spool answers with various content types depending on age + size.
  server.addTool({
    name: "get_pipeline_step_log",
    description:
      "Get the raw log output for a single pipeline step. Auto-falls back to per-command logs if the unified /log endpoint returns 406 (common for steps with large logs or test reports).",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      step_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(async () => {
        const base = stepBase(args.workspace, args.repo_slug, args.pipeline_uuid, args.step_uuid);
        try {
          const body = await ctx.http.request<string>("GET", `${base}/log`, {
            headers: { Accept: "*/*" },
          });
          return { source: "unified", body };
        } catch (err: any) {
          const isHttp = err?.name === "BitbucketHttpError" || err instanceof BitbucketHttpError;
          // Fall back only for "no unified log available" responses. Other
          // errors (auth, missing step, 5xx) propagate unchanged.
          if (!isHttp || (err.status !== 406 && err.status !== 404)) throw err;
          const list = await ctx.http.get<any>(`${base}/logs/`, { pagelen: 100 });
          const entries: any[] = Array.isArray(list?.values) ? list.values : [];
          const bodies: Array<{ uuid: string; name?: string; body: string; error?: string }> = [];
          for (const entry of entries) {
            const logUuid = entry?.uuid ?? entry?.log_uuid;
            if (!logUuid) continue;
            try {
              const body = await ctx.http.request<string>(
                "GET",
                `${base}/logs/${encodeURIComponent(logUuid)}`,
                { headers: { Accept: "*/*" } },
              );
              bodies.push({ uuid: logUuid, name: entry?.name, body });
            } catch (innerErr: any) {
              bodies.push({
                uuid: logUuid,
                name: entry?.name,
                body: "",
                error: innerErr?.message ?? String(innerErr),
              });
            }
          }
          return {
            source: "per_command",
            unified_log_status: err.status,
            unified_log_hint:
              "Bitbucket's unified /log endpoint returned " +
              err.status +
              "; fell back to /logs/ per-command index. For structured test failure detail (names, classes, assertion messages) prefer list_pipeline_step_test_cases.",
            command_count: bodies.length,
            commands: bodies,
          };
        }
      }),
  });

  // /test_reports/* exposes structured test outcomes — test names, classes,
  // statuses, durations, assertion messages, and stack traces. This is the
  // proper surface for "which tests failed and why"; log scraping is a
  // fallback for steps that don't emit a test report.
  server.addTool({
    name: "get_pipeline_step_test_report",
    description:
      "Get the summary of a step's test report (totals: passed, failed, error, skipped). Returns empty body if no test report exists for the step.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      step_uuid: z.string(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() =>
        ctx.http.get(`${stepBase(args.workspace, args.repo_slug, args.pipeline_uuid, args.step_uuid)}/test_reports`),
      ),
  });

  server.addTool({
    name: "list_pipeline_step_test_cases",
    description:
      "List individual test cases from a step's test report. Filter by status (FAILED/ERROR/PASSED/SKIPPED/UNKNOWN) — for triage, request status=FAILED to get just the failing test names and classes. Each returned case carries its `reason` inline (assertion message + stack trace), so for typical failure triage this single call is sufficient — only fall back to list_pipeline_step_test_case_reasons if a case's inline reason is missing or truncated.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      step_uuid: z.string(),
      status: z
        .enum(["FAILED", "ERROR", "PASSED", "SKIPPED", "UNKNOWN"])
        .optional()
        .describe("Filter by test-case status. Omit to return all cases."),
      pagelen: z.number().int().min(1).max(100).optional(),
      page: z.number().int().positive().optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        const query: Record<string, string | number> = {
          pagelen: args.pagelen ?? 100,
        };
        if (args.page) query.page = args.page;
        // Bitbucket's test_cases endpoint accepts a `status` query filter.
        if (args.status) query.status = args.status;
        return ctx.http.get(
          `${stepBase(args.workspace, args.repo_slug, args.pipeline_uuid, args.step_uuid)}/test_reports/test_cases/`,
          query,
        );
      }),
  });

  // list_pipeline_step_test_case_reasons is a per-case detail fetch. Bitbucket
  // does NOT expose a bare collection endpoint at /test_case_reasons/ — that
  // path returns 404. test_case_uuid is therefore required. In practice, the
  // inline `reason` block on each case from list_pipeline_step_test_cases
  // already carries message + stack_trace, so this tool is only needed when
  // the inline reason is truncated or absent.
  server.addTool({
    name: "list_pipeline_step_test_case_reasons",
    description:
      "Fetch the reason (assertion message + stack trace) for one specific test case in a step. test_case_uuid is required — Bitbucket does not expose a bare collection endpoint. Typical triage uses the inline `reason` block returned by list_pipeline_step_test_cases instead of this tool; reach for this only when the inline reason is missing or truncated.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline_uuid: z.string(),
      step_uuid: z.string(),
      test_case_uuid: z
        .string()
        .describe(
          "UUID of the specific test case (as returned by list_pipeline_step_test_cases). Required.",
        ),
      pagelen: z.number().int().min(1).max(100).optional(),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(() => {
        const base = stepBase(args.workspace, args.repo_slug, args.pipeline_uuid, args.step_uuid);
        return ctx.http.get(
          `${base}/test_reports/test_cases/${encodeURIComponent(args.test_case_uuid)}/test_case_reasons/`,
          { pagelen: args.pagelen ?? 100 },
        );
      }),
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
