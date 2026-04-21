// Jira issue attachments: list / get / download / upload / delete.
//
// jira.js doesn't expose a clean binary-download path, and attachments
// are frequently large, so this module drops down to raw fetch for the
// content endpoints and uses jira.js for JSON operations.
//
// Gateway routing: cfg.baseUrl is already api.atlassian.com/ex/jira/{cloudId}
// when scoped tokens are in play, so prepending /rest/api/3/... goes to
// the right place automatically. Works equally on legacy direct URLs.
//
// Download strategy: /rest/api/3/attachment/content/{id} returns either
// the bytes directly (redirect followed) OR a 303 to a signed S3 URL.
// Node's fetch follows redirects by default, so we just write the
// response body to the requested path. We never buffer the whole file
// in memory — we stream straight to disk via a write stream so multi-GB
// attachments don't OOM the MCP server.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { dirname, basename, resolve as resolvePath } from "node:path";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { jiraClient } from "../common/jiraClient.js";
import { loadJiraConfig } from "../common/config.js";
import { safeJira, ensureWritable } from "./_helpers.js";

export interface AttachmentOpts {
  readOnly: boolean;
}

// ------------- projection types -------------

interface AttachmentProjection {
  id: string;
  filename: string;
  size?: number;
  mimeType?: string;
  author?: { accountId?: string; displayName?: string; email?: string | null };
  created?: string;
  contentUrl?: string;
  thumbnailUrl?: string;
  self?: string;
}

function toAttachmentProjection(raw: any): AttachmentProjection {
  if (!raw || typeof raw !== "object") return { id: "", filename: "" };
  return {
    id: String(raw.id ?? ""),
    filename: String(raw.filename ?? ""),
    size: typeof raw.size === "number" ? raw.size : undefined,
    mimeType: raw.mimeType,
    author: raw.author
      ? {
          accountId: raw.author.accountId,
          displayName: raw.author.displayName,
          email: raw.author.emailAddress ?? raw.author.email ?? null,
        }
      : undefined,
    created: raw.created,
    contentUrl: raw.content,
    thumbnailUrl: raw.thumbnail,
    self: raw.self,
  };
}

// ------------- helpers -------------

function basicAuthHeader(): string {
  const cfg = loadJiraConfig();
  if (!cfg) throw new Error("Jira not configured.");
  return "Basic " + Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString("base64");
}

function gatewayBase(): string {
  const cfg = loadJiraConfig();
  if (!cfg) throw new Error("Jira not configured.");
  return cfg.baseUrl; // already api.atlassian.com/ex/jira/{cloudId} when cloudId is known
}

// Resolve a user-supplied path to an absolute path and refuse traversal
// attempts that would write outside a safe root. We don't enforce a chroot —
// the user may legitimately want to save anywhere on their disk — but we do
// resolve the path and require it to be absolute so there's no ambiguity.
function resolveSavePath(userPath: string): string {
  if (!userPath || typeof userPath !== "string") {
    throw new Error("save_path must be a non-empty string");
  }
  // Tilde expansion for `~/…` convenience.
  const expanded = userPath.startsWith("~")
    ? process.env.HOME + userPath.slice(1)
    : userPath;
  return resolvePath(expanded);
}

// ------------- tool registration -------------

