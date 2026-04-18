// File-backed credential store at ~/.acendas-atlassian/config.json (mode 0600).
// Layered under env vars: env > file > undefined.
//
// Schema:
//   {
//     "atlassian":  { "username": "...", "api_token": "..." },     // shared fallback
//     "jira":       { "url": "...", "username": "...", "api_token": "...", "projects_filter": [...] },
//     "confluence": { "url": "...", "username": "...", "api_token": "...", "spaces_filter": [...] },
//     "bitbucket":  { "workspace": "...", "username": "...", "api_token": "..." }
//   }
//
// Per-product fields override the shared `atlassian.*` fallback for that product.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR_PATH = join(homedir(), ".acendas-atlassian");
export const CONFIG_FILE_PATH = join(CONFIG_DIR_PATH, "config.json");

export interface StoredCreds {
  atlassian?: { username?: string; api_token?: string };
  jira?: {
    url?: string;
    username?: string;
    api_token?: string;
    projects_filter?: string[];
  };
  confluence?: {
    url?: string;
    username?: string;
    api_token?: string;
    spaces_filter?: string[];
  };
  bitbucket?: { workspace?: string; username?: string; api_token?: string };
}

let cached: StoredCreds | null = null;

export function loadStoredCreds(): StoredCreds {
  if (cached !== null) return cached;
  if (!existsSync(CONFIG_FILE_PATH)) {
    cached = {};
    return cached;
  }
  try {
    cached = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8")) as StoredCreds;
  } catch {
    cached = {};
  }
  return cached;
}

export function reloadStoredCreds(): StoredCreds {
  cached = null;
  return loadStoredCreds();
}

export function saveStoredCreds(creds: StoredCreds): void {
  if (!existsSync(CONFIG_DIR_PATH)) {
    mkdirSync(CONFIG_DIR_PATH, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(CONFIG_DIR_PATH, 0o700);
    } catch {
      // Best effort
    }
  }
  writeFileSync(CONFIG_FILE_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE_PATH, 0o600);
  cached = creds;
}

export function clearStoredCreds(): void {
  cached = null;
  if (existsSync(CONFIG_FILE_PATH)) {
    unlinkSync(CONFIG_FILE_PATH);
  }
}

/** Look up a string value by trying each path-of-keys in order. */
export function getStoredString(...paths: string[][]): string | undefined {
  const creds = loadStoredCreds();
  for (const path of paths) {
    let cur: any = creds;
    for (const k of path) {
      cur = cur?.[k];
      if (cur === undefined || cur === null) break;
    }
    if (typeof cur === "string" && cur.length > 0) return cur;
  }
  return undefined;
}

/** Look up a string array (e.g. projects_filter). */
export function getStoredStringArray(...paths: string[][]): string[] | undefined {
  const creds = loadStoredCreds();
  for (const path of paths) {
    let cur: any = creds;
    for (const k of path) {
      cur = cur?.[k];
      if (cur === undefined || cur === null) break;
    }
    if (Array.isArray(cur)) {
      const arr = cur.filter((s: unknown) => typeof s === "string") as string[];
      if (arr.length > 0) return arr;
    }
  }
  return undefined;
}

/** Mask a token for display: keep first 4 + last 4 chars. */
export function maskToken(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`;
}

/** Permission audit on the file — useful for the status tool. */
export function configFileMode(): string | null {
  if (!existsSync(CONFIG_FILE_PATH)) return null;
  try {
    const st = statSync(CONFIG_FILE_PATH);
    return "0" + (st.mode & 0o777).toString(8);
  } catch {
    return null;
  }
}
