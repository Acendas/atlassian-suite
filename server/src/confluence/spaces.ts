// Confluence spaces + user search.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceClient } from "../common/confluenceClient.js";
import { safeConfluence } from "./_helpers.js";

export function registerSpaceTools(server: FastMCP): void {
  server.addTool({
    name: "getConfluenceSpaces",
    description: "List Confluence spaces visible to the authenticated user.",
    parameters: z.object({
      type: z.enum(["global", "personal"]).optional(),
      limit: z.number().int().min(1).max(250).default(50),
    }),
    execute: async (args: { type?: "global" | "personal"; limit: number }) =>
      safeConfluence(() =>
        confluenceClient().space.getSpaces({
          type: args.type,
          limit: args.limit,
        } as never),
      ),
  });

  server.addTool({
    name: "confluence_search_user",
    description: "Search Confluence users by query (email or display name).",
    parameters: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute: async (args: { query: string; limit: number }) =>
      safeConfluence(() =>
        confluenceClient().search.searchUser({
          cql: `user.fullname ~ "${args.query}" OR user ~ "${args.query}"`,
          limit: args.limit,
        } as never),
      ),
  });
}
