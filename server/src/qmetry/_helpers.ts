// Shared helpers for QMetry tool modules.

import { maskToken } from "../common/credStore.js";

export async function safeQMetry<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
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
          // Sanitize body: mask any string value that looks like an API key
          // (length > 50, no spaces — same heuristic as Atlassian tokens).
          body: sanitizeBody(body),
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

function sanitizeBody(body: unknown): unknown {
  if (typeof body === "string" && body.length > 50 && !body.includes(" ")) {
    return maskToken(body);
  }
  if (typeof body === "object" && body !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = sanitizeBody(v);
    }
    return out;
  }
  return body;
}
