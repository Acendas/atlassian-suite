// Shared helpers for QMetry tool modules.

import { maskToken } from "../common/credStore.js";

// Fields that are always noise for users — internal bookkeeping, CDN tokens, etc.
const STRIP_KEYS = new Set([
  "iconUrl",          // CDN URLs with signed tokens — huge, meaningless to users
  "avatarUrl",        // same
  "isArchive",        // internal archival flag
  "testcase_version_id", // internal join-table key on step rows
  "shareable",        // internal flag (cross-project sharing)
]);

// Named-value sub-objects (have a `name` field that IS the display value).
// Stripping their internal numeric `id` keeps the response clean.
const NAMED_VALUE_KEYS = new Set(["priority", "status", "issuetype", "assignee", "reporter"]);

/**
 * Strip internal noise from QMetry API responses before surfacing to the user.
 * Rules:
 *   1. Remove any key in STRIP_KEYS anywhere in the tree.
 *   2. For named-value sub-objects (priority, status, etc.) remove their internal `id`.
 *   3. Remove any string value that looks like a CDN/signed URL (>200 chars, starts https://).
 */
function stripInternalFields(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripInternalFields(v));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // Drop known noise keys.
      if (STRIP_KEYS.has(k)) continue;
      // Drop internal numeric `id` on named-value sub-objects.
      if (k === "id" && parentKey && NAMED_VALUE_KEYS.has(parentKey)) continue;
      // Drop CDN signed URLs (very long https strings — not useful to display).
      if (typeof v === "string" && v.startsWith("https://") && v.length > 200) continue;
      out[k] = stripInternalFields(v, k);
    }
    return out;
  }
  return value;
}

export async function safeQMetry<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(stripInternalFields(result), null, 2);
  } catch (err: any) {
    if (err?.name === "AtlassianHttpError") {
      const body = err.body;
      // QMetry error envelope: { status, errorMessage, errors: string[], timestamp }
      const message =
        (typeof body === "object" && body !== null && "errorMessage" in body)
          ? (body as any).errorMessage
          : err.message;
      const errors =
        (typeof body === "object" && body !== null && Array.isArray((body as any).errors))
          ? (body as any).errors
          : undefined;
      return JSON.stringify(
        {
          error: true,
          status: err.status,
          message,
          errors: errors ?? null,
          body: sanitizeErrorBody(body),
        },
        null,
        2,
      );
    }
    return JSON.stringify({ error: true, message: err?.message ?? String(err) }, null, 2);
  }
}

export function ensureWritable(readOnly: boolean): void {
  if (readOnly) throw new Error("READ_ONLY_MODE is enabled — write operations are blocked.");
}

function sanitizeErrorBody(body: unknown): unknown {
  if (typeof body === "string" && body.length > 50 && !body.includes(" ")) {
    return maskToken(body);
  }
  if (typeof body === "object" && body !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = sanitizeErrorBody(v);
    }
    return out;
  }
  return body;
}
