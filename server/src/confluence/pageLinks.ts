// Confluence page links — backlinks (inbound) + outbound links.
//
// Both are surface-level investigation primitives. Lead devs use them
// when refactoring docs ("what breaks if I move this page") or tracing
// architecture docs ("this runbook points to which other runbooks").
//
// Backlinks — pages that link TO this one
//   Atlassian has no direct "backlinks" API on v1 or v2. CQL via
//   /rest/api/search supports a `linkedto` operator that finds pages
//   linking to a given content id. We use it.
//
// Outbound links — pages that this one links TO
//   No direct API either. We parse the page's storage-format body and
//   extract <ac:link>...<ri:page ri:content-title="..." ri:space-key="..." />
//   and <ac:link>...<ri:attachment ri:filename="..." /> elements. This is
//   regex-on-XML (same approach _storage.ts uses for headings), documented
//   as best-effort.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { confluenceV1, confluenceV2 } from "../common/confluenceClient.js";
import { safeConfluence, toPageProjection } from "./_helpers.js";

export function registerPageLinkTools(server: FastMCP): void {
  // ---------------- Backlinks (pages that link to this page) ----------------
  //
  // Atlassian Cloud CQL does NOT expose a `linkedto` field — empirical
  // verification (April 2026) returned 400 "No field exists". The
  // documented CQL vocabulary has no direct backlinks primitive.
  //
  // Best-effort fallback: text search the page title. Confluence stores
  // links in storage format as:
  //   <ac:link><ri:page ri:content-title="Target Title" /></ac:link>
  // so the title appears in linking pages' bodies and the CQL `text`
  // index finds them. False-positive risk: pages that mention the title
  // in prose without an actual link. We mark those with a `confidence`
  // field (currently always "best-effort") so callers can decide whether
  // to post-filter by fetching each result's storage body and regex-
  // matching for a real <ac:link>.

  server.addTool({
    name: "confluence_get_page_backlinks",
    description:
      "List Confluence pages that link TO the given page. Best-effort via CQL text search on the target's title (Cloud has no `linkedto` operator). May include false positives (pages mentioning the title in prose, not as a link). Requires `search:confluence` classic scope. Returns {backlinks: PageProjection[], confidence, method}.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).default(25),
      start: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset (v1 CQL uses offset pagination, not cursor)"),
      verify: z
        .boolean()
        .default(false)
        .describe(
          "If true, post-filter each candidate by fetching its storage body and regex-matching for an actual <ac:link> to the target title. Exact but slow — N+1 calls.",
        ),
    }),
    execute: async (args: {
      page_id: string;
      limit: number;
      start: number;
      verify: boolean;
    }) =>
      safeConfluence(async () => {
        // Look up the target's title so we can text-search for it.
        const target = await confluenceV2().get<{ title?: string }>(
          `/pages/${encodeURIComponent(args.page_id)}`,
        );
        const title = target?.title;
        if (!title) {
          throw new Error(`page ${args.page_id} has no title`);
        }

        // CQL `text` index hit — note `~` (fuzzy contains), not `=` (which
        // the text field doesn't support). Escape double quotes and
        // backslashes inside the quoted value; strip CQL special chars
        // like unbalanced quotes or lone backslashes that can trip the
        // parser on titles with punctuation (em-dashes + colons are OK).
        const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const cql = `type = page AND text ~ "${escaped}"`;
        const res = await confluenceV1().get<{
          results?: Array<{ content?: unknown }>;
          size?: number;
          totalSize?: number;
        }>("/search", {
          cql,
          limit: args.limit,
          start: args.start,
        });
        let pages = (res.results ?? [])
          .map((r) => r.content)
          .filter((c): c is object => !!c && typeof c === "object")
          .map(toPageProjection)
          // Don't list the target page itself as a backlink.
          .filter((p) => p.id !== String(args.page_id));

        let method = "text-search-title";
        let confidence: "best-effort" | "verified" = "best-effort";

        if (args.verify && pages.length > 0) {
          // Pull storage body for each candidate and keep only those that
          // actually contain <ac:link> targeting this title. This is N+1
          // but exact.
          const titleForRegex = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const linkRe = new RegExp(
            `<ac:link[^>]*>\\s*<ri:page\\s[^>]*ri:content-title="${titleForRegex}"`,
            "i",
          );
          const confirmed = [] as typeof pages;
          for (const p of pages) {
            try {
              const body = await confluenceV2().get<{
                body?: { storage?: { value?: string } };
              }>(`/pages/${encodeURIComponent(p.id)}`, {
                "body-format": "storage",
              });
              const storage = body.body?.storage?.value ?? "";
              if (linkRe.test(storage)) confirmed.push(p);
            } catch {
              // swallow — a single page fetch failing shouldn't fail the whole tool.
            }
          }
          pages = confirmed;
          method = "text-search-title+storage-verify";
          confidence = "verified";
        }

        return {
          page_id: args.page_id,
          target_title: title,
          method,
          confidence,
          count: pages.length,
          totalSize_prefilter: res.totalSize ?? res.size ?? undefined,
          backlinks: pages,
        };
      }),
  });

  // ---------------- Outbound links (pages this page links TO) ----------------

  server.addTool({
    name: "confluence_get_page_outbound_links",
    description:
      "List pages + attachments that the given page links TO. Parses the page's storage-format body for <ac:link> elements. Returns categorized {page_links: [...], attachment_links: [...], external_urls: [...]}. Best-effort XML regex — nested macros may confuse it.",
    parameters: z.object({
      page_id: z.string(),
    }),
    execute: async (args: { page_id: string }) =>
      safeConfluence(async () => {
        const raw = await confluenceV2().get<{
          body?: { storage?: { value?: string } };
        }>(`/pages/${encodeURIComponent(args.page_id)}`, {
          "body-format": "storage",
        });
        const storage = raw.body?.storage?.value ?? "";
        return extractOutboundLinks(storage);
      }),
  });
}

