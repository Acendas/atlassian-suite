// Confluence attachments — v2 list/get/delete, v1 upload, raw-fetch download.
//
// v2 has no upload endpoint (confirmed in Atlassian's v2 docs), so
// upload goes through v1 `POST /content/{id}/child/attachment` as
// multipart. Read & delete are clean v2 operations.
//
// Download strategy: _links.download from v2 is a relative path
// (e.g. /download/attachments/PAGE_ID/file.pdf?...) relative to cfg.baseUrl
// (which is already the api.atlassian.com/ex/confluence/{cloudId}/wiki gateway
// when a cloudId is known, or the direct site URL otherwise). We prefix it to
// form the absolute URL and stream the response straight to disk — same pattern
// as jira_download_attachment — so large files don't OOM the MCP server.

import { z } from "zod";
import { readFile, mkdir } from "node:fs/promises";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastMCP } from "fastmcp";
import { confluenceV1, confluenceV2 } from "../common/confluenceClient.js";
import { loadConfluenceConfig } from "../common/config.js";
import {
  safeConfluence,
  ensureWritable,
  toAttachmentProjection,
  extractNextCursor,
  type PagedResponse,
} from "./_helpers.js";

export interface AttachmentOpts {
  readOnly: boolean;
}

/** Best-effort MIME sniff by extension. Confluence requires a content
 *  type on multipart upload; if none supplied we guess. */
function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    html: "text/html",
    xml: "application/xml",
  };
  return map[ext] ?? "application/octet-stream";
}

function basicAuthHeader(): string {
  const cfg = loadConfluenceConfig();
  if (!cfg) throw new Error("Confluence not configured.");
  return "Basic " + Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString("base64");
}

function wikiBase(): string {
  const cfg = loadConfluenceConfig();
  if (!cfg) throw new Error("Confluence not configured.");
  return cfg.baseUrl; // e.g. https://api.atlassian.com/ex/confluence/{cloudId}/wiki
}

/** Make a relative Confluence download path absolute.
 *  _links.download is always relative to the wiki base (same host + /wiki prefix). */
function absoluteDownloadLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  if (link.startsWith("http")) return link;
  return `${wikiBase()}${link}`;
}

function resolveSavePath(userPath: string): string {
  if (!userPath || typeof userPath !== "string") {
    throw new Error("save_path must be a non-empty string");
  }
  const expanded = userPath.startsWith("~")
    ? (process.env.HOME ?? "") + userPath.slice(1)
    : userPath;
  return resolvePath(expanded);
}

