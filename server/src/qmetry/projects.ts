import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { qmetryClient } from "../common/qmetryClient.js";
import { safeQMetry } from "./_helpers.js";

export function registerQMetryProjectTools(server: FastMCP): void {
  server.addTool({
    name: "qmetry_list_projects",
    description: "List all QMetry-enabled projects. Returns project id, key, name, and favorite flag. The numeric id is required by every other QMetry endpoint.",
    parameters: z.object({}),
    execute: async () =>
      safeQMetry(() =>
        qmetryClient().post<unknown>("/projects", {}),
      ),
  });
}
