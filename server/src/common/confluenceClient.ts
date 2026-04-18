// Lazy singleton Confluence client (confluence.js — Cloud REST v1+v2).

import { ConfluenceClient } from "confluence.js";
import { loadConfluenceConfig, type ConfluenceConfig } from "./config.js";

let cached: ConfluenceClient | null = null;
let cachedCfg: ConfluenceConfig | null = null;

function getCfg(): ConfluenceConfig {
  if (!cachedCfg) {
    const cfg = loadConfluenceConfig();
    if (!cfg) {
      throw new Error(
        "Confluence not configured. Set CONFLUENCE_URL plus CONFLUENCE_USERNAME + " +
          "CONFLUENCE_API_TOKEN (or ATLASSIAN_USERNAME + ATLASSIAN_API_TOKEN).",
      );
    }
    cachedCfg = cfg;
  }
  return cachedCfg;
}

export function confluenceClient(): ConfluenceClient {
  if (cached) return cached;
  const cfg = getCfg();
  cached = new ConfluenceClient({
    host: cfg.baseUrl,
    authentication: {
      basic: { email: cfg.username, apiToken: cfg.apiToken },
    },
  });
  return cached;
}

export function confluenceIsConfigured(): boolean {
  return loadConfluenceConfig() !== null;
}

export function confluenceSpacesFilter(): string[] | undefined {
  return getCfg().spacesFilter;
}
