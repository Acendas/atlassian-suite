// Shared Confluence error normalization.
//
// Atlassian's scoped-token 401s come with body
//   {"code":401,"message":"Unauthorized; scope does not match"}
// and header `x-failure-category: FAILURE_CLIENT_SCOPE_CHECK` — distinct
// from a true auth failure. 404s can mean URL drift OR a valid endpoint
// with no such resource. 429s carry a Retry-After.
//
// Surface these as typed categories so tools can give actionable errors
// ("you're missing read:page:confluence") instead of generic "401 failed".

import { AtlassianHttpError } from "./http.js";

export type ConfluenceErrorKind =
  | "scope-missing"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "server-error"
  | "bad-request"
  | "unknown";

export interface ConfluenceErrorInfo {
  kind: ConfluenceErrorKind;
  status: number;
  message: string;
  /** Original parsed response body, may be useful upstream. */
  body: unknown;
}

/** Pattern Atlassian emits on missing-scope 401 for both v1 and v2. */
const SCOPE_MATCH_RE = /scope\s+does\s+not\s+match/i;

export function classifyConfluenceError(err: unknown): ConfluenceErrorInfo {
  if (!(err instanceof AtlassianHttpError)) {
    return {
      kind: "unknown",
      status: 0,
      message: err instanceof Error ? err.message : String(err),
      body: null,
    };
  }
  const bodyStr = typeof err.body === "string"
    ? err.body
    : JSON.stringify(err.body ?? "");
  const msg = extractAtlasMessage(err.body) ?? err.message;

  if (err.status === 401) {
    if (SCOPE_MATCH_RE.test(bodyStr)) {
      return {
        kind: "scope-missing",
        status: 401,
        message: `Missing scope for this endpoint: ${msg}`,
        body: err.body,
      };
    }
    return { kind: "unauthorized", status: 401, message: msg, body: err.body };
  }
  if (err.status === 403) return { kind: "forbidden", status: 403, message: msg, body: err.body };
  if (err.status === 404) return { kind: "not-found", status: 404, message: msg, body: err.body };
  if (err.status === 429) return { kind: "rate-limited", status: 429, message: msg, body: err.body };
  if (err.status >= 500) return { kind: "server-error", status: err.status, message: msg, body: err.body };
  if (err.status === 400 || err.status === 422) {
    return { kind: "bad-request", status: err.status, message: msg, body: err.body };
  }
  return { kind: "unknown", status: err.status, message: msg, body: err.body };
}

function extractAtlasMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 200);
  if (typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // v2: {code, message}
  if (typeof b.message === "string") return b.message;
  // v1: {errorMessages: [...]}
  if (Array.isArray(b.errorMessages) && b.errorMessages.length > 0) {
    return String(b.errorMessages[0]);
  }
  // v1 validation: {data:{errors:[{message:{key, translation?}}]}}
  const data = b.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0] as Record<string, unknown>;
    const m = first?.message as Record<string, unknown> | string | undefined;
    if (typeof m === "string") return m;
    if (m && typeof m === "object") {
      if (typeof m.translation === "string") return m.translation;
      if (typeof m.key === "string") return m.key;
    }
  }
  return null;
}

/** Turn any thrown value into a human-friendly string (for MCP tool error
 *  responses). Preserves kind info via a prefix. */
export function formatConfluenceError(err: unknown): string {
  const info = classifyConfluenceError(err);
  const prefix = info.kind === "scope-missing" ? "[scope-missing]" : `[${info.kind}]`;
  return `${prefix} ${info.message}`;
}
