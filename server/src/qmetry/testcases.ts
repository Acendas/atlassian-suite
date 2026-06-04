import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";
import { jiraIsConfigured, jiraClient } from "../common/jiraClient.js";

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
    description:
      "Get full details for a single test case by key, including the step grid (action/expected-result rows), " +
      "status, priority, description, and linked items. " +
      "Steps are fetched automatically from the testcases/{id}/versions/{v}/teststeps/search sub-resource. " +
      "Automatically includes Jira project context when Jira is configured.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID (equals the Jira project ID)"),
      key: z.string().describe("Test case key, e.g. PROJ-TC-5"),
    }),
    execute: async (args) =>
      safeQMetry(async () => {
        const result: any = await qmetryClient().post<unknown>(
          "/testcases/search",
          { filter: { projectId: args.project_id, key: args.key } },
          { fields: "summary,status,priority,description,labels,version" },
        );

        // Fetch test steps from the separate sub-resource.
        // Read endpoint: POST /testcases/{id}/versions/{no}/teststeps/search
        const tc = result?.data?.[0] ?? result;
        const tcId = tc?.id;
        const versionNo = tc?.version?.versionNo ?? 1;
        if (tcId) {
          try {
            const steps = await qmetryClient().post<unknown>(
              `/testcases/${encodeURIComponent(tcId)}/versions/${versionNo}/teststeps/search`,
              {},
              { startAt: 0, maxResults: 100 },
            );
            tc.steps = steps;
          } catch {
            // Steps fetch is best-effort — never block the main response.
            tc.steps = null;
          }
        }

        // Jira context: QMetry project ID = Jira project ID — fetch project details.
        if (jiraIsConfigured()) {
          try {
            const project: any = await jiraClient().projects.getProject({
              projectIdOrKey: String(args.project_id),
            } as never);
            if (result && typeof result === "object") {
              (result as any).jira = {
                project_key: project.key,
                project_name: project.name,
                project_id: project.id,
              };
            }
          } catch {
            // Jira lookup is best-effort — never block the QMetry response.
          }
        }

        return result;
      }),
  });

  server.addTool({
    name: "qmetry_get_test_case_steps",
    description:
      "Get the step grid (action + expected-result rows) for a specific test case version. " +
      "Use qmetry_get_test_case instead for a combined view; call this directly when you already have the internal test case ID and version number.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID (opaque string from search results, e.g. the 'id' field — not the human-readable key)"),
      version: z.number().int().min(1).default(1).describe("Version number. Use 1 for the latest/only version unless you need a specific historical version."),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().post<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/versions/${args.version}/teststeps/search`,
          {},
          { startAt: 0, maxResults: 100 },
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
    description: "Update fields on an existing test case version (status, priority, summary, description).",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID (opaque string, not the human-readable key)"),
      version: z.number().int().min(1).default(1).describe("Version number to update. Use 1 for the latest version."),
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
        // Correct endpoint: PUT /testcases/{id}/versions/{no}
        return qmetryClient().put<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/versions/${args.version}`,
          body,
        );
      }),
  });

  // ---------- Test case versions ----------

  server.addTool({
    name: "qmetry_list_test_case_versions",
    description: "Get the test case detail by its internal ID, including version information. Use this when you have the opaque ID (not the human-readable key) and need version numbers before fetching steps.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID (opaque string)"),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        // GET /testcases/{id} returns the test case including version info.
        // Note: POST /testcases/{id}/versions creates a new version — not used here.
        qmetryClient().get<unknown>(`/testcases/${encodeURIComponent(args.test_case_id)}`),
      ),
  });

  // ---------- Test step CRUD ----------

  server.addTool({
    name: "qmetry_create_test_step",
    description: "Add a new step to a test case version. Steps have an action (what to do) and an expected result.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID"),
      version: z.number().int().min(1).default(1),
      step: z.string().describe("Step action — what the tester should do"),
      expected_result: z.string().optional().describe("Expected outcome for this step"),
      test_data: z.string().optional().describe("Optional test data or preconditions for this step"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = { step: args.step };
        if (args.expected_result) body.expectedResult = args.expected_result;
        if (args.test_data) body.testData = args.test_data;
        // POST /testcases/{id}/versions/{no}/teststeps creates one or more steps
        return qmetryClient().post<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/versions/${args.version}/teststeps`,
          body,
        );
      }),
  });

  server.addTool({
    name: "qmetry_update_test_step",
    description: "Update an existing test step's action, expected result, or test data. The step ID must come from qmetry_get_test_case_steps results.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID"),
      version: z.number().int().min(1).default(1),
      step_id: z.number().int().describe("Numeric test step ID from qmetry_get_test_case_steps results (the 'id' field)"),
      step: z.string().optional().describe("Updated step action"),
      expected_result: z.string().optional(),
      test_data: z.string().optional(),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        // PUT /testcases/{id}/versions/{no}/teststeps updates steps; pass id in body
        const body: Record<string, unknown> = { id: args.step_id };
        if (args.step) body.step = args.step;
        if (args.expected_result !== undefined) body.expectedResult = args.expected_result;
        if (args.test_data !== undefined) body.testData = args.test_data;
        return qmetryClient().put<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/versions/${args.version}/teststeps`,
          body,
        );
      }),
  });

  server.addTool({
    name: "qmetry_delete_test_step",
    description: "Delete a test step from a test case version.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID"),
      version: z.number().int().min(1).default(1),
      step_id: z.number().int().describe("Numeric test step ID from qmetry_get_test_case_steps results"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        // DELETE /testcases/{id}/versions/{no}/teststeps; pass id in body
        return qmetryClient().delete<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/versions/${args.version}/teststeps`,
          { id: args.step_id } as any,
        );
      }),
  });

  // ---------- Requirements / Jira traceability ----------

  server.addTool({
    name: "qmetry_get_test_case_requirements",
    description:
      "Get the Jira issues (requirements) linked to a test case for traceability. " +
      "This is the authoritative QMetry API for the 'Directly Linked to Stories' relationship.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() =>
        qmetryClient().get<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/requirements`,
          { startAt: args.start_at, maxResults: args.max_results },
        ),
      ),
  });

  server.addTool({
    name: "qmetry_link_requirement",
    description:
      "Link a test case version to a Jira issue (requirement) for traceability. " +
      "Creates the 'Directly Linked to Stories' relationship visible in Jira's QMetry panel.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID"),
      version: z.number().int().min(1).default(1).describe("Test case version number (default 1)"),
      jira_issue_key: z.string().describe("Jira issue key, e.g. PROJ-123"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        // POST /testcases/{id}/version/{no}/requirements/link  (singular 'version')
        return qmetryClient().post<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/version/${args.version}/requirements/link`,
          { issueKey: args.jira_issue_key },
        );
      }),
  });

  server.addTool({
    name: "qmetry_unlink_requirement",
    description: "Remove the traceability link between a test case version and a Jira issue.",
    parameters: z.object({
      test_case_id: z.string().describe("Internal QMetry test case ID"),
      version: z.number().int().min(1).default(1),
      requirement_id: z.string().describe("Requirement ID from qmetry_get_test_case_requirements"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        // POST /testcases/{id}/versions/{no}/requirements/unlink  (plural 'versions')
        return qmetryClient().post<unknown>(
          `/testcases/${encodeURIComponent(args.test_case_id)}/versions/${args.version}/requirements/unlink`,
          { id: args.requirement_id },
        );
      }),
  });
}
