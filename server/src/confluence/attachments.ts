// Confluence attachments — v2 list/get/delete, v1 upload.
//
// v2 has no upload endpoint (confirmed in Atlassian's v2 docs), so
// upload goes through v1 `POST /content/{id}/child/attachment` as
// multipart. Read & delete are clean v2 operations.

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FastMCP } from "fastmcp";
import { confluenceV1, confluenceV2 } from "../common/confluenceClient.js";
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

export function registerAttachmentTools(
  server: FastMCP,
  opts: AttachmentOpts,
): void {
  // ---------------- List attachments on a page (v2) ----------------

  server.addTool({
    name: "confluence_get_attachments",
    description:
      "List attachments on a Confluence page. Cursor-paginated. Returns AttachmentProjection[] ({id, title, mediaType, fileSize, downloadLink}).",
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
          attachments: (res.results ?? []).map(toAttachmentProjection),
          nextCursor: extractNextCursor(res),
        };
      }),
  });

  // ---------------- Get one attachment (v2) ----------------

  server.addTool({
    name: "confluence_get_attachment",
    description:
      "Get metadata for a single Confluence attachment by id. Download link is in the result.",
    parameters: z.object({ attachment_id: z.string() }),
    execute: async (args: { attachment_id: string }) =>
      safeConfluence(async () => {
        const raw = await confluenceV2().get<unknown>(
          `/attachments/${encodeURIComponent(args.attachment_id)}`,
        );
        return toAttachmentProjection(raw);
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
