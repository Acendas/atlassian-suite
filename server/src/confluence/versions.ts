// Confluence version restore — v1 (v2 has no restore endpoint).
//
// Version LIST and GET live in pages.ts (v2). Only the restore mutation
// is here, since that's a v1 fallback.
//
// v1 doesn't have a dedicated "restore" verb. The standard pattern is to
// fetch the body of the old version, then POST it as a new version via
// the regular update endpoint. This is what Atlassian's own UI does.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV1, confluenceV2 } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable, toPageProjection } from "./_helpers.js";

export interface VersionOpts {
  readOnly: boolean;
}

export function registerVersionTools(server: FastMCP, opts: VersionOpts): void {
  server.addTool({
    name: "confluence_restore_version",
    description:
      "Restore a Confluence page to a prior version. Fetches the historical body and writes it as a NEW version on top of current — the old versions remain in history. Requires `write:confluence-content` (classic) because the v2 restore endpoint does not exist.",
    parameters: z.object({
      page_id: z.string(),
      target_version: z
        .number()
        .int()
        .positive()
        .describe("Version to restore (from confluence_get_page_history)"),
      message: z
        .string()
        .optional()
        .describe("Optional version-commit message to record the reason for restoring"),
    }),
    execute: async (args: { page_id: string; target_version: number; message?: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);

        // 1. Fetch the target version's body (storage format) + title via v2.
        const historical = await confluenceV2().get<{
          title?: string;
          body?: { storage?: { value?: string } };
        }>(
          `/pages/${encodeURIComponent(args.page_id)}/versions/${args.target_version}`,
          { "body-format": "storage" },
        );
        const storage = historical.body?.storage?.value;
        if (typeof storage !== "string") {
          throw new Error(
            `Version ${args.target_version} has no retrievable storage body. ` +
              `(Atlassian sometimes omits body for very old versions.)`,
          );
        }

        // 2. Fetch the page's current version to know what to bump.
        const current = await confluenceV2().get<{
          title?: string;
          version?: { number?: number };
        }>(`/pages/${encodeURIComponent(args.page_id)}`);
        const currentVersion = current.version?.number ?? 1;
        const title = historical.title ?? current.title ?? "";

        // 3. Write the historical body back as current + 1.
        //    Done via v1 content.update — keeps this tool's scope
        //    requirement aligned with other write:confluence-content tools,
        //    and avoids v2 edge cases around body-format mixes during
        //    update.
        const raw = await confluenceV1().put<unknown>(
          `/content/${encodeURIComponent(args.page_id)}`,
          {
            id: args.page_id,
            type: "page",
            title,
            version: {
              number: currentVersion + 1,
              message:
                args.message ??
                `Restored from version ${args.target_version}`,
            },
            body: { storage: { value: storage, representation: "storage" } },
          },
        );
        return toPageProjection(raw);
      }),
  });
}
