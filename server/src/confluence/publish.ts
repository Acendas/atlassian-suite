// Safe docs -> Confluence publishing.
//
// The problem these tools exist for: a repo full of markdown is the source of
// truth, but the published Confluence pages have accumulated things the
// markdown does not contain — inline comment threads from reviewers, attached
// diagrams, an info-macro banner, <ac:link> cross-references. `update_page`
// replaces the body wholesale, so re-publishing destroys all of it, and
// nothing warns you first. That makes a 27-page re-sync something nobody can
// safely attempt.
//
// The design turns silent loss into an accounted-for decision, in four steps:
//
//   1. RENDER   markdown -> storage XML (never ADF; see _markdown.ts)
//   2. CARRY    lift inline-comment markers off the live body, re-apply them
//               to the rendered body (see _anchors.ts)
//   3. GATE     any anchor that could not be re-applied blocks the write
//               unless the caller explicitly accepts losing it
//   4. VERIFY   after writing, ask Confluence which comments went `dangling`.
//               If any did, say so and hand back the exact version number to
//               roll back to.
//
// Step 4 is what makes this safe rather than merely careful: the check is
// against Confluence's own answer after the fact, not against our belief
// before it. Publishing bumps the version, and the previous version is still
// there, so a bad publish is recoverable via confluence_restore_version.

import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FastMCP } from "fastmcp";
import { confluenceV1, confluenceV2 } from "../common/confluenceClient.js";
import {
  safeConfluence,
  ensureWritable,
  toPageProjection,
  type PagedResponse,
} from "./_helpers.js";
import { markdownToStorage } from "./_markdown.js";
import { extractAnchors, applyAnchors, type Anchor } from "./_anchors.js";

export interface PublishOpts {
  readOnly: boolean;
}

interface PageState {
  id: string;
  title: string;
  versionNumber: number;
  storage: string;
}

async function fetchPageStorage(pageId: string): Promise<PageState> {
  const raw = await confluenceV2().get<{
    id?: string;
    title?: string;
    version?: { number?: number };
    body?: { storage?: { value?: string } };
  }>(`/pages/${encodeURIComponent(pageId)}`, { "body-format": "storage" });
  return {
    id: String(raw.id ?? pageId),
    title: String(raw.title ?? ""),
    versionNumber: raw.version?.number ?? 1,
    storage: raw.body?.storage?.value ?? "",
  };
}

/** Count inline comments currently in a given resolution state. Used before
 *  and after a write so "went dangling because of THIS publish" is a delta,
 *  not an absolute — pages often carry pre-existing dangling comments from
 *  edits made in the Confluence UI, and blaming those on us would cry wolf. */
async function danglingRefs(pageId: string): Promise<string[]> {
  const res = await confluenceV2().get<PagedResponse<{ id?: string }>>(
    `/pages/${encodeURIComponent(pageId)}/inline-comments`,
    { limit: 250, "resolution-status": "dangling", "body-format": "storage" },
  );
  return (res.results ?? []).map((c) => String(c.id ?? ""));
}

/** Things in a live page body that a wholesale republish would destroy. */
function inventory(storage: string) {
  const macros = [...storage.matchAll(/<ac:structured-macro\s+ac:name="([^"]+)"/gi)].map(
    (m) => m[1],
  );
  const attachments = [...storage.matchAll(/<ri:attachment\s+ri:filename="([^"]+)"/gi)].map(
    (m) => m[1],
  );
  const pageLinks = [...storage.matchAll(/<ri:page\s+ri:content-title="([^"]+)"/gi)].map(
    (m) => m[1],
  );
  const macroCounts: Record<string, number> = {};
  for (const name of macros) macroCounts[name] = (macroCounts[name] ?? 0) + 1;
  return {
    macros: macroCounts,
    attachments: Array.from(new Set(attachments)),
    page_links: Array.from(new Set(pageLinks)),
  };
}

