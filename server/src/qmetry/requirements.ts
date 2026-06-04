import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry } from "./_helpers.js";

export function registerQMetryRequirementTools(server: FastMCP): void {
  server.addTool({
    name: "qmetry_search_requirements",
    description:
      "Search QMetry requirements (Jira issue traceability links) across a project. " +
      "Returns Jira issues that have test cases linked to them. " +
      "Use this to find which stories/tasks have test coverage and which don't.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      search_text: z.string().optional().describe("Free-text search on requirement summary"),
      jira_issue_key: z.string().optional().describe("Filter by a specific Jira issue key, e.g. PROJ-123"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const filter: Record<string, unknown> = { projectId: args.project_id };
        if (args.search_text) filter.searchText = args.search_text;
        if (args.jira_issue_key) filter.issueKey = args.jira_issue_key;
        return qmetryClient().post<unknown>(
          "/requirements/search",
          { filter },
          { startAt: args.start_at, maxResults: args.max_results },
        );
      }),
  });
}