// ---------------- helpers ----------------

export interface OutboundLinks {
  page_links: Array<{ title?: string; space_key?: string; anchor?: string }>;
  attachment_links: Array<{ filename: string; space_key?: string }>;
  external_urls: string[];
  raw_link_count: number;
}

/**
 * Extract outbound links from a Confluence storage-format body.
 *
 * Storage format link shapes we recognize:
 *   <ac:link><ri:page ri:content-title="Foo" ri:space-key="ENG" /></ac:link>
 *   <ac:link anchor="section"><ri:page ri:content-title="Foo" /></ac:link>
 *   <ac:link><ri:attachment ri:filename="diagram.png" /></ac:link>
 *   <a href="https://example.com/...">...</a>              (plain external)
 *
 * Regex-based — won't handle pathological nesting, but covers the
 * ~99% case of normal Confluence pages.
 */
export function extractOutboundLinks(storage: string): OutboundLinks {
  const out: OutboundLinks = {
    page_links: [],
    attachment_links: [],
    external_urls: [],
    raw_link_count: 0,
  };
  if (!storage) return out;

  // <ac:link ...>...</ac:link> blocks
  const acLinkRe = /<ac:link([^>]*)>([\s\S]*?)<\/ac:link>/gi;
  let m: RegExpExecArray | null;
  while ((m = acLinkRe.exec(storage)) !== null) {
    out.raw_link_count++;
    const attrs = m[1];
    const inner = m[2];
    const anchor = attrs.match(/\banchor="([^"]*)"/i)?.[1];

    // Page link: <ri:page ri:content-title="..." ri:space-key="..." />
    const pageMatch = inner.match(
      /<ri:page\b([^/>]*)\/?>/i,
    );
    if (pageMatch) {
      const pAttrs = pageMatch[1];
      out.page_links.push({
        title: pAttrs.match(/\bri:content-title="([^"]*)"/i)?.[1],
        space_key: pAttrs.match(/\bri:space-key="([^"]*)"/i)?.[1],
        anchor,
      });
      continue;
    }

    // Attachment link: <ri:attachment ri:filename="..." />
    const attMatch = inner.match(/<ri:attachment\b([^/>]*)\/?>/i);
    if (attMatch) {
      const aAttrs = attMatch[1];
      const filename = aAttrs.match(/\bri:filename="([^"]*)"/i)?.[1];
      if (filename) {
        out.attachment_links.push({
          filename,
          space_key: aAttrs.match(/\bri:space-key="([^"]*)"/i)?.[1],
        });
      }
      continue;
    }

    // Other ri:* forms (blog post, user, etc.) — not surfaced currently.
  }

  // Plain <a href="..."> external links (http/https only).
  const externalRe = /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"/gi;
  let m2: RegExpExecArray | null;
  while ((m2 = externalRe.exec(storage)) !== null) {
    out.raw_link_count++;
    out.external_urls.push(m2[1]);
  }
  // De-dup while preserving order.
  out.external_urls = Array.from(new Set(out.external_urls));

  return out;
}
