// Lazy singleton Jira client (jira.js v3 — Cloud).

import { Version3Client, AgileClient } from "jira.js";
import { loadJiraConfig, type JiraConfig } from "./config.js";

let cachedClient: Version3Client | null = null;
let cachedAgile: AgileClient | null = null;
let cachedCfg: JiraConfig | null = null;

function getCfg(): JiraConfig {
  if (!cachedCfg) {
    const cfg = loadJiraConfig();
    if (!cfg) {
      throw new Error(
        "Jira not configured. Set JIRA_URL plus JIRA_USERNAME + JIRA_API_TOKEN " +
          "(or ATLASSIAN_USERNAME + ATLASSIAN_API_TOKEN as a fallback).",
      );
    }
    cachedCfg = cfg;
  }
  return cachedCfg;
}

export function jiraClient(): Version3Client {
  if (cachedClient) return cachedClient;
  const cfg = getCfg();
  cachedClient = new Version3Client({
    host: cfg.baseUrl,
    authentication: {
      basic: { email: cfg.username, apiToken: cfg.apiToken },
    },
  });
  return cachedClient;
}

export function jiraAgileClient(): AgileClient {
  if (cachedAgile) return cachedAgile;
  const cfg = getCfg();
  cachedAgile = new AgileClient({
    host: cfg.baseUrl,
    authentication: {
      basic: { email: cfg.username, apiToken: cfg.apiToken },
    },
  });
  return cachedAgile;
}

export function jiraIsConfigured(): boolean {
  return loadJiraConfig() !== null;
}

export function jiraProjectsFilter(): string[] | undefined {
  return getCfg().projectsFilter;
}
