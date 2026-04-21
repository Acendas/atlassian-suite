// Confluence page properties — v2.
//
// Page properties are structured metadata attached to a page. Useful for
// machine-readable fields that shouldn't live in the page body:
//   - "last-reviewed-by" / "last-reviewed-at"
//   - "linked-jira-epic"
//   - "runbook-owner"
//   - "source-of-truth-sha"
//
// Keys are strings (≤255 chars); values are JSON (object/array/primitive).
// Properties are versioned — updating requires the current version number.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV2 } from "../common/confluenceClient.js";
import {
  safeConfluence,
  ensureWritable,
  extractNextCursor,
  type PagedResponse,
} from "./_helpers.js";

export interface PropertyOpts {
  readOnly: boolean;
}

interface PageProperty {
  id?: string;
  key?: string;
  value?: unknown;
  version?: { number?: number; createdAt?: string; authorId?: string };
}

function projectProperty(raw: unknown): PageProperty {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = (r.version && typeof r.version === "object") ? r.version as Record<string, unknown> : {};
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    key: typeof r.key === "string" ? r.key : undefined,
    value: r.value,
    version: {
      number: typeof v.number === "number" ? v.number : undefined,
      createdAt: typeof v.createdAt === "string" ? v.createdAt : undefined,
      authorId: typeof v.authorId === "string" ? v.authorId : undefined,
    },
  };
}

export function registerPropertyTools(
  server: FastMCP,
  opts: PropertyOpts,
): void {
  // ---------------- List all properties on a page ----------------

  server.addTool({
    name: "confluence_get_page_properties",
    description:
      "List all properties on a Confluence page (structured key/value metadata). Cursor-paginated. Use confluence_get_page_property to read a single key's value.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(250),
      cursor: z.string().optional(),
    }),
    execute: async (args: { page_id: string; limit: number; cursor?: string }) =>
      safeConfluence(async () => {
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/properties`,
          { limit: args.limit, cursor: args.cursor },
        );
        return {
          properties: (res.results ?? []).map(projectProperty),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // ---------------- Get one property by key ----------------

  server.addTool({
    name: "confluence_get_page_property",
    description:
      "Read a single page property by key. Returns `{key, value, version: {number}}` or null if the key doesn't exist on this page.",
    parameters: z.object({
      page_id: z.string(),
      key: z.string().describe("Property key (≤255 chars)"),
    }),
    execute: async (args: { page_id: string; key: string }) =>
      safeConfluence(async () => {
        // v2 doesn't expose GET /pages/{id}/properties/{key} directly with a
        // key; you list and filter. Fetching the full list of 250 is cheap.
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/properties`,
          { key: args.key, limit: 1 },
        );
        const first = res.results?.[0];
        return first ? projectProperty(first) : null;
      }),
  });

  // ---------------- Create or update property ----------------

  server.addTool({
    name: "confluence_set_page_property",
    description:
      "Upsert a page property. If the key doesn't exist, creates it. If it exists, updates — requires the current `version_number` (from confluence_get_page_property's version.number, + 1). Value can be any JSON (object/array/primitive).",
    parameters: z.object({
      page_id: z.string(),
      key: z.string().describe("Property key (≤255 chars)"),
      value: z.any().describe("JSON value — object, array, string, number, boolean"),
      version_number: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Required when UPDATING an existing property (current version + 1). Omit for CREATE.",
        ),
    }),
    execute: async (args: {
      page_id: string;
      key: string;
      value?: unknown;
      version_number?: number;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        if (args.version_number !== undefined) {
          // Update path — need the property id first.
          const existing = await confluenceV2().get<PagedResponse<PageProperty>>(
            `/pages/${encodeURIComponent(args.page_id)}/properties`,
            { key: args.key, limit: 1 },
          );
          const prop = existing.results?.[0];
          if (!prop?.id) {
            throw new Error(
              `Page property "${args.key}" not found on page ${args.page_id} — cannot update. Omit version_number to CREATE.`,
            );
          }
          const raw = await confluenceV2().put<unknown>(
            `/pages/${encodeURIComponent(args.page_id)}/properties/${encodeURIComponent(prop.id)}`,
            {
              key: args.key,
              value: args.value,
              version: { number: args.version_number, message: "updated via MCP" },
            },
          );
          return projectProperty(raw);
        }
        // Create path.
        const raw = await confluenceV2().post<unknown>(
          `/pages/${encodeURIComponent(args.page_id)}/properties`,
          { key: args.key, value: args.value },
        );
        return projectProperty(raw);
      }),
  });

  // ---------------- Delete property ----------------

  server.addTool({
    name: "confluence_delete_page_property",
    description: "Delete a page property by key.",
    parameters: z.object({
      page_id: z.string(),
      key: z.string(),
    }),
    execute: async (args: { page_id: string; key: string }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const existing = await confluenceV2().get<PagedResponse<PageProperty>>(
          `/pages/${encodeURIComponent(args.page_id)}/properties`,
          { key: args.key, limit: 1 },
        );
        const prop = existing.results?.[0];
        if (!prop?.id) {
          return { deleted: false, reason: "key not found" };
        }
        await confluenceV2().delete<unknown>(
          `/pages/${encodeURIComponent(args.page_id)}/properties/${encodeURIComponent(prop.id)}`,
        );
        return { deleted: true, key: args.key };
      }),
  });
}
