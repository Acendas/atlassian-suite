// Shared helpers for QMetry tool modules.

import { maskToken } from "../common/credStore.js";
import { qmetryClient } from "../common/qmetryClient.js";

/**
 * Resolve a QMetry metadata *name* (status / priority / label) to its numeric
 * id by reading a project-scoped lookup endpoint and matching on name.
 *
 * This exists because QMetry's WRITE schemas (create/update test case, cycle,
 * execution) take bare integer ids — `status: 231245`, `priority: 7`,
 * `labels: [12,13]` — even though the READ responses surface those same fields
 * as `{ id, name }` objects. Sending the read-shaped `{ name: "Pass" }` on a
 * write is silently dropped (or rejected), which is the whole class of bug that
 * made assignee/status/priority writes look like they worked but didn't. Agents
 * speak in names ("Pass", "High", "To Do"), so resolve here and send the id.
 *
 * `listPath` examples (all return an array — sometimes bare, sometimes under
 * a `data` envelope — of `{ id, name }`):
 *   /projects/{pid}/testcase-statuses   /projects/{pid}/testcycle-statuses
 *   /projects/{pid}/priorities          /projects/{pid}/labels
 *
 * Fails loud with the available names when no match — never silently omits.
 */
export async function resolveNamedId(
  listPath: string,
  name: string,
  kind: string,
): Promise<number> {
  const res = await qmetryClient().get<any>(listPath);
  const arr: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
  const match = arr.find(
    (r) => String(r?.name ?? r?.value ?? "").toLowerCase() === name.toLowerCase(),
  );
  if (!match || match.id == null) {
    const available = arr
      .map((r) => r?.name ?? r?.value)
      .filter((n) => n != null && n !== "")
      .join(", ");
    throw new Error(
      `Unknown ${kind} '${name}'${available ? `. Available: ${available}` : ""}.`,
    );
  }
  return Number(match.id);
}

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
