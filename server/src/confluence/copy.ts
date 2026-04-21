// Confluence page copy — v1. v2 has no copy endpoint.
//
// Two variants:
//   - copy_page       → single-page copy, returns new page id synchronously
//   - copy_page_hierarchy_start → kicks off a long-running task (202 Accepted
//                                  with a task id), which we poll via
//                                  copy_page_hierarchy_status.
//
// The hierarchy copy is split into start/status so the MCP server isn't
// held open on polling — the calling agent orchestrates the wait.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV1 } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable } from "./_helpers.js";

export interface CopyOpts {
  readOnly: boolean;
}

export function registerCopyTools(server: FastMCP, opts: CopyOpts): void {
  // ---------------- Single-page copy (sync) ----------------

  server.addTool({
    name: "confluence_copy_page",
    description:
      "Copy a single Confluence page to a new parent (or a different space). Synchronous — returns the new page id. v1-backed. Requires `write:confluence-content`.",
    parameters: z.object({
      source_page_id: z.string(),
      destination_parent_id: z
        .string()
        .describe("Page id under which the copy should be placed"),
      destination_space_key: z
        .string()
        .optional()
        .describe("If moving across spaces, the destination space key; default is the source's space"),
      new_title: z.string().optional().describe("Override the copy's title"),
      copy_attachments: z.boolean().default(true),
      copy_permissions: z.boolean().default(false),
      copy_labels: z.boolean().default(true),
      copy_properties: z.boolean().default(false),
    }),
    execute: async (args: {
      source_page_id: string;
      destination_parent_id: string;
      destination_space_key?: string;
      new_title?: string;
      copy_attachments: boolean;
      copy_permissions: boolean;
      copy_labels: boolean;
      copy_properties: boolean;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const payload: Record<string, unknown> = {
          copyAttachments: args.copy_attachments,
          copyPermissions: args.copy_permissions,
          copyLabels: args.copy_labels,
          copyProperties: args.copy_properties,
          destination: {
            type: "parent_page",
            value: args.destination_parent_id,
          },
        };
        if (args.new_title) payload.pageTitle = args.new_title;
        if (args.destination_space_key) {
          (payload.destination as Record<string, unknown>).spaceKey = args.destination_space_key;
        }
        return confluenceV1().post<unknown>(
          `/content/${encodeURIComponent(args.source_page_id)}/copy`,
          payload,
        );
      }),
  });

  // ---------------- Hierarchy copy (async — start) ----------------

  server.addTool({
    name: "confluence_copy_page_hierarchy_start",
    description:
      "Start copying a Confluence page AND all its descendants. Returns a long-task id. Poll status with confluence_copy_page_hierarchy_status until `successful: true`. v1-backed.",
    parameters: z.object({
      source_page_id: z.string(),
      destination_parent_id: z.string(),
      destination_space_key: z.string().optional(),
      copy_attachments: z.boolean().default(true),
      copy_permissions: z.boolean().default(false),
      copy_labels: z.boolean().default(true),
      copy_properties: z.boolean().default(false),
      title_options_prefix: z
        .string()
        .optional()
        .describe("Prefix to prepend to every copied page's title (e.g. 'COPY - ')"),
    }),
    execute: async (args: {
      source_page_id: string;
      destination_parent_id: string;
      destination_space_key?: string;
      copy_attachments: boolean;
      copy_permissions: boolean;
      copy_labels: boolean;
      copy_properties: boolean;
      title_options_prefix?: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const payload: Record<string, unknown> = {
          copyAttachments: args.copy_attachments,
          copyPermissions: args.copy_permissions,
          copyLabels: args.copy_labels,
          copyProperties: args.copy_properties,
          destinationPageId: args.destination_parent_id,
        };
        if (args.destination_space_key) {
          payload.destinationSpaceKey = args.destination_space_key;
        }
        if (args.title_options_prefix) {
          payload.titleOptions = { prefix: args.title_options_prefix };
        }
        return confluenceV1().post<unknown>(
          `/content/${encodeURIComponent(args.source_page_id)}/pagehierarchy/copy`,
          payload,
        );
      }),
  });

  // ---------------- Hierarchy copy (async — poll) ----------------

  server.addTool({
    name: "confluence_copy_page_hierarchy_status",
    description:
      "Poll a long-running hierarchy-copy task started by confluence_copy_page_hierarchy_start. Returns Atlassian's longtask shape — `successful: true` when done; `percentageComplete` for progress.",
    parameters: z.object({
      task_id: z.string().describe("Task id returned by the _start call"),
    }),
    execute: async (args: { task_id: string }) =>
      safeConfluence(() =>
        confluenceV1().get<unknown>(`/longtask/${encodeURIComponent(args.task_id)}`),
      ),
  });
}
