// Confluence page likes — READ-ONLY.
//
// Atlassian's v2 API exposes read endpoints (`GET /pages/{id}/likes/users`
// and `GET /pages/{id}/likes/count`) but provides NO write endpoint for
// liking or unliking on scoped API tokens. Empirical testing (April 2026)
// confirmed: `POST /pages/{id}/likes`, `PUT /pages/{id}/likes`, and v1
// `POST /content/{id}/like` all return 404 HTML regardless of scope.
//
// Accordingly, `confluence_like_page` and `confluence_unlike_page` are NOT
// registered — they were in an earlier v0.3.0 draft but would throw 404 on
// every invocation. Only `confluence_get_page_likes` ships.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV2 } from "../common/confluenceClient.js";
import { safeConfluence } from "./_helpers.js";
import { extractNextCursor, type PagedResponse } from "./_helpers.js";

export interface LikeOpts {
  readOnly: boolean;
}

interface LikerEntry {
  accountId?: string;
  [key: string]: unknown;
}

export function registerLikeTools(server: FastMCP, _opts: LikeOpts): void {
  server.addTool({
    name: "confluence_get_page_likes",
    description:
      "List users who have liked a Confluence page. Returns `{ count, likers: [accountId...], nextCursor }`. Cursor-paginated. Requires `read:page:confluence`.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(50),
      cursor: z.string().optional(),
    }),
    execute: async (args: { page_id: string; limit: number; cursor?: string }) =>
      safeConfluence(async () => {
        const path = `/pages/${encodeURIComponent(args.page_id)}/likes/users`;
        const res = await confluenceV2().get<PagedResponse<LikerEntry>>(path, {
          limit: args.limit,
          cursor: args.cursor,
        });
        return {
          page_id: args.page_id,
          count: (res.results ?? []).length,
          likers: (res.results ?? [])
            .map((r) => r.accountId)
            .filter((v): v is string => Boolean(v)),
          nextCursor: extractNextCursor(res),
        };
      }),
  });
}
