import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry } from "./_helpers.js";

export function registerQMetryRequirementTools(server: FastMCP): void {
  server.addTool({
    name: "qmetry_search_requirements",
    description:
      "Get test cases linked to a specific Jira requirement (issue). " +
      "In QMetry, 'requirements' are Jira issues — this returns all test cases that cover a given Jira issue key. " +
      "Uses POST /requirements/{id}/testcases where {id} is the Jira issue key.",
    parameters: z.object({
      jira_issue_key: z.string().describe("Jira issue key, e.g. PROJ-123. QMetry uses Jira issue keys as requirement IDs."),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().post<unknown>(
          `/requirements/${encodeURIComponent(args.jira_issue_key)}/testcases`,
          {},
          { startAt: args.start_at, maxResults: args.max_results },
        ),
      ),
  });
}
