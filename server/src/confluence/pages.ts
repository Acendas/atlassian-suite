// Confluence pages: CRUD + title lookup + children + ancestors + history
// + space page tree + search + diff.
//
// v2 is the primary surface; v1 is used only for CQL search (v2 has no
// CQL endpoint) and move (v2 has no clean move). Surgical edits live in
// edits.ts. Page copy / version restore live in copy.ts / versions.ts.
//
// All list tools use cursor-based pagination. Callers pass `cursor` (from
// a previous response) to get the next page; `null` cursor is the start.
// Results always include `nextCursor` — `null` when there's no more.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import {
  confluenceV1,
  confluenceV2,
  confluenceSpacesFilter,
} from "../common/confluenceClient.js";
import {
  safeConfluence,
  ensureWritable,
  buildConfluenceBodyV2,
  toPageProjection,
  toVersionProjection,
  extractNextCursor,
  type PagedResponse,
} from "./_helpers.js";
import { adfToMarkdown } from "../common/adf.js";

export interface PageOpts {
  readOnly: boolean;
}

const BodyFormat = z.enum([
  "storage",
  "atlas_doc_format",
  "view",
  "export_view",
  "anonymous_export_view",
  "styled_view",
]);

export function registerPageTools(server: FastMCP, opts: PageOpts): void {
  // -------------------------------------------------------------------------
  // Search — CQL, v1. Confluence Cloud does not expose a v2 CQL endpoint.

  server.addTool({
    name: "confluence_search",
    description:
      "Search Confluence using CQL (Confluence Query Language). Honors CONFLUENCE_SPACES_FILTER if set. Returns search entries; each may wrap a page/user/comment under `content` or `user`.",
    parameters: z.object({
      cql: z.string().describe("Confluence Query Language expression"),
      limit: z.number().int().min(1).max(100).default(25),
      start: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset (v1 CQL uses offset pagination)"),
      excerpt: z
        .enum(["highlight", "indexed", "none"])
        .default("highlight"),
    }),
    execute: async (args: {
      cql: string;
      limit: number;
      start: number;
      excerpt: "highlight" | "indexed" | "none";
    }) =>
      safeConfluence(() => {
        const filter = confluenceSpacesFilter();
        const finalCql =
          filter && filter.length > 0
            ? `(${args.cql}) AND space in (${filter.map((s) => `"${s}"`).join(",")})`
            : args.cql;
        return confluenceV1().get("/search", {
          cql: finalCql,
          limit: args.limit,
          start: args.start,
          excerpt: args.excerpt,
        });
      }),
  });

  // -------------------------------------------------------------------------
  // Get page by id — v2.

  server.addTool({
    name: "confluence_get_page",
    description:
      "Get a Confluence page by id. Returns a normalized PageProjection (id, title, spaceId, parentId, versionNumber, body). body_format defaults to atlas_doc_format; pass 'storage' for raw XML edits or 'view' for rendered HTML.",
    parameters: z.object({
      page_id: z.string(),
      include_body: z.boolean().default(true),
      body_format: BodyFormat.default("atlas_doc_format"),
    }),
    execute: async (args: {
      page_id: string;
      include_body: boolean;
      body_format:
        | "storage"
        | "atlas_doc_format"
        | "view"
        | "export_view"
        | "anonymous_export_view"
        | "styled_view";
    }) =>
      safeConfluence(async () => {
        const query: Record<string, string | boolean> = {};
        if (args.include_body) {
          query["body-format"] = args.body_format;
        }
        const raw = await confluenceV2().get<unknown>(
          `/pages/${encodeURIComponent(args.page_id)}`,
          query,
        );
        return toPageProjection(raw);
      }),
  });

  // -------------------------------------------------------------------------
  // Get page by title — v2 /pages?title=&space-id= (fast lookup vs CQL).

  server.addTool({
    name: "confluence_get_page_by_title",
    description:
      "Resolve a Confluence page by exact title within a space. Faster than CQL search for the common 'fetch the page named X' pattern. Returns the first matching page as a PageProjection, or null if none found.",
    parameters: z.object({
      space_id: z
        .string()
        .describe(
          "Numeric space id (use getConfluenceSpaces to map a space key to its id). Required — v2 title lookup doesn't accept space keys.",
        ),
      title: z.string().describe("Exact page title, case-sensitive"),
      include_body: z.boolean().default(false),
      body_format: BodyFormat.default("atlas_doc_format"),
    }),
    execute: async (args: {
      space_id: string;
      title: string;
      include_body: boolean;
      body_format:
        | "storage"
        | "atlas_doc_format"
        | "view"
        | "export_view"
        | "anonymous_export_view"
        | "styled_view";
    }) =>
      safeConfluence(async () => {
        const query: Record<string, string | number | boolean> = {
          title: args.title,
          "space-id": args.space_id,
          limit: 1,
        };
        if (args.include_body) {
          query["body-format"] = args.body_format;
        }
        const res = await confluenceV2().get<PagedResponse<unknown>>("/pages", query);
        const first = res.results?.[0];
        if (!first) return { match: null };
        return { match: toPageProjection(first) };
      }),
  });

  // -------------------------------------------------------------------------
  // Children — v2.

  server.addTool({
    name: "confluence_get_page_children",
    description:
      "List immediate child pages of a Confluence page. Cursor-paginated — pass the `cursor` from a prior response to fetch the next page. Returns `{ pages: PageProjection[], nextCursor: string | null }`.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(50),
      cursor: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
      limit: number;
      cursor?: string;
    }) =>
      safeConfluence(async () => {
        const query: Record<string, string | number | undefined> = {
          limit: args.limit,
          cursor: args.cursor,
        };
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/children`,
          query,
        );
        return {
          pages: (res.results ?? []).map(toPageProjection),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // -------------------------------------------------------------------------
  // Ancestors — v2. Returns ids in order from root to immediate parent.

  server.addTool({
    name: "confluence_get_page_ancestors",
    description:
      "List the ancestor pages of a Confluence page (from root down to the immediate parent). Returns PageProjection[].",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args: { page_id: string; limit: number }) =>
      safeConfluence(async () => {
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/ancestors`,
          { limit: args.limit },
        );
        return { ancestors: (res.results ?? []).map(toPageProjection) };
      }),
  });

  // -------------------------------------------------------------------------
  // Version history — v2.

  server.addTool({
    name: "confluence_get_page_history",
    description:
      "List version history for a Confluence page. Returns VersionProjection[] (number, authorId, createdAt, minorEdit, message). Restore via confluence_restore_version.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(25),
      cursor: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
      limit: number;
      cursor?: string;
    }) =>
      safeConfluence(async () => {
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/versions`,
          { limit: args.limit, cursor: args.cursor },
        );
        return {
          versions: (res.results ?? []).map(toVersionProjection),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // -------------------------------------------------------------------------
  // Space page tree — v2 /pages/{id}/descendants in one call, then build
  // the tree client-side. Dramatically faster than v1's N+1 recursion.

  server.addTool({
    name: "confluence_get_space_page_tree",
    description:
      "Render a page's descendant tree. Provide `root_page_id` (the homepage id of a space, or any subtree root). Single /descendants API call + client-side rebuild — far cheaper than recursive children. Result: nested tree with {id, title, children: [...]}.",
    parameters: z.object({
      root_page_id: z.string(),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Client-side depth cutoff on the rebuilt tree"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(250)
        .default(250)
        .describe("Max descendants fetched per API page (up to 250 on v2)"),
    }),
    execute: async (args: { root_page_id: string; depth: number; limit: number }) =>
      safeConfluence(async () => {
        // Fetch ALL descendants (follow cursor until exhausted) so tree is complete.
        const all: Record<string, unknown>[] = [];
        let cursor: string | null = null;
        let safety = 20; // max 20 pages — 250 * 20 = 5000 pages tree
        do {
          const query: Record<string, string | number | undefined> = {
            limit: args.limit,
            cursor: cursor ?? undefined,
          };
          const res: PagedResponse<Record<string, unknown>> = await confluenceV2().get(
            `/pages/${encodeURIComponent(args.root_page_id)}/descendants`,
            query,
          );
          if (Array.isArray(res.results)) all.push(...res.results);
          cursor = extractNextCursor(res);
        } while (cursor && --safety > 0);

        // Build parent → children map. v2 descendants include `parentId` on
        // each page. Sort each bucket by `position` to preserve hierarchy
        // order (v2 doesn't guarantee response ordering).
        const byParent: Record<string, Record<string, unknown>[]> = {};
        for (const p of all) {
          const pid = String(p.parentId ?? args.root_page_id);
          (byParent[pid] ??= []).push(p);
        }
        for (const bucket of Object.values(byParent)) {
          bucket.sort((a, b) => {
            const ap = typeof a.position === "number" ? a.position : 0;
            const bp = typeof b.position === "number" ? b.position : 0;
            return ap - bp;
          });
        }

        type Node = { id: string; title: string; children: Node[] | "(depth limit)" };
        const walk = (id: string, d: number): Node["children"] => {
          if (d >= args.depth) return "(depth limit)";
          return (byParent[id] ?? []).map((p) => ({
            id: String(p.id ?? ""),
            title: String(p.title ?? ""),
            children: walk(String(p.id ?? ""), d + 1),
          }));
        };
        return {
          root_page_id: args.root_page_id,
          total_descendants: all.length,
          tree: walk(args.root_page_id, 0),
        };
      }),
  });

  // -------------------------------------------------------------------------
  // Create — v2 POST /pages.

  server.addTool({
    name: "confluence_create_page",
    description:
      "Create a Confluence page under a space. Provide content via ONE of: body_adf (raw ADF JSON), body_storage (raw storage XML, preserves macros/images), body_wiki (wiki markup), or body_markdown (converted to ADF — may strip macros). Returns a PageProjection.",
    parameters: z.object({
      space_id: z.string().describe("Numeric space id (from getConfluenceSpaces)"),
      title: z.string(),
      parent_id: z.string().optional(),
      status: z.enum(["current", "draft"]).default("current"),
      body_adf: z.any().optional(),
      body_storage: z.string().optional(),
      body_wiki: z.string().optional(),
      body_markdown: z.string().optional(),
    }),
    execute: async (args: {
      space_id: string;
      title: string;
      parent_id?: string;
      status: "current" | "draft";
      body_adf?: unknown;
      body_storage?: string;
      body_wiki?: string;
      body_markdown?: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBodyV2({
          body_adf: args.body_adf,
          body_storage: args.body_storage,
          body_wiki: args.body_wiki,
          body_markdown: args.body_markdown,
        });
        const payload: Record<string, unknown> = {
          spaceId: args.space_id,
          status: args.status,
          title: args.title,
          body,
        };
        if (args.parent_id) payload.parentId = args.parent_id;
        const raw = await confluenceV2().post<unknown>("/pages", payload);
        return toPageProjection(raw);
      }),
  });

  // -------------------------------------------------------------------------
  // Update — v2 PUT /pages/{id}. Caller must provide the new version number.

  server.addTool({
    name: "confluence_update_page",
    description:
      "Update (full replace) a Confluence page. For targeted edits preserving macros/images, prefer confluence_replace_section / confluence_append_to_page / confluence_insert_after_heading / confluence_replace_text. Returns the new PageProjection.",
    parameters: z.object({
      page_id: z.string(),
      title: z.string(),
      version_number: z
        .number()
        .int()
        .positive()
        .describe("New version number = current + 1 (fetch current via confluence_get_page)"),
      status: z.enum(["current", "draft"]).default("current"),
      body_adf: z.any().optional(),
      body_storage: z.string().optional(),
      body_wiki: z.string().optional(),
      body_markdown: z.string().optional(),
      version_message: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
      title: string;
      version_number: number;
      status: "current" | "draft";
      body_adf?: unknown;
      body_storage?: string;
      body_wiki?: string;
      body_markdown?: string;
      version_message?: string;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBodyV2({
          body_adf: args.body_adf,
          body_storage: args.body_storage,
          body_wiki: args.body_wiki,
          body_markdown: args.body_markdown,
        });
        const payload: Record<string, unknown> = {
          id: args.page_id,
          status: args.status,
          title: args.title,
          body,
          version: {
            number: args.version_number,
            ...(args.version_message ? { message: args.version_message } : {}),
          },
        };
        const raw = await confluenceV2().put<unknown>(
          `/pages/${encodeURIComponent(args.page_id)}`,
          payload,
        );
        return toPageProjection(raw);
      }),
  });

  // -------------------------------------------------------------------------
  // Delete — v2 DELETE /pages/{id}. Moves to trash by default; purge=true
  // permanently removes already-trashed pages.

  server.addTool({
    name: "confluence_delete_page",
    description:
      "Trash a Confluence page (moves to trash; recoverable). Pass `purge: true` to permanently delete a page that is already in the trash (not a live page — purge on a current page returns 400).",
    parameters: z.object({
      page_id: z.string(),
      purge: z.boolean().default(false),
    }),
    execute: async (args: { page_id: string; purge: boolean }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const query = args.purge ? { purge: true } : undefined;
        await confluenceV2().delete<unknown>(
          `/pages/${encodeURIComponent(args.page_id)}`,
          query,
        );
        return { deleted: args.page_id, purged: args.purge };
      }),
  });

  // -------------------------------------------------------------------------
  // Move — v1. v2 doesn't expose a move endpoint.

  server.addTool({
    name: "confluence_move_page",
    description:
      "Move a Confluence page to a different parent (or reorder relative to a sibling). Uses v1 — v2 has no move endpoint. `position: append` makes the page the last child of target_id; `before`/`after` places it as a sibling of target_id.",
    parameters: z.object({
      page_id: z.string(),
      target_id: z
        .string()
        .describe("Page id to move relative to. For `append`, this is the new parent."),
      position: z.enum(["append", "before", "after"]).default("append"),
    }),
    execute: async (args: {
      page_id: string;
      target_id: string;
      position: "append" | "before" | "after";
    }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        return confluenceV1().put<unknown>(
          `/content/${encodeURIComponent(args.page_id)}/move/${encodeURIComponent(args.position)}/${encodeURIComponent(args.target_id)}`,
        );
      }),
  });

  // -------------------------------------------------------------------------
  // Diff — two version fetches + local ADF→Markdown render.

  server.addTool({
    name: "confluence_get_page_diff",
    description:
      "Compute a unified diff between two versions of a Confluence page (rendered as Markdown for readability). Use confluence_get_page_history to list versions.",
    parameters: z.object({
      page_id: z.string(),
      version_a: z.number().int().positive(),
      version_b: z.number().int().positive(),
    }),
    execute: async (args: { page_id: string; version_a: number; version_b: number }) =>
      safeConfluence(async () => {
        const fetchVersion = async (n: number): Promise<string> => {
          const v = await confluenceV2().get<{ body?: { atlas_doc_format?: { value?: string } } }>(
            `/pages/${encodeURIComponent(args.page_id)}/versions/${n}`,
            { "body-format": "atlas_doc_format" },
          );
          const adfStr = v.body?.atlas_doc_format?.value;
          if (!adfStr) return "";
          try {
            return adfToMarkdown(JSON.parse(adfStr));
          } catch {
            return adfStr;
          }
        };
        const [a, b] = await Promise.all([
          fetchVersion(args.version_a),
          fetchVersion(args.version_b),
        ]);
        return {
          page_id: args.page_id,
          version_a: args.version_a,
          version_b: args.version_b,
          markdown_a: a,
          markdown_b: b,
          unified_diff: computeUnifiedDiff(a, b, `v${args.version_a}`, `v${args.version_b}`),
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// Local unified-diff implementation — no external dep.
//
// Simple line-based diff with a Myers-inspired LCS backbone. For the use
// case here (page revisions, not binary or huge files), correctness matters
// more than speed — we keep it readable.

function computeUnifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  // LCS matrix
  const m = aLines.length, n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push(` ${aLines[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${aLines[i]}`);
      i++;
    } else {
      out.push(`+${bLines[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`-${aLines[i++]}`);
  while (j < n) out.push(`+${bLines[j++]}`);
  return out.join("\n");
}
