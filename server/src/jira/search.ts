// Jira search + field discovery tools.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { jiraClient, jiraProjectsFilter } from "../common/jiraClient.js";
import { safeJira } from "./_helpers.js";
import { scopeJql, BACKLOG_FIELDS } from "./_backlog.js";

export function registerSearchTools(server: FastMCP): void {
  server.addTool({
    name: "jira_search",
    description:
      "Search Jira issues using JQL. Honors JIRA_PROJECTS_FILTER if set (auto-prepends `project in (...)`, " +
      "keeping any ORDER BY last). Pages by token: pass the result's `nextPageToken` back as next_page_token " +
      "until `isLast` is true — a single call never returns more than max_results issues.",
    parameters: z.object({
      jql: z.string().describe("Jira Query Language expression"),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Fields to return; default summary,status,assignee,priority,issuetype,parent,fixVersions,labels,updated. " +
            "Story points are a site-specific custom field — get its id from jira_get_board_configuration.",
        ),
      max_results: z.number().int().min(1).max(100).default(25),
      next_page_token: z
        .string()
        .optional()
        .describe("`nextPageToken` from the previous page's result; omit for the first page"),
      expand: z.array(z.string()).optional(),
    }),
    execute: async (args: {
      jql: string;
      fields?: string[];
      max_results: number;
      next_page_token?: string;
      expand?: string[];
    }) =>
      safeJira(() =>
        jiraClient().issueSearch.searchForIssuesUsingJqlEnhancedSearch({
          jql: scopeJql(args.jql, jiraProjectsFilter()),
          maxResults: args.max_results,
          nextPageToken: args.next_page_token,
          fields: args.fields ?? BACKLOG_FIELDS,
          expand: args.expand?.join(",") as never,
        } as never),
      ),
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
