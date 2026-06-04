import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry } from "./_helpers.js";

export function registerQMetryTestPlanTools(server: FastMCP): void {
  server.addTool({
    name: "qmetry_search_test_plans",
    description: "Search test plans in a QMetry project.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      search_text: z.string().optional(),
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
          "/testplans/search",
          { filter },
          { startAt: args.start_at, maxResults: args.max_results },
        );
      }),
  });

  server.addTool({
    name: "qmetry_get_test_plan",
    description: "Get details for a single test plan by ID, including linked test cycles.",
    parameters: z.object({
      test_plan_id: z.string().describe("Test plan ID from search results"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().post<unknown>(`/testplans/${encodeURIComponent(args.test_plan_id)}`, {}),
      ),
  });
}
