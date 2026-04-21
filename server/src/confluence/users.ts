// Confluence users — all tools use v1 CQL search.
//
// The /rest/api/user/* and /api/v2/users/* direct-lookup endpoints reject
// both granular `read:user:confluence` and classic `read:confluence-user`
// on scoped API tokens in our testing (April 2026). The only working path
// for user data on a scoped token is CQL search via /rest/api/search,
// which requires `search:confluence` classic scope.
//
// CQL happily supports `user = currentUser()` for whoami and
// `user.accountid = "..."` for id lookup, and returns the exact same user
// fields (accountId, email, publicName, profilePicture) that the direct
// endpoints would have returned. So we standardize on CQL for all three
// tools — no scope fragmentation, no endpoint drift.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV1 } from "../common/confluenceClient.js";
import { safeConfluence, toUserProjection } from "./_helpers.js";

interface CqlUserResult {
  results?: Array<{ user?: unknown }>;
}

async function cqlSingleUser(cql: string): Promise<unknown | null> {
  const res = await confluenceV1().get<CqlUserResult>("/search", {
    cql,
    limit: 1,
  });
  return res.results?.[0]?.user ?? null;
}

export function registerUserTools(server: FastMCP): void {
  // ---------------- Whoami (v1 CQL, currentUser() sentinel) ----------------

  server.addTool({
    name: "confluence_get_current_user",
    description:
      "Get the currently authenticated user — a real whoami that returns {accountId, displayName, email}. Useful for 'assign to me' flows and for verifying the configured token. Uses v1 CQL `user = currentUser()`; requires `search:confluence` classic scope.",
    parameters: z.object({}),
    execute: async () =>
      safeConfluence(async () => {
        const user = await cqlSingleUser("type = user AND user = currentUser()");
        if (!user) {
          throw new Error(
            "CQL currentUser() returned no results — token may not be authenticated.",
          );
        }
        return toUserProjection(user);
      }),
  });

  // ---------------- Get user by accountId (v1 CQL) ----------------

  server.addTool({
    name: "confluence_get_user",
    description:
      "Get a Confluence user by accountId. Returns a UserProjection, or throws if not found. Uses v1 CQL `user.accountid = \"...\"`; requires `search:confluence` classic scope.",
    parameters: z.object({
      account_id: z.string().describe("Atlassian accountId (e.g. '712020:abc-...')"),
    }),
    execute: async (args: { account_id: string }) =>
      safeConfluence(async () => {
        // accountId format is colon-segmented; quoting in CQL is enough —
        // but guard against injection attempts with stray quotes anyway.
        const escaped = args.account_id.replace(/"/g, '\\"');
        const user = await cqlSingleUser(
          `type = user AND user.accountid = "${escaped}"`,
        );
        if (!user) {
          throw new Error(`No user found with accountId ${args.account_id}`);
        }
        return toUserProjection(user);
      }),
  });

  // ---------------- Search users by name (v1 CQL) ----------------

  server.addTool({
    name: "confluence_search_user",
    description:
      "Search Confluence users by display-name substring via v1 CQL. Results are search entries with each user nested at `results[i].user`. Email search is NOT supported via CQL — only `user.fullname` accepts the `~` operator. For exact accountId lookup, use confluence_get_user. Requires `search:confluence` classic scope.",
    parameters: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute: async (args: { query: string; limit: number }) =>
      safeConfluence(() => {
        const q = args.query.replace(/"/g, '\\"');
        const cql = `type = user AND user.fullname ~ "${q}"`;
        return confluenceV1().get("/search", { cql, limit: args.limit });
      }),
  });
}