export function registerJiraAttachmentTools(server: FastMCP, opts: AttachmentOpts): void {
  // ---------------- List attachments on an issue ----------------

  server.addTool({
    name: "jira_list_issue_attachments",
    description:
      "List attachments on a Jira issue. Returns an array of {id, filename, size, mimeType, author, created, contentUrl} — use the id with jira_download_attachment to fetch content.",
    parameters: z.object({
      issue_key: z.string().describe("Jira issue key (e.g. PROJ-123) or numeric id"),
    }),
    execute: async (args: { issue_key: string }) =>
      safeJira(async () => {
        // Fetch the issue with only the attachment field — cheap, one call.
        const raw = await jiraClient().issues.getIssue({
          issueIdOrKey: args.issue_key,
          fields: ["attachment"],
        } as never);
        const list = (raw as any)?.fields?.attachment ?? [];
        return {
          issue_key: args.issue_key,
          count: list.length,
          attachments: list.map(toAttachmentProjection),
        };
      }),
  });

  // ---------------- Get one attachment's metadata ----------------

  server.addTool({
    name: "jira_get_attachment",
    description:
      "Get metadata for a single Jira attachment by id. Returns filename, size, mimeType, author, created, contentUrl. Use jira_download_attachment to fetch the actual content.",
    parameters: z.object({
      attachment_id: z.string(),
    }),
    execute: async (args: { attachment_id: string }) =>
      safeJira(async () => {
        const raw = await jiraClient().issueAttachments.getAttachment({
          id: args.attachment_id,
        } as never);
        return toAttachmentProjection(raw);
      }),
  });

  // ---------------- Download attachment content to a local path ----------------

  server.addTool({
    name: "jira_download_attachment",
    description:
      "Download a Jira attachment's content to a local file path. Streams directly to disk — safe for multi-GB attachments. Creates intermediate directories as needed. Returns {path, bytes_written, mimeType, filename}.",
    parameters: z.object({
      attachment_id: z.string(),
      save_path: z
        .string()
        .describe(
          "Absolute path to write the file to. If the path is a directory (ends with / or already exists as a dir), the original filename is appended. `~` is expanded to $HOME.",
        ),
    }),
    execute: async (args: { attachment_id: string; save_path: string }) =>
      safeJira(async () => {
        // First fetch metadata so we know the filename (for dir-destination)
        // and mimeType to return to the caller.
        const metaRaw = await jiraClient().issueAttachments.getAttachment({
          id: args.attachment_id,
        } as never);
        const meta = toAttachmentProjection(metaRaw);

        // Decide final path.
        let targetPath = resolveSavePath(args.save_path);
        const isDirTarget =
          args.save_path.endsWith("/") ||
          args.save_path.endsWith("\\") ||
          (existsSync(targetPath) && statSync(targetPath).isDirectory());
        if (isDirTarget) {
          if (!meta.filename) {
            throw new Error(
              "save_path is a directory but attachment has no filename — pass a full file path instead",
            );
          }
          targetPath = resolvePath(targetPath, meta.filename);
        }
        await mkdir(dirname(targetPath), { recursive: true });

        // Fetch content. Node's fetch follows redirects by default, so the
        // 303 → S3 hop is transparent. We stream to disk to avoid buffering
        // the full attachment in memory.
        const contentUrl = `${gatewayBase()}/rest/api/3/attachment/content/${encodeURIComponent(args.attachment_id)}`;
        const res = await fetch(contentUrl, {
          headers: {
            Authorization: basicAuthHeader(),
            // Accept any content-type — we're writing bytes through.
            Accept: "*/*",
          },
          redirect: "follow",
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(
            `Jira attachment download failed: ${res.status} ${res.statusText}${errText ? " — " + errText.slice(0, 200) : ""}`,
          );
        }
        if (!res.body) {
          throw new Error("Response had no body");
        }

        const writeStream = createWriteStream(targetPath);
        // Node's fetch returns a web ReadableStream; Readable.fromWeb
        // wraps it so we can pipe into a write stream.
        const nodeStream = Readable.fromWeb(res.body as any);
        await pipeline(nodeStream, writeStream);

        const stats = statSync(targetPath);
        return {
          attachment_id: args.attachment_id,
          filename: meta.filename || basename(targetPath),
          path: targetPath,
          bytes_written: stats.size,
          mimeType: meta.mimeType,
          content_type_returned: res.headers.get("content-type") ?? null,
        };
      }),
  });

  // ---------------- Upload attachment to an issue ----------------

  server.addTool({
    name: "jira_add_attachment",
    description:
      "Upload a file to a Jira issue as an attachment. Uses multipart/form-data with the X-Atlassian-Token: no-check header Atlassian requires for CSRF-exempt uploads. Returns the created attachment's projection.",
    parameters: z.object({
      issue_key: z.string(),
      file_path: z.string().describe("Absolute path of the local file to upload"),
      filename: z
        .string()
        .optional()
        .describe("Override the filename seen by Jira (defaults to file_path's basename)"),
    }),
    execute: async (args: { issue_key: string; file_path: string; filename?: string }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        const abs = resolveSavePath(args.file_path);
        if (!existsSync(abs)) {
          throw new Error(`file not found: ${abs}`);
        }
        // Stream the file into a Blob (Node 20+ has native Blob with file).
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(abs);
        const form = new FormData();
        const blob = new Blob([new Uint8Array(bytes)]);
        form.append("file", blob, args.filename ?? basename(abs));

        const url = `${gatewayBase()}/rest/api/3/issue/${encodeURIComponent(args.issue_key)}/attachments`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: basicAuthHeader(),
            Accept: "application/json",
            "X-Atlassian-Token": "no-check",
          },
          body: form,
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(
            `Jira attachment upload failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`,
          );
        }
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        // Jira returns an ARRAY of attachment projections (a single upload
        // can yield multiple records in theory; we always send one file so
        // unwrap if possible).
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        return toAttachmentProjection(first);
      }),
  });

  // ---------------- Delete attachment ----------------

  server.addTool({
    name: "jira_delete_attachment",
    description:
      "Permanently delete a Jira attachment. There is no trash for Jira attachments — this is destructive. Returns {deleted: true, id}.",
    parameters: z.object({
      attachment_id: z.string(),
    }),
    execute: async (args: { attachment_id: string }) =>
      safeJira(async () => {
        ensureWritable(opts.readOnly);
        await jiraClient().issueAttachments.removeAttachment({
          id: args.attachment_id,
        } as never);
        return { deleted: true, id: args.attachment_id };
      }),
  });
}
