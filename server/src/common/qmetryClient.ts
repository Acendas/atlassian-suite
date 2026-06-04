// QMetry HTTP client — completely separate from the Atlassian HTTP stack.
//
// QMetry authenticates with a single custom header:
//   apiKey: <key>
//
// There is NO Authorization header, no Basic auth, no Bearer token.
// This file intentionally does NOT import createAtlassianHttp or any
// Atlassian credential path — structural guarantee that Atlassian credentials
// can never leak into QMetry requests.

import type { AtlassianHttp, AtlassianHttpError, Query } from "./http.js";
import { loadQMetryConfig } from "./config.js";
import type { QMetryConfig } from "./config.js";

export { AtlassianHttpError as QMetryHttpError };

export function createQMetryHttp(opts: {
  baseUrl: string;
  apiKey: string;
  productLabel?: string;
}): AtlassianHttp {
  const { baseUrl, apiKey } = opts;
  const label = opts.productLabel ?? "QMetry";

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

  // Same retry policy as the Atlassian client: 429/502/503/504, max 3 retries,
  // exponential backoff 400ms → 8s, honors Retry-After.
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
    const { AtlassianHttpError } = await import("./http.js");
    const url = buildUrl(path, query);
    let lastErr: InstanceType<typeof AtlassianHttpError> | null = null;
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

      if (!RETRYABLE.has(res.status)) throw err;
      if (res.status !== 429 && !isIdempotent(method)) throw err;
      if (attempt === MAX_RETRIES) throw err;

      const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
      const expMs = Math.min(BASE_DELAY_MS * 2 ** attempt, CAP_DELAY_MS);
      const jittered = expMs * (0.75 + Math.random() * 0.5);
      const delay = retryAfterMs != null ? retryAfterMs : jittered;
      await sleep(delay);
    }
    throw lastErr!;
  };

  const request = <T>(
    method: string,
    path: string,
    reqOpts: {
      body?: unknown;
      bodyRaw?: RequestInit["body"];
      query?: Query;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> => {
    const headers: Record<string, string> = {
      apiKey,
      Accept: "application/json",
      ...reqOpts.headers,
    };
    let body: RequestInit["body"];
    if (reqOpts.bodyRaw !== undefined) {
      body = reqOpts.bodyRaw;
    } else if (reqOpts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(reqOpts.body);
    }
    return doFetch<T>(method, path, { method, headers, body }, reqOpts.query);
  };

  return {
    get: (path, query) => request("GET", path, { query }),
    post: (path, body, query) => request("POST", path, { body, query }),
    put: (path, body, query) => request("PUT", path, { body, query }),
    delete: (path, query) => request("DELETE", path, { query }),
    postMultipart: (path, form, query) =>
      request("POST", path, { bodyRaw: form, query }),
    request,
  };
}

let cached: AtlassianHttp | null = null;
let cachedConfig: QMetryConfig | null = null;

export function qmetryClient(): AtlassianHttp {
  const cfg = loadQMetryConfig();
  if (!cfg) throw new Error("QMetry is not configured. Run /atlassian-suite:init to set up your QMetry API key.");
  // Re-create if config changed.
  if (!cached || cachedConfig?.apiKey !== cfg.apiKey || cachedConfig?.baseUrl !== cfg.baseUrl) {
    cached = createQMetryHttp({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, productLabel: "QMetry" });
    cachedConfig = cfg;
  }
  return cached;
}

export function qmetryIsConfigured(): boolean {
  return loadQMetryConfig() !== null;
}
