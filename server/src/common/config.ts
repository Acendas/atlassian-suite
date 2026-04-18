// Unified configuration for Jira, Confluence, and Bitbucket Cloud.
// Resolution order for every value:
//   1. Per-product env var (e.g. JIRA_USERNAME)
//   2. Shared env var (e.g. ATLASSIAN_USERNAME)
//   3. Per-product entry in ~/.acendas-atlassian/config.json (e.g. jira.username)
//   4. Shared entry in the file (e.g. atlassian.username)
//   5. undefined → product treated as not configured

import { getStoredString, getStoredStringArray } from "./credStore.js";

export interface AtlassianCreds {
  username: string;
  apiToken: string;
}

export interface JiraConfig extends AtlassianCreds {
  baseUrl: string;
  projectsFilter?: string[];
}

export interface ConfluenceConfig extends AtlassianCreds {
  baseUrl: string;
  spacesFilter?: string[];
}

export interface BitbucketConfig extends AtlassianCreds {
  workspace: string;
  baseUrl: string;
}

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
};

const envCsv = (name: string): string[] | undefined => {
  const raw = env(name);
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
};

const resolveString = (
  productEnv: string,
  sharedEnv: string,
  productPath: string[],
  sharedPath: string[],
): string | undefined =>
  env(productEnv) ?? env(sharedEnv) ?? getStoredString(productPath, sharedPath);

export function loadJiraConfig(): JiraConfig | null {
  const baseUrl = env("JIRA_URL") ?? getStoredString(["jira", "url"]);
  if (!baseUrl) return null;
  const username = resolveString("JIRA_USERNAME", "ATLASSIAN_USERNAME", ["jira", "username"], ["atlassian", "username"]);
  const apiToken = resolveString("JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN", ["jira", "api_token"], ["atlassian", "api_token"]);
  if (!username || !apiToken) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    username,
    apiToken,
    projectsFilter:
      envCsv("JIRA_PROJECTS_FILTER") ?? getStoredStringArray(["jira", "projects_filter"]),
  };
}

export function loadConfluenceConfig(): ConfluenceConfig | null {
  const baseUrl = env("CONFLUENCE_URL") ?? getStoredString(["confluence", "url"]);
  if (!baseUrl) return null;
  const username = resolveString(
    "CONFLUENCE_USERNAME",
    "ATLASSIAN_USERNAME",
    ["confluence", "username"],
    ["atlassian", "username"],
  );
  const apiToken = resolveString(
    "CONFLUENCE_API_TOKEN",
    "ATLASSIAN_API_TOKEN",
    ["confluence", "api_token"],
    ["atlassian", "api_token"],
  );
  if (!username || !apiToken) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    username,
    apiToken,
    spacesFilter:
      envCsv("CONFLUENCE_SPACES_FILTER") ?? getStoredStringArray(["confluence", "spaces_filter"]),
  };
}

export function loadBitbucketConfig(): BitbucketConfig | null {
  const workspace = env("BITBUCKET_WORKSPACE") ?? getStoredString(["bitbucket", "workspace"]);
  if (!workspace) return null;
  const username = resolveString(
    "BITBUCKET_USERNAME",
    "ATLASSIAN_USERNAME",
    ["bitbucket", "username"],
    ["atlassian", "username"],
  );
  const apiToken = resolveString(
    "BITBUCKET_API_TOKEN",
    "ATLASSIAN_API_TOKEN",
    ["bitbucket", "api_token"],
    ["atlassian", "api_token"],
  );
  if (!username || !apiToken) return null;
  return {
    baseUrl: "https://api.bitbucket.org/2.0",
    workspace,
    username,
    apiToken,
  };
}

export const isReadOnly = (): boolean =>
  ["true", "1", "yes"].includes((env("READ_ONLY_MODE") ?? "").toLowerCase());
