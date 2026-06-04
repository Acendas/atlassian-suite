import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry } from "./_helpers.js";

export function registerQMetryTestCycleTools(server: FastMCP): void {
  server.addTool({
    name: "qmetry_search_test_cycles",
    description: "Search test cycles in a QMetry project. Returns cycle id, key, name, status, and dates.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
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
    description: "Get details for a single test cycle by its numeric ID, including linked test cases and execution summary.",
    parameters: z.object({
      test_cycle_id: z.string().describe("Test cycle ID (numeric string from search results)"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(`/testcycles/${encodeURIComponent(args.test_cycle_id)}`),
      ),
  });
}
