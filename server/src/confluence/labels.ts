// Confluence labels — v2 list, v1 write.
//
// v2's label API is read-only (`GET /pages/{id}/labels`). Adding and
// removing labels still go through v1 endpoints. Attachments moved out
// to attachments.ts.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV1, confluenceV2 } from "../common/confluenceClient.js";
import {
  safeConfluence,
  ensureWritable,
  toLabelProjection,
  extractNextCursor,
  type PagedResponse,
} from "./_helpers.js";

export interface LabelOpts {
  readOnly: boolean;
}

export function registerLabelTools(server: FastMCP, opts: LabelOpts): void {
  // ---------------- List (v2) ----------------

  server.addTool({
    name: "confluence_get_labels",
    description:
      "List labels on a Confluence page. Returns LabelProjection[] ({id, name, prefix}).",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(250),
      cursor: z.string().optional(),
    }),
    execute: async (args: { page_id: string; limit: number; cursor?: string }) =>
      safeConfluence(async () => {
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/labels`,
          { limit: args.limit, cursor: args.cursor },
        );
        return {
          labels: (res.results ?? []).map(toLabelProjection),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // ---------------- Add (v1) ----------------

  server.addTool({
    name: "confluence_add_label",
    description:
      "Add one or more labels to a Confluence page. v1-backed (v2 labels are read-only). Requires `write:confluence-content`.",
    parameters: z.object({
      page_id: z.string(),
      labels: z.array(z.string()).min(1).describe("Label names (no leading '#')"),
      prefix: z.enum(["global", "my", "team"]).default("global"),
    }),
    execute: async (args: { page_id: string; labels: string[]; prefix: "global" | "my" | "team" }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const body = args.labels.map((name) => ({ prefix: args.prefix, name }));
        return confluenceV1().post<unknown>(
          `/content/${encodeURIComponent(args.page_id)}/label`,
          body,
        );
      }),
  });

  // ---------------- Remove (v1) ----------------

  server.addTool({
    name: "confluence_remove_label",
    description:
      "Remove a single label from a Confluence page. v1-backed (v2 labels are read-only). Requires `write:confluence-content`.",
    parameters: z.object({
      page_id: z.string(),
      name: z.string().describe("Label name to remove (no leading '#')"),
      prefix: z
        .enum(["global", "my", "team"])
        .optional()
        .describe("Label prefix — usually 'global'; omit to let Confluence pick"),
    }),
    execute: async (args: { page_id: string; name: string; prefix?: "global" | "my" | "team" }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const path = `/content/${encodeURIComponent(args.page_id)}/label/${encodeURIComponent(args.name)}`;
        const query = args.prefix ? { prefix: args.prefix } : undefined;
        await confluenceV1().delete<unknown>(path, query);
        return { removed: args.name, from_page: args.page_id };
      }),
  });
}
