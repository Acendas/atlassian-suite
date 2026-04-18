// Jira search + field discovery tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { jiraClient, jiraProjectsFilter } from "../common/jiraClient.js";
import { safeJira } from "./_helpers.js";

export function registerSearchTools(server: FastMCP): void {
  server.addTool({
    name: "jira_search",
    description:
      "Search Jira issues using JQL. Honors JIRA_PROJECTS_FILTER if set (auto-prepends `project in (...)`).",
    parameters: z.object({
      jql: z.string().describe("Jira Query Language expression"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Fields to return; default summary,status,assignee,priority,issuetype,updated"),
      max_results: z.number().int().min(1).max(100).default(25),
      start_at: z.number().int().min(0).default(0),
      expand: z.array(z.string()).optional(),
    }),
    execute: async (args: {
      jql: string;
      fields?: string[];
      max_results: number;
      start_at: number;
      expand?: string[];
    }) =>
      safeJira(() => {
        const filter = jiraProjectsFilter();
        const finalJql =
          filter && filter.length > 0
            ? `project in (${filter.map((p) => `"${p}"`).join(",")}) AND (${args.jql})`
            : args.jql;
        return jiraClient().issueSearch.searchForIssuesUsingJqlEnhancedSearch({
          jql: finalJql,
          maxResults: args.max_results,
          nextPageToken: undefined,
          fields: args.fields ?? [
            "summary",
            "status",
            "assignee",
            "priority",
            "issuetype",
            "updated",
          ],
          expand: args.expand?.join(",") as never,
        } as never);
      }),
  });

  server.addTool({
    name: "jira_search_fields",
    description: "List available Jira fields (system + custom). Use to discover custom field IDs.",
    parameters: z.object({}),
    execute: async () => safeJira(() => jiraClient().issueFields.getFields()),
  });

  server.addTool({
    name: "jira_get_field_options",
    description: "Get the allowed values for a custom field (where applicable).",
    parameters: z.object({
      field_id: z.string().describe("Custom field id, e.g. customfield_10100"),
    }),
    execute: async (args: { field_id: string }) =>
      safeJira(() =>
        jiraClient().issueCustomFieldOptions.getCustomFieldOption({
          id: args.field_id,
        } as never),
      ),
  });
}
