import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { basename } from "path";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { loadQMetryConfig } from "../common/config.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";

export function registerQMetryExecutionTools(server: FastMCP, opts: { readOnly: boolean }): void {
  // ─── Execution result statuses ────────────────────────────────────────────

  server.addTool({
    name: "qmetry_get_execution_results",
    description: "List execution result statuses (Pass, Fail, Blocked, etc.) with their numeric IDs for a project.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(`/projects/${args.project_id}/execution-results`),
      ),
  });

  // ─── Search executions in a test cycle ───────────────────────────────────

  server.addTool({
    name: "qmetry_search_executions",
    description: "Search test case executions within a specific test cycle. Returns each test case's execution status, assignee, and execution IDs.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID (opaque string from qmetry_search_test_cycles)"),
      test_case_key: z.string().optional().describe("Filter to a specific test case key, e.g. PROJ-TC-5"),
      status: z.array(z.string()).optional().describe("Filter by execution result status names, e.g. ['Pass', 'Fail']"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const filter: Record<string, unknown> = {};
        if (args.test_case_key) filter.key = args.test_case_key;
        if (args.status?.length) filter.status = args.status;
        return qmetryClient().post<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcases/search`,
          { filter },
          { startAt: args.start_at, maxResults: args.max_results },
        );
      }),
  });

  // ─── Get execution history for a test case in a cycle ────────────────────

  server.addTool({
    name: "qmetry_get_execution",
    description:
      "Get execution history for a test case within a test cycle. " +
      "Returns the full execution record: status, comment, assignee, attachments flag, step count, timestamps. " +
      "Use test_cycle_map_id (testCycleTestCaseMapId) from qmetry_search_executions results.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID"),
      test_cycle_map_id: z.number().int().describe("testCycleTestCaseMapId from qmetry_search_executions — identifies the test case within this cycle"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcases/${args.test_cycle_map_id}/executions`,
        ),
      ),
  });

  // ─── Update an execution ─────────────────────────────────────────────────

  server.addTool({
    name: "qmetry_update_execution",
    description:
      "Update a test case execution within a test cycle: set execution result (Pass/Fail/etc.), " +
      "add a comment, set the assignee. At least one of status_name, comment, or assignee_account_id is required. " +
      "Get execution_id (testCaseExecutionId) from qmetry_get_execution or qmetry_search_executions.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID"),
      execution_id: z.number().int().describe("testCaseExecutionId from qmetry_get_execution results"),
      status_name: z.string().optional().describe("Execution result name, e.g. 'Pass', 'Fail', 'Blocked', 'Not Executed', 'Work In Progress'. Requires project_id."),
      project_id: z.number().int().optional().describe("Numeric QMetry project ID — required when status_name is provided to look up the correct executionResultId"),
      comment: z.string().optional().describe("Comment or notes for this execution"),
      assignee_account_id: z.string().optional().describe("Atlassian account ID of the person to assign (e.g. '712020:abc...'). Find account IDs via jira_get_user_profile or jira_search."),
    }),
    execute: async (args) =>
      safeQMetry(async () => {
        ensureWritable(opts.readOnly);

        const body: Record<string, unknown> = {};

        // Status name → executionResultId lookup
        if (args.status_name) {
          if (!args.project_id) {
            throw new Error("project_id is required when status_name is provided (used to look up the correct executionResultId for this project).");
          }
          const results = await qmetryClient().get<Array<{ id: number; name: string }>>(
            `/projects/${args.project_id}/execution-results`,
          );
          const match = (results ?? []).find(
            (r) => r.name.toLowerCase() === args.status_name!.toLowerCase(),
          );
          if (!match) {
            const available = (results ?? []).map((r) => r.name).join(", ");
            throw new Error(`Unknown status '${args.status_name}'. Available: ${available}`);
          }
          body.executionResultId = match.id;
        }

        if (args.comment !== undefined) body.comment = args.comment;
        if (args.assignee_account_id) body.assignee = args.assignee_account_id;

        if (Object.keys(body).length === 0) {
          throw new Error("Provide at least one of: status_name, comment, or assignee_account_id.");
        }

        // PUT returns 204 No Content on success
        await qmetryClient().put<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcase-executions/${args.execution_id}`,
          body,
        );
        return { updated: true, fields: Object.keys(body) };
      }),
  });

  // ─── List attachments on an execution ────────────────────────────────────

  server.addTool({
    name: "qmetry_list_execution_attachments",
    description: "List files attached to a test case execution (at execution or step level).",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID"),
      execution_id: z.number().int().describe("testCaseExecutionId from qmetry_get_execution results"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcase-executions/${args.execution_id}/attachments`,
          { startAt: args.start_at, maxResults: args.max_results },
        ),
      ),
  });

  // ─── Upload an attachment to an execution ─────────────────────────────────

  server.addTool({
    name: "qmetry_upload_execution_attachment",
    description:
      "Upload a local file to a QMetry test cycle's file store (2-step: get S3 policy from QMetry, POST to S3). " +
      "Files are stored at the test cycle level in QMetry. " +
      "To see uploaded files use qmetry_list_execution_attachments (shows execution-scoped attachments added via the QMetry app).",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID"),
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      local_file_path: z.string().describe("Absolute path to the file on this machine to upload"),
      file_name: z.string().optional().describe("Override file name (defaults to the filename from local_file_path)"),
    }),
    execute: async (args) =>
      safeQMetry(async () => {
        ensureWritable(opts.readOnly);

        const cfg = loadQMetryConfig();
        if (!cfg) throw new Error("QMetry not configured.");

        // Resolve file name
        const fileName = args.file_name ?? basename(args.local_file_path);

        // Check file exists
        await stat(args.local_file_path);

        // Step 1: get S3 upload policy from QMetry
        const policy = await qmetryClient().get<{
          endpoint_url: string;
          params: Record<string, string>;
        }>(
          "/testcycles/attachments/url",
          {
            projectId: args.project_id,
            fileName,
            testCycleId: args.test_cycle_id,
          },
        );

        if (!policy?.endpoint_url || !policy?.params) {
          throw new Error("QMetry did not return a valid S3 upload policy.");
        }

        // Step 2: read file and POST multipart form data to S3
        const fileData = await readFile(args.local_file_path);
        const boundary = `FormBoundary${Date.now()}${Math.random().toString(36).slice(2, 10)}`;

        // Build multipart body — S3 pre-signed POST requires params before file, file last
        const paramParts: Buffer[] = [];
        for (const [k, v] of Object.entries(policy.params)) {
          paramParts.push(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
            ),
          );
        }

        const filePart = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        );
        const closing = Buffer.from(`\r\n--${boundary}--\r\n`);

        const body = Buffer.concat([...paramParts, filePart, fileData, closing]);

        const s3Res = await fetch(policy.endpoint_url, {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.byteLength),
          },
          body,
        });

        // S3 pre-signed POST returns 201 on success (policy sets success_action_status=201)
        if (s3Res.status !== 201 && !s3Res.ok) {
          const text = await s3Res.text().catch(() => "");
          throw new Error(`S3 upload failed: HTTP ${s3Res.status} — ${text.slice(0, 300)}`);
        }

        const s3Key = policy.params.key ?? "(unknown)";
        return {
          uploaded: true,
          file_name: fileName,
          s3_key: s3Key,
          size_bytes: fileData.byteLength,
        };
      }),
  });
}
