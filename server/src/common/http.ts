// Shared Atlassian HTTP core.
//
// Generic Basic-auth + JSON fetch wrapper used by Bitbucket, Confluence v1,
// Confluence v2, and anything else that talks to api.atlassian.com with a
// scoped token. Bitbucket originally had its own client; we now generalize
// so all three products share one retry/auth/error surface. The
// BitbucketHttp / BitbucketHttpError aliases below preserve the original
// type names so Bitbucket call sites need no edit.
//
// Design notes:
//  - JSON-first: get/post/put/delete serialize JSON bodies and Accept JSON.
//    For multipart (Confluence attachment upload), use `postMultipart`
//    which leaves Content-Type/body alone and adds `X-Atlassian-Token`.
//  - Non-JSON responses (raw diffs, XML) pass through as string so callers
//    can parse. 404/5xx throw AtlassianHttpError with the parsed body.
//  - We do NOT retry here. 429/5xx caller-facing retry belongs in the
//    tool layer once we've observed real-world rates.
//  - Path can be relative (prepend baseUrl) or absolute (used verbatim —
//    follows `_links.next`-style cursor URLs that are absolute).

import type { BitbucketConfig } from "./config.js";

export class AtlassianHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "AtlassianHttpError";
  }
}

// Back-compat alias. Bitbucket code imports BitbucketHttpError.
export const BitbucketHttpError = AtlassianHttpError;

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface AtlassianHttp {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown, query?: Query): Promise<T>;
  put<T>(path: string, body?: unknown, query?: Query): Promise<T>;
  delete<T>(path: string, query?: Query): Promise<T>;
  /** Multipart form upload — no JSON serialization. Automatically sets
   *  `X-Atlassian-Token: no-check` which Confluence requires for
   *  CSRF-exempt multipart attachment POSTs. */
  postMultipart<T>(path: string, form: FormData, query?: Query): Promise<T>;
  /** Escape hatch for callers that need full control (custom headers,
   *  raw body types). Prefer the helpers above. */
  request<T>(method: string, path: string, opts?: {
    body?: unknown;
    bodyRaw?: RequestInit["body"];
    query?: Query;
    headers?: Record<string, string>;
  }): Promise<T>;
}

// Back-compat alias.
export type BitbucketHttp = AtlassianHttp;

export interface CreateAtlassianHttpOpts {
  baseUrl: string;
  username: string;
  apiToken: string;
  /** Human-readable name used in error messages and the default User-Agent. */
  productLabel?: string;
}

export function createAtlassianHttp(opts: CreateAtlassianHttpOpts): AtlassianHttp {
  const { baseUrl, username, apiToken } = opts;
  const label = opts.productLabel ?? "Atlassian";
  const authHeader =
    "Basic " + Buffer.from(`${username}:${apiToken}`).toString("base64");

  const buildUrl = (path: string, query?: Query): string => {
    const url = new URL(path.startsWith("http") ? path : `${baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  };

  const parseBody = (text: string): unknown => {
    if (text.length === 0) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  // Rate-limit / transient-error retry policy.
  //
  // Atlassian can return 429 with a Retry-After header (seconds or
  // HTTP-date) when we hit rate limits, and transient 502/503/504 on
  // gateway hiccups. Without retries, a heavy /review-pr session that
  // fans out 6-12 parallel scanner calls against one tenant can start
  // failing half its tools. The retry policy here:
  //
  //   - retryable status codes: 429, 502, 503, 504
  //   - honors Retry-After if present (seconds OR HTTP-date)
  //   - otherwise exponential backoff starting at 400ms, doubling,
  //     capped at 8s per attempt
  //   - max 3 retries (so up to 4 total attempts)
  //   - non-retryable statuses (auth, scope, not-found, validation)
  //     throw immediately — retrying won't help
  //
  // We do NOT retry non-idempotent methods (POST/PUT/PATCH/DELETE) on
  // 5xx by default — at-most-once semantics matters more than best-
  // effort delivery for writes. 429 we DO retry on all methods since
  // the request didn't reach the handler.
  const RETRYABLE = new Set([429, 502, 503, 504]);
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 400;
  const CAP_DELAY_MS = 8_000;

  const parseRetryAfter = (headerVal: string | null): number | null => {
    if (!headerVal) return null;
    const asNum = Number(headerVal);
    if (Number.isFinite(asNum)) return Math.max(0, asNum) * 1000;
    const asDate = Date.parse(headerVal);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
    return null;
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const isIdempotent = (method: string): boolean =>
    method === "GET" || method === "HEAD" || method === "OPTIONS";

  const doFetch = async <T>(
    method: string,
    path: string,
    init: RequestInit,
    query: Query | undefined,
  ): Promise<T> => {
    const url = buildUrl(path, query);
    let lastErr: AtlassianHttpError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, init);
      const text = await res.text();
      const parsed = parseBody(text);
      if (res.ok) return parsed as T;

      const err = new AtlassianHttpError(
        res.status,
        res.statusText,
        parsed,
        `${label} ${method} ${path} failed: ${res.status} ${res.statusText}`,
      );
      lastErr = err;

      // Don't retry on non-retryable status codes.
      if (!RETRYABLE.has(res.status)) throw err;
      // Don't retry 5xx on non-idempotent writes — the request may have
      // been partially applied. 429 is always safe to retry since the
      // request didn't reach the handler.
      if (res.status !== 429 && !isIdempotent(method)) throw err;
      // Out of retries?
      if (attempt === MAX_RETRIES) throw err;

      // Compute delay: Retry-After wins if present; otherwise exponential
      // backoff with mild jitter (±25%) to avoid thundering-herd.
      const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
      const expMs = Math.min(BASE_DELAY_MS * 2 ** attempt, CAP_DELAY_MS);
      const jittered = expMs * (0.75 + Math.random() * 0.5);
      const delay = retryAfterMs != null ? retryAfterMs : jittered;
      await sleep(delay);
    }
    // Unreachable: loop either returns or throws.
    throw lastErr!;
  };

  const request = <T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      bodyRaw?: RequestInit["body"];
      query?: Query;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> => {
    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: "application/json",
      ...opts.headers,
    };
    let body: RequestInit["body"];
    if (opts.bodyRaw !== undefined) {
      body = opts.bodyRaw;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    return doFetch<T>(method, path, { method, headers, body }, opts.query);
  };

  return {
    get: (path, query) => request("GET", path, { query }),
    post: (path, body, query) => request("POST", path, { body, query }),
    put: (path, body, query) => request("PUT", path, { body, query }),
    delete: (path, query) => request("DELETE", path, { query }),
    postMultipart: (path, form, query) =>
      request("POST", path, {
        bodyRaw: form,
        headers: { "X-Atlassian-Token": "no-check" },
        query,
      }),
    request,
  };
}

// Back-compat shim for existing Bitbucket call sites. Delegates to the
// generic core.
export function createBitbucketHttp(cfg: BitbucketConfig): AtlassianHttp {
  return createAtlassianHttp({
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    apiToken: cfg.apiToken,
    productLabel: "Bitbucket",
  });
}
