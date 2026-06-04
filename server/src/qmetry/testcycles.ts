import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry } from "./_helpers.js";
import { jiraIsConfigured } from "../common/jiraClient.js";
import { jiraClient } from "../common/jiraClient.js";

export function registerQMetryTestCycleTools(server: FastMCP): void {
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
}
