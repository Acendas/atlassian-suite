// File-backed credential store at ~/.acendas-atlassian/config.json (mode 0600).
// Layered under env vars: env > file > undefined.
//
// Safety guarantees on write:
//   1. Atomic: writes to config.json.tmp + rename, so a crash mid-write can't
//      produce a truncated or partially-written config.
//   2. Backed up: the previous file is copied to config.json.bak before each write.
//      Recover by renaming .bak → .json.
//   3. Mode-preserving: dir 0700, file 0600, chmod'd explicitly after every write.
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
  renameSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR_PATH = join(homedir(), ".acendas-atlassian");
export const CONFIG_FILE_PATH = join(CONFIG_DIR_PATH, "config.json");
export const CONFIG_BACKUP_PATH = join(CONFIG_DIR_PATH, "config.json.bak");
const TMP_PATH = join(CONFIG_DIR_PATH, "config.json.tmp");

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

/**
 * Atomic write with rolling backup.
 * Order of operations:
 *   1. Ensure dir exists (mode 0700).
 *   2. If an existing config file is present, copy it to .bak.
 *   3. Write the new content to .tmp (mode 0600).
 *   4. fsync the temp file.
 *   5. Rename .tmp → config.json (atomic on POSIX).
 *   6. Update in-memory cache.
 * Any crash between steps leaves either the original file intact (steps 1–4) or
 * the new file in place (step 5). The .bak always holds the prior state.
 */
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

  // Step 2: rotate backup from previous on-disk version (if any).
  if (existsSync(CONFIG_FILE_PATH)) {
    try {
      copyFileSync(CONFIG_FILE_PATH, CONFIG_BACKUP_PATH);
      chmodSync(CONFIG_BACKUP_PATH, 0o600);
    } catch {
      // Best effort — don't block the write on backup failure, but log to stderr.
      console.error("[acendas-atlassian] WARN: failed to back up credentials file before write.");
    }
  }

  // Step 3: write + fsync to temp file.
  const json = JSON.stringify(creds, null, 2) + "\n";
  writeFileSync(TMP_PATH, json, { mode: 0o600 });
  try {
    const fd = openSync(TMP_PATH, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // fsync is a hardening belt-and-suspenders; rename still works without it.
  }

  // Step 5: atomic swap.
  renameSync(TMP_PATH, CONFIG_FILE_PATH);
  chmodSync(CONFIG_FILE_PATH, 0o600);

  cached = creds;
}

export function clearStoredCreds(): void {
  cached = null;
  if (existsSync(CONFIG_FILE_PATH)) {
    // Rotate the backup one last time on deletion so the user can recover.
    try {
      copyFileSync(CONFIG_FILE_PATH, CONFIG_BACKUP_PATH);
      chmodSync(CONFIG_BACKUP_PATH, 0o600);
    } catch {
      // Best effort
    }
    unlinkSync(CONFIG_FILE_PATH);
  }
}

/**
 * Deep-merge helper for StoredCreds: returns a new object where values from
 * `patch` override `base`, but undefined/null/empty-string values in `patch`
 * are IGNORED (they never clobber existing values). Array values in `patch`
 * replace arrays in `base` (not merge) — the caller controls filter sets.
 */
export function mergeCreds(base: StoredCreds, patch: StoredCreds): StoredCreds {
  const result: StoredCreds = JSON.parse(JSON.stringify(base));
  for (const section of ["atlassian", "jira", "confluence", "bitbucket"] as const) {
    const src = (patch as any)[section];
    if (!src) continue;
    const dst = ((result as any)[section] ??= {});
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.length === 0) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      dst[key] = value;
    }
  }
  return result;
}

/** Diff two StoredCreds objects; returns field paths that changed. */
export function diffCreds(
  before: StoredCreds,
  after: StoredCreds,
): { added: string[]; updated: string[]; preserved: string[] } {
  const added: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];
  for (const section of ["atlassian", "jira", "confluence", "bitbucket"] as const) {
    const b = ((before as any)[section] ?? {}) as Record<string, unknown>;
    const a = ((after as any)[section] ?? {}) as Record<string, unknown>;
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const key of keys) {
      const path = `${section}.${key}`;
      const before_v = b[key];
      const after_v = a[key];
      const beforeEmpty = before_v === undefined || before_v === null || before_v === "";
      const afterEmpty = after_v === undefined || after_v === null || after_v === "";
      if (beforeEmpty && !afterEmpty) added.push(path);
      else if (!beforeEmpty && !afterEmpty && JSON.stringify(before_v) !== JSON.stringify(after_v))
        updated.push(path);
      else if (!beforeEmpty && afterEmpty) updated.push(path + " (cleared)");
      else if (!beforeEmpty) preserved.push(path);
    }
  }
  return { added, updated, preserved };
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

/** True if a .bak exists alongside the main config. */
export function hasBackup(): boolean {
  return existsSync(CONFIG_BACKUP_PATH);
}
