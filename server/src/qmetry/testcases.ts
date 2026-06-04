import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";

const paginationParams = {
  start_at: z.number().int().min(0).default(0).describe("0-based page offset"),
  max_results: z.number().int().min(1).max(100).default(50).describe("Items per page, max 100"),
};

export function registerQMetryTestCaseTools(server: FastMCP, opts: { readOnly: boolean }): void {
  server.addTool({
    name: "qmetry_search_test_cases",
    description: "Search test cases in a QMetry project. Filter by key, summary text, status, priority, or folder. Returns lean objects by default; use fields param to expand.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID (from qmetry_list_projects)"),
      key: z.string().optional().describe("Exact test case key, e.g. PROJ-TC-5"),
      search_text: z.string().optional().describe("Free-text search across summary"),
      status: z.array(z.string()).optional().describe("Filter by status names, e.g. ['To Do', 'In Progress']"),
      priority: z.array(z.string()).optional().describe("Filter by priority names, e.g. ['High', 'Medium']"),
      labels: z.array(z.string()).optional().describe("Filter by label names"),
      folder_id: z.number().int().optional().describe("Filter by folder ID"),
      fields: z.string().optional().describe("Comma-separated extra fields, e.g. 'summary,status,priority'"),
      sort: z.string().optional().describe("Sort expression, e.g. 'key:desc'"),
      ...paginationParams,
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const filter: Record<string, unknown> = { projectId: args.project_id };
        if (args.key) filter.key = args.key;
        if (args.search_text) filter.searchText = args.search_text;
        if (args.status?.length) filter.status = args.status;
        if (args.priority?.length) filter.priority = args.priority;
        if (args.labels?.length) filter.labels = args.labels;
        if (args.folder_id) filter.folderId = args.folder_id;
        return qmetryClient().post<unknown>(
          "/testcases/search",
          { filter },
          {
            startAt: args.start_at,
            maxResults: args.max_results,
            ...(args.fields ? { fields: args.fields } : {}),
            ...(args.sort ? { sort: args.sort } : {}),
          },
        );
      }),
  });

  server.addTool({
    name: "qmetry_get_test_case",
    description: "Get full details for a single test case by key, including steps, status, priority, description, and linked items.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      key: z.string().describe("Test case key, e.g. PROJ-TC-5"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().post<unknown>(
          "/testcases/search",
          { filter: { projectId: args.project_id, key: args.key } },
          { fields: "summary,status,priority,description,steps,labels,folderId,version" },
        ),
      ),
  });

  server.addTool({
    name: "qmetry_create_test_case",
    description: "Create a new test case in a QMetry project.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      summary: z.string().describe("Test case title / summary"),
      status: z.string().optional().describe("Status name, e.g. 'To Do'"),
      priority: z.string().optional().describe("Priority name, e.g. 'Medium'"),
      description: z.string().optional(),
      labels: z.array(z.string()).optional(),
      folder_id: z.number().int().optional(),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = {
          projectId: args.project_id,
          summary: args.summary,
        };
        if (args.status) body.status = { name: args.status };
        if (args.priority) body.priority = { name: args.priority };
        if (args.description) body.description = args.description;
        if (args.labels?.length) body.labels = args.labels;
        if (args.folder_id) body.folderId = args.folder_id;
        return qmetryClient().post<unknown>("/testcases", body);
      }),
  });

  server.addTool({
    name: "qmetry_update_test_case",
    description: "Update fields on an existing test case (status, priority, summary, description).",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID (the opaque id string, not the human-readable key)"),
      summary: z.string().optional(),
      status: z.string().optional().describe("New status name"),
      priority: z.string().optional().describe("New priority name"),
      description: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = {};
        if (args.summary) body.summary = args.summary;
        if (args.status) body.status = { name: args.status };
        if (args.priority) body.priority = { name: args.priority };
        if (args.description) body.description = args.description;
        if (args.labels) body.labels = args.labels;
        return qmetryClient().put<unknown>(`/testcases/${encodeURIComponent(args.test_case_id)}`, body);
      }),
  });
}
