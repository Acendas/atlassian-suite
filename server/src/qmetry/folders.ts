import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";

export function registerQMetryFolderTools(server: FastMCP, opts: { readOnly: boolean }): void {
  server.addTool({
    name: "qmetry_search_folders",
    description: "Search test case folders in a QMetry project. Folders organise test cases into suites — use folder IDs when filtering test case searches.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      search_text: z.string().optional().describe("Free-text search on folder name"),
      start_at: z.number().int().min(0).default(0),
      max_results: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const filter: Record<string, unknown> = {};
        if (args.search_text) filter.searchText = args.search_text;
        return qmetryClient().post<unknown>(
          `/projects/${args.project_id}/folders/search`,
          { filter },
          { startAt: args.start_at, maxResults: args.max_results },
        );
      }),
  });

  server.addTool({
    name: "qmetry_create_folder",
    description: "Create a new test case folder in a QMetry project for organising test cases.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      name: z.string().describe("Folder name"),
      parent_id: z.number().int().optional().describe("Parent folder ID for nesting. Omit for a top-level folder."),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        const body: Record<string, unknown> = { name: args.name };
        if (args.parent_id) body.parentId = args.parent_id;
        return qmetryClient().post<unknown>(`/projects/${args.project_id}/folders`, body);
      }),
  });
}
