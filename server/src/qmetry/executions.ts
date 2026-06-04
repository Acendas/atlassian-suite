import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";

// Execution statuses QMetry supports.
const EXECUTION_STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT RUN", "IN PROGRESS"] as const;

export function registerQMetryExecutionTools(server: FastMCP, opts: { readOnly: boolean }): void {
  server.addTool({
    name: "qmetry_search_executions",
    description: "Search test case executions (runs) within a test cycle. Returns each test case's execution status and last-run details.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      test_cycle_id: z.string().optional().describe("Restrict to a specific test cycle ID"),
      test_case_key: z.string().optional().describe("Restrict to a specific test case key, e.g. PROJ-TC-5"),
      status: z.array(z.string()).optional().describe("Filter by execution status, e.g. ['PASS', 'FAIL']"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const filter: Record<string, unknown> = { projectId: args.project_id };
        if (args.test_cycle_id) filter.testCycleId = args.test_cycle_id;
        if (args.test_case_key) filter.testCaseKey = args.test_case_key;
        if (args.status?.length) filter.status = args.status;
        return qmetryClient().post<unknown>(
          "/testcaseruns/search",
          { filter },
          { startAt: args.start_at, maxResults: args.max_results },
        );
      }),
  });

  server.addTool({
    name: "qmetry_update_execution",
    description: "Update the execution status of a test case run (pass, fail, blocked, etc.).",
    parameters: z.object({
      execution_id: z.string().describe("Execution / test-case-run ID from qmetry_search_executions"),
      status: z.enum(EXECUTION_STATUSES).describe("New execution status"),
      comment: z.string().optional().describe("Optional comment / notes for this execution result"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = {
          status: { name: args.status },
        };
        if (args.comment) body.comment = args.comment;
        return qmetryClient().put<unknown>(
          `/testcaseruns/${encodeURIComponent(args.execution_id)}`,
          body,
        );
      }),
  });
}
