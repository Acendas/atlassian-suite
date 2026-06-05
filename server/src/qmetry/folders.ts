import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry, ensureWritable } from "./_helpers.js";

export function registerQMetryFolderTools(server: FastMCP, opts: { readOnly: boolean }): void {
  server.addTool({
    name: "qmetry_search_folders",
    description:
      "Search test case folders in a QMetry project by name. " +
      "Folders organise test cases into suites — use the returned folder IDs to filter test case searches.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      folder_name: z.string().optional().describe("Folder name to search for"),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        const query: Record<string, string | number | boolean | null | undefined> = { projectId: args.project_id };
        if (args.folder_name) query.folderName = args.folder_name;
        // GET /projects/{projectId}/testcase-folders/search
        return qmetryClient().get<unknown>(
          `/projects/${args.project_id}/testcase-folders/search`,
          query,
        );
      }),
  });

  server.addTool({
    name: "qmetry_create_folder",
    description: "Create a new test case folder in a QMetry project for organising test cases.",
    parameters: z.object({
      project_id: z.number().int().describe("Numeric QMetry project ID"),
      name: z.string().describe("Folder name"),
      parent_id: z.number().int().optional().describe("Parent folder ID. QMetry requires a parent; for a top-level folder pass the project's root folder ID (from qmetry_search_folders)."),
    }),
    execute: async (args) =>
      safeQMetry(() => {
        ensureWritable(opts.readOnly);
        // FolderRequest field is `folderName` (not `name`). `parentId` is
        // required by the API; for a top-level folder pass the project's root
        // folder id (visible in qmetry_search_folders).
        const body: Record<string, unknown> = { folderName: args.name };
        if (args.parent_id != null) body.parentId = args.parent_id;
        // POST /projects/{projectId}/testcase-folders
        return qmetryClient().post<unknown>(`/projects/${args.project_id}/testcase-folders`, body);
      }),
  });
}
