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

  const doFetch = async <T>(
    method: string,
    path: string,
    init: RequestInit,
    query: Query | undefined,
  ): Promise<T> => {
    const url = buildUrl(path, query);
    const res = await fetch(url, init);
    const text = await res.text();
    const parsed = parseBody(text);
    if (!res.ok) {
      throw new AtlassianHttpError(
        res.status,
        res.statusText,
        parsed,
        `${label} ${method} ${path} failed: ${res.status} ${res.statusText}`,
      );
    }
    return parsed as T;
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
