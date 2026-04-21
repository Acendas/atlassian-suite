// Confluence spaces — v2 list + get.
//
// User search moved to users.ts; that endpoint path/scope is different.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV2 } from "../common/confluenceClient.js";
import {
  safeConfluence,
  toSpaceProjection,
  extractNextCursor,
  type PagedResponse,
} from "./_helpers.js";

export function registerSpaceTools(server: FastMCP): void {
  server.addTool({
    name: "getConfluenceSpaces",
    description:
      "List Confluence spaces visible to the authenticated user. Cursor-paginated. Returns SpaceProjection[] ({id, key, name, type, homepageId}). The numeric `id` is needed for v2 create-page calls.",
    parameters: z.object({
      type: z.enum(["global", "personal", "collaboration", "knowledge_base"]).optional(),
      status: z.enum(["current", "archived"]).optional(),
      limit: z.number().int().min(1).max(250).default(50),
      cursor: z.string().optional(),
    }),
    execute: async (args: {
      type?: "global" | "personal" | "collaboration" | "knowledge_base";
      status?: "current" | "archived";
      limit: number;
      cursor?: string;
    }) =>
      safeConfluence(async () => {
        const query: Record<string, string | number | undefined> = {
          limit: args.limit,
          cursor: args.cursor,
          type: args.type,
          status: args.status,
        };
        const res = await confluenceV2().get<PagedResponse<unknown>>("/spaces", query);
        return {
          spaces: (res.results ?? []).map(toSpaceProjection),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  server.addTool({
    name: "confluence_get_space",
    description:
      "Get a single Confluence space by id (or, if you only have a key, use getConfluenceSpaces to find the id first). Returns a SpaceProjection including homepageId — useful as the `root_page_id` input to confluence_get_space_page_tree.",
    parameters: z.object({
      space_id: z.string().describe("Numeric space id"),
    }),
    execute: async (args: { space_id: string }) =>
      safeConfluence(async () => {
        const raw = await confluenceV2().get<unknown>(
          `/spaces/${encodeURIComponent(args.space_id)}`,
        );
        return toSpaceProjection(raw);
      }),
  });
}