const summarizeAnchor = (a: Anchor) => ({ ref: a.ref, text: a.text, context: a.before.trim() });

export function registerPublishTools(server: FastMCP, opts: PublishOpts): void {
  // ---------- Pure render (no API call, no write) ----------

  server.addTool({
    name: "confluence_markdown_to_storage",
    description:
      "Render Markdown to Confluence storage XML without touching any page. Code fences become code macros, ```mermaid fences become <ac:image> references to PRE-RENDERED SVG attachments (this tool does not render diagrams), > [!NOTE] blockquotes become info/note/tip/warning macros, and relative links become <ac:link> page references. Returns the storage plus diagrams[], missing_assets[] and unresolved_links[] so the caller can fix gaps before publishing. Use this to preview what confluence_publish_page would write.",
    parameters: z.object({
      markdown: z.string(),
      asset_map: z
        .record(z.string())
        .optional()
        .describe("Markdown image path -> Confluence attachment filename"),
      page_map: z
        .record(z.string())
        .optional()
        .describe("Relative doc path -> Confluence page title, for cross-references"),
      diagram_prefix: z
        .string()
        .optional()
        .describe("Base name for mermaid attachments: <prefix>-<n>.svg, zero-indexed"),
    }),
    execute: async (args: {
      markdown: string;
      asset_map?: Record<string, string>;
      page_map?: Record<string, string>;
      diagram_prefix?: string;
    }) =>
      safeConfluence(async () => {
        const out = markdownToStorage(args.markdown, {
          assetMap: args.asset_map,
          pageMap: args.page_map,
          diagramPrefix: args.diagram_prefix,
        });
        return {
          storage: out.storage,
          diagrams: out.diagrams,
          missing_assets: out.missingAssets,
          unresolved_links: out.unresolvedLinks,
        };
      }),
  });

  // ---------- Preflight (read-only) ----------

  server.addTool({
    name: "confluence_publish_preflight",
    description:
      "READ-ONLY. Report what publishing new content to a page would cost before anything is written: existing inline-comment anchors and whether each would survive, plus the macros, attachments and page links currently on the page. Pass `markdown` to get a per-anchor survives/at-risk verdict; omit it to just inventory the page. Nothing is modified. Run this before confluence_publish_page on any page that has been reviewed.",
    parameters: z.object({
      page_id: z.string(),
      markdown: z.string().optional().describe("Proposed new content; enables the at-risk verdict"),
      asset_map: z.record(z.string()).optional(),
      page_map: z.record(z.string()).optional(),
      diagram_prefix: z.string().optional(),
    }),
    execute: async (args: {
      page_id: string;
      markdown?: string;
      asset_map?: Record<string, string>;
      page_map?: Record<string, string>;
      diagram_prefix?: string;
    }) =>
      safeConfluence(async () => {
        const state = await fetchPageStorage(args.page_id);
        const anchors = extractAnchors(state.storage);
        const current = inventory(state.storage);

        if (!args.markdown) {
          return {
            page_id: state.id,
            title: state.title,
            version: state.versionNumber,
            inline_comment_anchors: anchors.map(summarizeAnchor),
            current_content: current,
            note:
              anchors.length > 0
                ? `${anchors.length} inline comment anchor(s) live in this body. A full-body republish drops them unless they are carried over — pass markdown to see which would survive.`
                : "No inline comment anchors on this page.",
          };
        }

        const rendered = markdownToStorage(args.markdown, {
          assetMap: args.asset_map,
          pageMap: args.page_map,
          diagramPrefix: args.diagram_prefix,
        });
        const applied = applyAnchors(rendered.storage, anchors);
        const proposed = inventory(applied.storage);

        const droppedAttachments = current.attachments.filter(
          (f) => !proposed.attachments.includes(f),
        );
        const droppedLinks = current.page_links.filter((t) => !proposed.page_links.includes(t));

        return {
          page_id: state.id,
          title: state.title,
          version: state.versionNumber,
          safe_to_publish: applied.unmatched.length === 0 && rendered.missingAssets.length === 0,
          anchors: {
            total: anchors.length,
            will_survive: applied.preserved.map(summarizeAnchor),
            at_risk: applied.unmatched.map(summarizeAnchor),
          },
          attachments: {
            referenced_now: current.attachments,
            referenced_after: proposed.attachments,
            no_longer_referenced: droppedAttachments,
          },
          page_links: { no_longer_referenced: droppedLinks },
          macros: { before: current.macros, after: proposed.macros },
          diagrams: rendered.diagrams,
          missing_assets: rendered.missingAssets,
          unresolved_links: rendered.unresolvedLinks,
        };
      }),
  });

  // ---------- Publish (write + verify) ----------

  server.addTool({
    name: "confluence_publish_page",
    description:
      "Publish Markdown to an existing Confluence page, carrying inline-comment anchors across the rewrite and verifying afterwards that none went dangling. REFUSES by default if any anchor cannot be re-applied or any asset is unmapped — pass accept_anchor_loss / accept_missing_assets to override deliberately. Returns the version number to roll back to via confluence_restore_version if verification reports damage. Prefer confluence_publish_preflight first.",
    parameters: z.object({
      page_id: z.string(),
      markdown: z.string(),
      title: z.string().optional().describe("New title; defaults to the page's current title"),
      asset_map: z.record(z.string()).optional(),
      page_map: z.record(z.string()).optional(),
      diagram_prefix: z.string().optional(),
      version_message: z.string().optional(),
      accept_anchor_loss: z
        .boolean()
        .default(false)
        .describe("Publish even though listed inline comments will be orphaned"),
      accept_missing_assets: z
        .boolean()
        .default(false)
        .describe("Publish even though some images have no attachment mapping"),
    }),
    execute: async (args: {
      page_id: string;
      markdown: string;
      title?: string;
      asset_map?: Record<string, string>;
      page_map?: Record<string, string>;
      diagram_prefix?: string;
      version_message?: string;
      accept_anchor_loss: boolean;
      accept_missing_assets: boolean;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);

        const state = await fetchPageStorage(args.page_id);
        const anchors = extractAnchors(state.storage);
        const rendered = markdownToStorage(args.markdown, {
          assetMap: args.asset_map,
          pageMap: args.page_map,
          diagramPrefix: args.diagram_prefix,
        });
        const applied = applyAnchors(rendered.storage, anchors);

        // Gate BEFORE the write. Refusing is the whole point: the caller finds
        // out while the page is still intact, not after.
        if (applied.unmatched.length > 0 && !args.accept_anchor_loss) {
          return {
            published: false,
            refused: "anchor_loss",
            message: `${applied.unmatched.length} inline comment(s) anchor to text that no longer exists in the new content. Publishing would orphan them. Re-word the markdown to keep the anchored text, resolve the comments first, or pass accept_anchor_loss: true.`,
            at_risk: applied.unmatched.map(summarizeAnchor),
            version: state.versionNumber,
          };
        }
        if (rendered.missingAssets.length > 0 && !args.accept_missing_assets) {
          return {
            published: false,
            refused: "missing_assets",
            message:
              "Some images have no asset_map entry and would render as broken attachments. Upload them with confluence_sync_attachments, extend asset_map, or pass accept_missing_assets: true.",
            missing_assets: rendered.missingAssets,
            version: state.versionNumber,
          };
        }

        const danglingBefore = new Set(await danglingRefs(args.page_id));

        const raw = await confluenceV2().put<unknown>(
          `/pages/${encodeURIComponent(state.id)}`,
          {
            id: state.id,
            status: "current",
            title: args.title ?? state.title,
            body: { representation: "storage", value: applied.storage },
            version: {
              number: state.versionNumber + 1,
              ...(args.version_message ? { message: args.version_message } : {}),
            },
          },
        );

        // Verify against Confluence's own view rather than our expectation.
        const danglingAfter = await danglingRefs(args.page_id);
        const newlyDangling = danglingAfter.filter((id) => !danglingBefore.has(id));

        return {
          published: true,
          page: toPageProjection(raw),
          version_before: state.versionNumber,
          version_after: state.versionNumber + 1,
          anchors_preserved: applied.preserved.map(summarizeAnchor),
          anchors_orphaned: applied.unmatched.map(summarizeAnchor),
          diagrams: rendered.diagrams,
          unresolved_links: rendered.unresolvedLinks,
          verification:
            newlyDangling.length === 0
              ? { ok: true, newly_dangling: [] }
              : {
                  ok: false,
                  newly_dangling: newlyDangling,
                  message: `${newlyDangling.length} inline comment(s) became dangling as a result of this publish. Roll back with confluence_restore_version(page_id, version_number: ${state.versionNumber}).`,
                },
          rollback: {
            tool: "confluence_restore_version",
            page_id: state.id,
            version_number: state.versionNumber,
          },
        };
      }),
  });

  // ---------- Attachment reconciliation ----------

  server.addTool({
    name: "confluence_sync_attachments",
    description:
      "Upload local files as page attachments, skipping any whose content is already there. Each upload records a sha256 of the content in the attachment's version comment; a file whose hash matches the stored one is left alone, so re-running a publish does not churn attachment versions or bump every diagram on every sync. Returns per-file uploaded/skipped. Use for diagram SVGs rendered by your own toolchain before confluence_publish_page.",
    parameters: z.object({
      page_id: z.string(),
      files: z
        .array(
          z.object({
            path: z.string().describe("Absolute path to the local file"),
            filename: z
              .string()
              .optional()
              .describe("Name to store in Confluence (default: basename of path)"),
          }),
        )
        .min(1),
      force: z.boolean().default(false).describe("Re-upload even when the hash matches"),
    }),
    execute: async (args: {
      page_id: string;
      files: Array<{ path: string; filename?: string }>;
      force: boolean;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);

        // Existing attachments, with whatever hash a previous sync recorded.
        const existing = await confluenceV2().get<
          PagedResponse<{ title?: string; version?: { message?: string } }>
        >(`/pages/${encodeURIComponent(args.page_id)}/attachments`, { limit: 250 });
        const priorHash = new Map<string, string>();
        for (const a of existing.results ?? []) {
          const msg = a.version?.message ?? "";
          const m = /sha256:([0-9a-f]{64})/.exec(msg);
          if (a.title && m) priorHash.set(a.title, m[1]);
        }

        const results: Array<Record<string, unknown>> = [];
        for (const file of args.files) {
          const buf = await readFile(file.path);
          const filename = file.filename ?? basename(file.path);
          const hash = createHash("sha256").update(buf).digest("hex");

          if (!args.force && priorHash.get(filename) === hash) {
            results.push({ filename, uploaded: false, reason: "unchanged", sha256: hash });
            continue;
          }

          const form = new FormData();
          const arr = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
          ) as ArrayBuffer;
          form.append("file", new Blob([arr], { type: guessType(filename) }), filename);
          form.append("minorEdit", "true");
          form.append("comment", `sha256:${hash}`);

          await confluenceV1().postMultipart<unknown>(
            `/content/${encodeURIComponent(args.page_id)}/child/attachment`,
            form,
          );
          results.push({ filename, uploaded: true, sha256: hash });
        }

        return {
          page_id: args.page_id,
          uploaded: results.filter((r) => r.uploaded).length,
          skipped: results.filter((r) => !r.uploaded).length,
          files: results,
        };
      }),
  });
}

/** Minimal content-type guess. SVG matters most here — served as
 *  application/octet-stream it downloads instead of rendering inline. */
function guessType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}
