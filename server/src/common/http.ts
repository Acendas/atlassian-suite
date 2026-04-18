// Minimal Bitbucket HTTP client. Jira and Confluence use jira.js / confluence.js;
// only Bitbucket needs raw fetch since no mature typed client exists.

import type { BitbucketConfig } from "./config.js";

export class BitbucketHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "BitbucketHttpError";
  }
}

export interface BitbucketHttp {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export function createBitbucketHttp(cfg: BitbucketConfig): BitbucketHttp {
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString("base64");

  const buildUrl = (
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string => {
    const url = new URL(path.startsWith("http") ? path : `${cfg.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> => {
    const url = buildUrl(path, query);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON response (e.g. raw diff). Pass through as string.
      }
    }
    if (!res.ok) {
      throw new BitbucketHttpError(
        res.status,
        res.statusText,
        parsed,
        `Bitbucket ${method} ${path} failed: ${res.status} ${res.statusText}`,
      );
    }
    return parsed as T;
  };

  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),
  };
}
