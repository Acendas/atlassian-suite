// Bitbucket Pipelines tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { resolve as resolvePath } from "node:path";
import { safeExecute, workspaceOf, ensureWritable } from "./_helpers.js";
import { BitbucketHttpError } from "../common/http.js";
import {
  buildWatchCommand,
  classifyPipeline,
  describeTarget,
  doneLine,
  pipelineUrl,
  progressLine,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_MINUTES,
  MIN_INTERVAL_SECONDS,
  type Pipeline,
  type PipelineStep,
} from "./_pipelineWatch.js";

/** Env vars that can feed loadBitbucketConfig. Names only — values never leave the server. */
const CREDENTIAL_ENV_VARS = [
  "BITBUCKET_WORKSPACE",
  "BITBUCKET_USERNAME",
  "BITBUCKET_API_TOKEN",
  "ATLASSIAN_USERNAME",
  "ATLASSIAN_API_TOKEN",
];

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

  // watch_pipeline does not poll. An MCP call can't outlive its turn, and a
  // model polling get_pipeline in a loop burns turns. It resolves the run and
  // hands back a follower command for Claude Code's Monitor, which turns each
  // line the follower prints into a notification (see _pipelineWatch.ts).
  server.addTool({
    name: "watch_pipeline",
    description:
      "Resolve a pipeline run and return a Monitor command that streams its step results and ends with one DONE / WATCH_ERROR / WATCH_TIMEOUT line. Pass a build number or {uuid}, or a branch to watch its latest run (branch and PR pipelines, by source branch). Read-only.",
    parameters: z.object({
      repo_slug: z.string(),
      pipeline: z.string().optional().describe("Build number (e.g. 5956) or {uuid}. Omit to use the latest run on `branch`."),
      branch: z.string().optional().describe("Watch the most recent run on this branch."),
      interval_seconds: z
        .number()
        .int()
        .min(MIN_INTERVAL_SECONDS)
        .max(300)
        .optional()
        .describe(`Poll interval. Default ${DEFAULT_INTERVAL_SECONDS}; each poll is 2 API calls.`),
      max_minutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe(
          `Watcher gives up with WATCH_TIMEOUT this long after this call. Default ${DEFAULT_MAX_MINUTES}. ` +
            `The limit is baked into monitor_command, so re-arming the same command keeps it.`,
        ),
      workspace: z.string().optional(),
    }),
    execute: async (args: any) =>
      safeExecute(async () => {
        if (!args.pipeline && !args.branch) {
          throw new Error("Pass pipeline (build number or {uuid}) or branch.");
        }
        const workspace = workspaceOf(ctx, args.workspace);
        const pipelines = `${repoBase(args.workspace, args.repo_slug)}/pipelines/`;
        let p: Pipeline | undefined;
        if (args.pipeline) {
          p = await ctx.http.get<Pipeline>(`${pipelines}${encodeURIComponent(args.pipeline)}`);
        } else {
          // `target.branch` matches branch pipelines and PR pipelines by their
          // source branch; `target.ref_name` misses the PR ones.
          const list = await ctx.http.get<{ values?: Pipeline[] }>(pipelines, {
            sort: "-created_on",
            pagelen: 1,
            "target.branch": args.branch,
          });
          p = list?.values?.[0];
          if (!p) throw new Error(`No pipeline runs on branch ${args.branch} in ${workspace}/${args.repo_slug}.`);
        }
        const stepList = await ctx.http.get<{ values?: PipelineStep[] }>(
          `${pipelines}${encodeURIComponent(p.uuid ?? args.pipeline)}/steps/`,
          { pagelen: 100 },
        );
        const steps = Array.isArray(stepList?.values) ? stepList.values : [];
        const buildNumber = p.build_number ?? args.pipeline;
        const tag = `[pipeline #${buildNumber}]`;
        const url = pipelineUrl(workspace, args.repo_slug, buildNumber);
        const { label, terminal } = classifyPipeline(p.state);
        const out: Record<string, unknown> = {
          build_number: p.build_number,
          uuid: p.uuid,
          target: describeTarget(p),
          state: label,
          terminal,
          summary: terminal ? doneLine(tag, p, steps, url) : progressLine(tag, args.repo_slug, p, steps),
          url,
        };
        if (!terminal) {
          out.monitor_command = buildWatchCommand({
            node: process.execPath,
            nodeArgs: process.execArgv,
            entry: resolvePath(process.argv[1] ?? ""),
            workspace,
            repo: args.repo_slug,
            buildNumber,
            intervalSeconds: args.interval_seconds,
            deadlineEpochSeconds:
              Math.floor(Date.now() / 1000) + (args.max_minutes ?? DEFAULT_MAX_MINUTES) * 60,
          });
          out.monitor_description = `Bitbucket pipeline ${args.repo_slug} #${buildNumber}`;
          const fromEnv = CREDENTIAL_ENV_VARS.filter((k) => process.env[k]);
          if (fromEnv.length > 0) {
            out.credentials_note =
              `Bitbucket settings come partly from env vars (${fromEnv.join(", ")}). The watch command runs in ` +
              `your shell, not in this server, so those must be set there too, or stored with /atlassian-suite:as-init.`;
          }
        }
        return out;
      }),
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
