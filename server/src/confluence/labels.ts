// Confluence labels + attachments (list/upload/delete).

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FastMCP } from "fastmcp";
import { confluenceClient } from "../common/confluenceClient.js";
import { safeConfluence, ensureWritable } from "./_helpers.js";

export interface LabelOpts {
  readOnly: boolean;
}

export function registerLabelAndAttachmentTools(server: FastMCP, opts: LabelOpts): void {
  // ---------- Labels ----------

  server.addTool({
    name: "confluence_get_labels",
    description: "List labels on a Confluence page.",
    parameters: z.object({ page_id: z.string() }),
    execute: async (args: { page_id: string }) =>
      safeConfluence(() =>
        confluenceClient().contentLabels.getLabelsForContent({
          id: args.page_id,
        } as never),
      ),
  });

  server.addTool({
    name: "confluence_add_label",
    description: "Add one or more labels to a Confluence page.",
    parameters: z.object({
      page_id: z.string(),
      labels: z.array(z.string()).min(1),
    }),
    execute: async (args: { page_id: string; labels: string[] }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        return confluenceClient().contentLabels.addLabelsToContent({
          id: args.page_id,
          body: args.labels.map((name) => ({ prefix: "global", name })),
        } as never);
      }),
  });

  // ---------- Attachments ----------

  server.addTool({
    name: "confluence_get_attachments",
    description: "List attachments on a Confluence page.",
    parameters: z.object({
      page_id: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    execute: async (args: { page_id: string; limit: number }) =>
      safeConfluence(() =>
        confluenceClient().contentAttachments.getAttachments({
          id: args.page_id,
          limit: args.limit,
        } as never),
      ),
  });

  server.addTool({
    name: "confluence_upload_attachment",
    description:
      "Upload (or replace) an attachment on a Confluence page from a local file path. Returns the attachment id and download link — use the filename with confluence_render_image_macro to embed in page content.",
    parameters: z.object({
      page_id: z.string(),
      file_path: z.string().describe("Absolute path to the local file"),
      filename: z
        .string()
        .optional()
        .describe("Filename to store in Confluence (default: basename of file_path)"),
      content_type: z.string().optional().describe("MIME type, e.g. image/png"),
      comment: z.string().optional(),
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
        const buffer = await readFile(args.file_path);
        const filename = args.filename ?? basename(args.file_path);
        return confluenceClient().contentAttachments.createOrUpdateAttachments({
          id: args.page_id,
          attachments: [
            {
              file: buffer,
              filename,
              minorEdit: args.minor_edit,
              contentType: args.content_type,
              comment: args.comment,
            },
          ],
        } as never);
      }),
  });

  server.addTool({
    name: "confluence_delete_attachment",
    description: "Delete an attachment by content id.",
    parameters: z.object({ attachment_id: z.string() }),
    execute: async (args: { attachment_id: string }) =>
      safeConfluence(() => {
        ensureWritable(opts.readOnly);
        return confluenceClient().content.deleteContent({ id: args.attachment_id } as never);
      }),
  });
}
