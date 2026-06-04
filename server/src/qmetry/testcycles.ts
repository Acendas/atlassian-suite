import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";
import { jiraIsConfigured, jiraClient } from "../common/jiraClient.js";

export function registerQMetryTestCycleTools(server: FastMCP, opts: { readOnly: boolean }): void {
  server.addTool({
    name: "qmetry_search_test_cycles",
    description: "Search test cycles in a QMetry project. Returns cycle id, key, name, status, and dates.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID (equals the Jira project ID for the same project)"),
      search_text: z.string().optional().describe("Free-text search on cycle name/summary"),
      status: z.array(z.string()).optional(),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const filter: Record<string, unknown> = { projectId: args.project_id };
        if (args.search_text) filter.searchText = args.search_text;
        if (args.status?.length) filter.status = args.status;
        return qmetryClient().post<unknown>(
          "/testcycles/search",
          { filter },
          { startAt: args.start_at, maxResults: args.max_results },
        );
      }),
  });

  server.addTool({
    name: "qmetry_get_test_cycle",
    description:
      "Get details for a single test cycle by its ID, including linked test cases and execution summary. " +
      "Automatically includes Jira project context when Jira is configured — " +
      "QMetry project ID equals Jira project ID.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Test cycle ID from qmetry_search_test_cycles results"),
    }),
    execute: async (args) =>
      safeQMetry(async () => {
        const cycle: any = await qmetryClient().get<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}`,
        );

        // Jira context: QMetry project ID = Jira project ID — fetch project details.
        if (cycle && cycle.projectId && jiraIsConfigured()) {
          try {
            const project: any = await jiraClient().projects.getProject({
              projectIdOrKey: String(cycle.projectId),
            } as never);
            cycle.jira = {
              project_key: project.key,
              project_name: project.name,
              project_id: project.id,
            };
          } catch {
            // Jira lookup is best-effort — never block the QMetry response.
          }
        }

        return cycle;
      }),
  });

  server.addTool({
    name: "qmetry_create_test_cycle",
    description: "Create a new test cycle in a QMetry project (e.g. for a new release regression run).",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      summary: z.string().describe("Test cycle name / summary"),
      description: z.string().optional(),
      status: z.string().optional().describe("Initial status, e.g. 'Not Started'"),
      start_date: z.string().optional().describe("ISO 8601 date, e.g. 2026-07-01"),
      end_date: z.string().optional().describe("ISO 8601 date"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = {
          projectId: args.project_id,
          summary: args.summary,
        };
        if (args.description) body.description = args.description;
        if (args.status) body.status = { name: args.status };
        if (args.start_date) body.startDate = args.start_date;
        if (args.end_date) body.endDate = args.end_date;
        return qmetryClient().post<unknown>("/testcycles", body);
      }),
  });

  server.addTool({
    name: "qmetry_update_test_cycle",
    description: "Update an existing test cycle's summary, status, or dates.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Test cycle ID from search results"),
      summary: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
      start_date: z.string().optional().describe("ISO 8601 date"),
      end_date: z.string().optional().describe("ISO 8601 date"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = {};
        if (args.summary) body.summary = args.summary;
        if (args.description) body.description = args.description;
        if (args.status) body.status = { name: args.status };
        if (args.start_date) body.startDate = args.start_date;
        if (args.end_date) body.endDate = args.end_date;
        return qmetryClient().put<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}`,
          body,
        );
      }),
  });

  server.addTool({
    name: "qmetry_get_test_cycle_test_cases",
    description: "List the test cases assigned to a specific test cycle, including their execution status within that cycle.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Test cycle ID"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcases`,
          { startAt: args.start_at, maxResults: args.max_results },
        ),
      ),
  });

  server.addTool({
    name: "qmetry_add_test_cases_to_cycle",
    description: "Add one or more test cases to a test cycle by their IDs.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Test cycle ID"),
      test_case_ids: z.array(z.string()).min(1).describe("Internal QMetry test case IDs (opaque id strings, not keys)"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        return qmetryClient().post<unknown>(
          `/testcycles/${encodeURIComponent(args.test_cycle_id)}/testcases`,
          { testcases: args.test_case_ids.map((id) => ({ id })) },
        );
      }),
  });
}
