// Confluence watchers — v1 (v2 has no watch endpoint).
//
// Watching a page subscribes the user to notifications when the page
// changes. This is a developer staple — watch runbooks, watch API docs
// that match your code, watch a team's decision log.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV1 } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable } from "./_helpers.js";

export interface WatcherOpts {
  readOnly: boolean;
}

export function registerWatcherTools(server: FastMCP, opts: WatcherOpts): void {
  server.addTool({
    name: "confluence_watch_page",
    description:
      "Watch a Confluence page (subscribe to change notifications) as the authenticated user. v1-backed — v2 has no watchers endpoint. Requires `write:confluence-content`.",
    parameters: z.object({ page_id: z.string() }),
    execute: async (args: { page_id: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        // v1 endpoint: PUT /user/watch/content/{id} (no body)
        await confluenceV1().put<unknown>(
          `/user/watch/content/${encodeURIComponent(args.page_id)}`,
        );
        return { watching: args.page_id };
      }),
  });

  server.addTool({
    name: "confluence_unwatch_page",
    description: "Stop watching a Confluence page.",
    parameters: z.object({ page_id: z.string() }),
    execute: async (args: { page_id: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        await confluenceV1().delete<unknown>(
          `/user/watch/content/${encodeURIComponent(args.page_id)}`,
        );
        return { unwatched: args.page_id };
      }),
  });

  server.addTool({
    name: "confluence_watch_space",
    description:
      "Watch a Confluence space — subscribe to notifications on any page change in the space. v1-backed.",
    parameters: z.object({
      space_key: z.string().describe("Space key (not id)"),
    }),
    execute: async (args: { space_key: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        await confluenceV1().put<unknown>(
          `/user/watch/space/${encodeURIComponent(args.space_key)}`,
        );
        return { watching_space: args.space_key };
      }),
  });

  server.addTool({
    name: "confluence_unwatch_space",
    description: "Stop watching a Confluence space.",
    parameters: z.object({ space_key: z.string() }),
    execute: async (args: { space_key: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        await confluenceV1().delete<unknown>(
          `/user/watch/space/${encodeURIComponent(args.space_key)}`,
        );
        return { unwatched_space: args.space_key };
      }),
  });
}