export function registerAttachmentTools(
  server: FastMCP,
  opts: AttachmentOpts,
): void {
  // ---------------- List attachments on a page (v2) ----------------

  server.addTool({
    name: "confluence_get_attachments",
    description:
      "List attachments on a Confluence page. Cursor-paginated. Returns AttachmentProjection[] ({id, title, mediaType, fileSize, downloadLink}). downloadLink is an absolute URL — use confluence_download_attachment to fetch the content.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(250).default(50),
      cursor: z.string().optional(),
    }),
    execute: async (args: { page_id: string; limit: number; cursor?: string }) =>
      safeConfluence(async () => {
        const res = await confluenceV2().get<PagedResponse<unknown>>(
          `/pages/${encodeURIComponent(args.page_id)}/attachments`,
          { limit: args.limit, cursor: args.cursor },
        );
        return {
          attachments: (res.results ?? []).map((a) => {
            const proj = toAttachmentProjection(a);
            proj.downloadLink = absoluteDownloadLink(proj.downloadLink);
            return proj;
          }),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // ---------------- Get one attachment (v2) ----------------

  server.addTool({
    name: "confluence_get_attachment",
    description:
      "Get metadata for a single Confluence attachment by id. downloadLink in the result is absolute — pass it to confluence_download_attachment to fetch the content.",
    parameters: z.object({ attachment_id: z.string() }),
    execute: async (args: { attachment_id: string }) =>
      safeConfluence(async () => {
        const raw = await confluenceV2().get<unknown>(
          `/attachments/${encodeURIComponent(args.attachment_id)}`,
        );
        const proj = toAttachmentProjection(raw);
        proj.downloadLink = absoluteDownloadLink(proj.downloadLink);
        return proj;
      }),
  });

  // ---------------- Download attachment content to disk ----------------

  server.addTool({
    name: "confluence_download_attachment",
    description:
      "Download a Confluence attachment's content to a local file path. Streams directly to disk — safe for large files. Creates intermediate directories as needed. Returns {path, bytes_written, mediaType, title}. Get attachment ids from confluence_get_attachments.",
    parameters: z.object({
      attachment_id: z.string().describe("Attachment id from confluence_get_attachments"),
      save_path: z
        .string()
        .describe(
          "Absolute path to write the file to. If the path ends with / or is an existing directory, the attachment title is appended as the filename. `~` is expanded to $HOME.",
        ),
    }),
    execute: async (args: { attachment_id: string; save_path: string }) =>
      safeConfluence(async () => {
        // Fetch metadata first — we need the downloadLink and title.
        const raw = await confluenceV2().get<unknown>(
          `/attachments/${encodeURIComponent(args.attachment_id)}`,
        );
        const meta = toAttachmentProjection(raw);
        const downloadUrl = absoluteDownloadLink(meta.downloadLink);
        if (!downloadUrl) {
          throw new Error(
            `Attachment ${args.attachment_id} has no download link in the API response. ` +
              "This can happen if the attachment was recently deleted or if your token lacks read scope.",
          );
        }

        // Resolve the save path.
        let targetPath = resolveSavePath(args.save_path);
        const isDirTarget =
          args.save_path.endsWith("/") ||
          args.save_path.endsWith("\\") ||
          (existsSync(targetPath) && statSync(targetPath).isDirectory());
        if (isDirTarget) {
          const filename = meta.title || basename(downloadUrl.split("?")[0]);
          if (!filename) {
            throw new Error(
              "save_path is a directory but attachment has no title — pass a full file path instead",
            );
          }
          targetPath = resolvePath(targetPath, filename);
        }
        await mkdir(dirname(targetPath), { recursive: true });

        // Fetch and stream to disk. Node's fetch follows redirects by default,
        // so any CDN / signed-URL redirect is transparent.
        const res = await fetch(downloadUrl, {
          headers: {
            Authorization: basicAuthHeader(),
            Accept: "*/*",
          },
          redirect: "follow",
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(
            `Confluence attachment download failed: ${res.status} ${res.statusText}` +
              (errText ? ` — ${errText.slice(0, 200)}` : ""),
          );
        }
        if (!res.body) {
          throw new Error("Response had no body");
        }

        const writeStream = createWriteStream(targetPath);
        const nodeStream = Readable.fromWeb(res.body as any);
        await pipeline(nodeStream, writeStream);

        const stats = statSync(targetPath);
        return {
          attachment_id: args.attachment_id,
          title: meta.title,
          path: targetPath,
          bytes_written: stats.size,
          mediaType: meta.mediaType ?? res.headers.get("content-type") ?? null,
        };
      }),
  });

  // ---------------- Upload (v1; v2 has no upload endpoint) ----------------

  server.addTool({
    name: "confluence_upload_attachment",
    description:
      "Upload (or replace) an attachment on a Confluence page from a local file path. v1-backed (v2 has no upload endpoint). Requires `write:confluence-content` classic scope. Returns the attachment id + download link; pair with confluence_render_image_macro to embed.",
    parameters: z.object({
      page_id: z.string(),
      file_path: z.string().describe("Absolute path to the local file"),
      filename: z
        .string()
        .optional()
        .describe("Filename to store in Confluence (default: basename of file_path)"),
      content_type: z
        .string()
        .optional()
        .describe("MIME type. If omitted, guessed from file extension."),
      comment: z.string().optional().describe("Version comment"),
      minor_edit: z.boolean().default(true),
    }),
    execute: async (args: {
      page_id: string;
      file_path: string;
      filename?: string;
      content_type?: string;
      comment?: string;
      minor_edit: boolean;
    }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const buf = await readFile(args.file_path);
        const filename = args.filename ?? basename(args.file_path);
        const ct = args.content_type ?? guessContentType(filename);

        const form = new FormData();
        // Wrap Node Buffer in a Blob with explicit content type.
        // Node 20+ globalThis.Blob and FormData accept this natively.
        const arr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        form.append("file", new Blob([arr], { type: ct }), filename);
        form.append("minorEdit", String(args.minor_edit));
        if (args.comment) form.append("comment", args.comment);

        return confluenceV1().postMultipart<unknown>(
          `/content/${encodeURIComponent(args.page_id)}/child/attachment`,
          form,
        );
      }),
  });

  // ---------------- Delete (v2) ----------------

  server.addTool({
    name: "confluence_delete_attachment",
    description:
      "Delete an attachment by id. Moves to trash (recoverable). Pass `purge: true` to permanently delete from trash.",
    parameters: z.object({
      attachment_id: z.string(),
      purge: z.boolean().default(false),
    }),
    execute: async (args: { attachment_id: string; purge: boolean }) =>
      safeConfluence(async () => {
        ensureWritable(opts.readOnly);
        const query = args.purge ? { purge: true } : undefined;
        await confluenceV2().delete<unknown>(
          `/attachments/${encodeURIComponent(args.attachment_id)}`,
          query,
        );
        return { deleted: args.attachment_id, purged: args.purge };
      }),
  });
}
