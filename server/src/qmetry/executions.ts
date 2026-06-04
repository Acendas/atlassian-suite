import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";

// Execution statuses QMetry supports.
const EXECUTION_STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT RUN", "IN PROGRESS"] as const;

export function registerQMetryExecutionTools(server: FastMCP, opts: { readOnly: boolean }): void {
  server.addTool({
    name: "qmetry_search_executions",
    description:
      "List execution results for a QMetry project. " +
      "Returns test case execution history across all cycles in the project. " +
      "Uses GET /projects/{projectId}/execution-results.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(
          `/projects/${args.project_id}/execution-results`,
          { startAt: args.start_at, maxResults: args.max_results },
        ),
      ),
  });

  server.addTool({
    name: "qmetry_get_execution",
    description:
      "Get details of a single test case execution result within a test cycle. " +
      "Requires both the test cycle ID and the execution ID. " +
      "Execution IDs come from qmetry_get_test_cycle_test_cases results.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID"),
      execution_id: z.string().describe("Test case execution ID from qmetry_get_test_cycle_test_cases results"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        // GET /testcycles/{id}/testcases/{testCycleTestCaseMapId}/executions
        qmetryClient().get<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcases/${encodeURIComponent(args.execution_id)}/executions`,
        ),
      ),
  });

  server.addTool({
    name: "qmetry_update_execution",
    description:
      "Update the execution status of a test case within a test cycle (pass, fail, blocked, etc.). " +
      "Requires both the test cycle ID and the test case execution ID.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Internal QMetry test cycle ID (from qmetry_search_test_cycles or qmetry_get_test_cycle)"),
      execution_id: z.string().describe("Test case execution ID from qmetry_get_test_cycle_test_cases results"),
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
        // PUT /testcycles/{id}/testcase-executions/{testCaseExecutionId}
        return qmetryClient().put<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcase-executions/${encodeURIComponent(args.execution_id)}`,
          body,
        );
      }),
  });
}
