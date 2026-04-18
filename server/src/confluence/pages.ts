// Confluence page CRUD + search + history + children + diff + move.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceClient, confluenceSpacesFilter } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable, buildConfluenceBody } from "./_helpers.js";

export interface PageOpts {
  readOnly: boolean;
}

export function registerPageTools(server: FastMCP, opts: PageOpts): void {
  // ---------- Search ----------

  server.addTool({
    name: "confluence_search",
    description: "Search Confluence using CQL. Honors CONFLUENCE_SPACES_FILTER if set.",
    parameters: z.object({
      cql: z.string().describe("Confluence Query Language expression"),
      limit: z.number().int().min(1).max(100).default(25),
      start: z.number().int().min(0).default(0),
      excerpt: z.enum(["highlight", "indexed", "none"]).default("highlight"),
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
        return confluenceClient().search.searchByCQL({
          cql: finalCql,
          limit: args.limit,
          start: args.start,
          excerpt: args.excerpt,
        } as never);
      }),
  });

  // ---------- Get / list ----------

  server.addTool({
    name: "confluence_get_page",
    description: "Get a Confluence page by id, with body (default representation = atlas_doc_format).",
    parameters: z.object({
      page_id: z.string(),
      include_body: z.boolean().default(true),
      representation: z
        .enum(["atlas_doc_format", "storage", "view"])
        .default("atlas_doc_format"),
    }),
    execute: async (args: {
      page_id: string;
      include_body: boolean;
      representation: "atlas_doc_format" | "storage" | "view";
    }) =>
      safeConfluence(() => {
        const expand: string[] = [];
        if (args.include_body) expand.push(`body.${args.representation}`);
        expand.push("version", "space", "ancestors");
        return confluenceClient().content.getContentById({
          id: args.page_id,
          expand,
        } as never);
      }),
  });

  server.addTool({
    name: "confluence_get_page_children",
    description: "List children of a Confluence page.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args: { page_id: string; limit: number }) =>
      safeConfluence(() =>
        confluenceClient().contentChildrenAndDescendants.getContentChildren({
          id: args.page_id,
          limit: args.limit,
          expand: ["page"],
        } as never),
      ),
  });

  server.addTool({
    name: "confluence_get_page_history",
    description: "Get version history for a Confluence page.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    execute: async (args: { page_id: string; limit: number }) =>
      safeConfluence(() =>
        confluenceClient().contentVersions.getContentVersions({
          id: args.page_id,
          limit: args.limit,
        } as never),
      ),
  });

  server.addTool({
    name: "confluence_get_space_page_tree",
    description: "Render a space's page hierarchy starting from the space root.",
    parameters: z.object({
      space_key: z.string(),
      depth: z.number().int().min(1).max(10).default(2),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args: { space_key: string; depth: number; limit: number }) =>
      safeConfluence(async () => {
        const root: any = await confluenceClient().space.getSpace({
          spaceKey: args.space_key,
          expand: ["homepage"],
        } as never);
        const homepageId: string | undefined = root?.homepage?.id;
        if (!homepageId) {
          return { space: root, message: "No homepage found for this space." };
        }
        const walk = async (id: string, currentDepth: number): Promise<any> => {
          if (currentDepth >= args.depth) {
            return { id, children: "(depth limit)" };
          }
          const children: any = await confluenceClient().contentChildrenAndDescendants.getContentChildren({
            id,
            limit: args.limit,
            expand: ["page"],
          } as never);
          const pages = children?.page?.results ?? [];
          const next = await Promise.all(
            pages.map(async (p: any) => ({
              id: p.id,
              title: p.title,
              children: await walk(p.id, currentDepth + 1),
            })),
          );
          return next;
        };
        return {
          space_key: args.space_key,
          homepage_id: homepageId,
          tree: await walk(homepageId, 0),
        };
      }),
  });

  // ---------- Create / update / delete ----------

  server.addTool({
    name: "confluence_create_page",
    description:
      "Create a Confluence page. Provide content via ONE of: body_adf (raw ADF JSON, best for charts/panels/macros), body_storage (raw storage XML, preserves <ac:image> and <ac:structured-macro>), body_wiki (Confluence wiki markup), or body_markdown (Markdown — auto-converted, may strip macros).",
    parameters: z.object({
      space_key: z.string(),
      title: z.string(),
      parent_id: z.string().optional(),
      body_adf: z.any().optional().describe("Pre-built ADF JSON object"),
      body_storage: z.string().optional().describe("Confluence storage XML"),
      body_wiki: z.string().optional().describe("Confluence wiki markup"),
      body_markdown: z.string().optional().describe("Markdown — converted to ADF"),
    }),
    execute: async (args: {
      space_key: string;
      title: string;
      parent_id?: string;
      body_adf?: unknown;
      body_storage?: string;
      body_wiki?: string;
      body_markdown?: string;
    }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBody({
          body_adf: args.body_adf,
          body_storage: args.body_storage,
          body_wiki: args.body_wiki,
          body_markdown: args.body_markdown,
        });
        return confluenceClient().content.createContent({
          type: "page",
          title: args.title,
          space: { key: args.space_key },
          ancestors: args.parent_id ? [{ id: args.parent_id }] : undefined,
          body,
        } as never);
      }),
  });

  server.addTool({
    name: "confluence_update_page",
    description:
      "Update (full replace) a Confluence page. Increments the version. For granular edits that preserve images/macros/charts, prefer confluence_replace_section, confluence_append_to_page, confluence_insert_after_heading, or confluence_replace_text.",
    parameters: z.object({
      page_id: z.string(),
      title: z.string(),
      version_number: z
        .number()
        .int()
        .positive()
        .describe("Current version number + 1 (fetch via confluence_get_page first)"),
      body_adf: z.any().optional(),
      body_storage: z.string().optional(),
      body_wiki: z.string().optional(),
      body_markdown: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
      title: string;
      version_number: number;
      body_adf?: unknown;
      body_storage?: string;
      body_wiki?: string;
      body_markdown?: string;
    }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        const body = buildConfluenceBody({
          body_adf: args.body_adf,
          body_storage: args.body_storage,
          body_wiki: args.body_wiki,
          body_markdown: args.body_markdown,
        });
        return confluenceClient().content.updateContent({
          id: args.page_id,
          type: "page",
          title: args.title,
          version: { number: args.version_number },
          body,
        } as never);
      }),
  });

  server.addTool({
    name: "confluence_delete_page",
    description: "Delete (trash) a Confluence page.",
    parameters: z.object({ page_id: z.string() }),
    execute: async (args: { page_id: string }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        return confluenceClient().content.deleteContent({ id: args.page_id } as never);
      }),
  });

  server.addTool({
    name: "confluence_move_page",
    description: "Move a Confluence page to a new parent.",
    parameters: z.object({
      page_id: z.string(),
      target_parent_id: z.string(),
      position: z.enum(["append", "before", "after"]).default("append"),
    }),
    execute: async (args: {
      page_id: string;
      target_parent_id: string;
      position: "append" | "before" | "after";
    }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        return confluenceClient().contentChildrenAndDescendants.movePage({
          pageId: args.page_id,
          targetId: args.target_parent_id,
          position: args.position,
        } as never);
      }),
  });
}
