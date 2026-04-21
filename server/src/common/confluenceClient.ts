// Lazy singleton Confluence clients — v2 (primary) + v1 (fallback only).
//
// Tools import `confluenceV2()` for modern endpoints; `confluenceV1()` is
// used only for the handful of operations v2 doesn't expose (see
// confluenceHttp.ts for the list). Both clients share the same underlying
// credentials + gateway routing resolved by loadConfluenceConfig.

import { loadConfluenceConfig, type ConfluenceConfig } from "./config.js";
import {
  createConfluenceV1Http,
  createConfluenceV2Http,
} from "./confluenceHttp.js";
import type { AtlassianHttp } from "./http.js";

let cachedV1: AtlassianHttp | null = null;
let cachedV2: AtlassianHttp | null = null;
let cachedCfg: ConfluenceConfig | null = null;

function getCfg(): ConfluenceConfig {
  if (!cachedCfg) {
    const cfg = loadConfluenceConfig();
    if (!cfg) {
      throw new Error(
        "Confluence not configured. Set CONFLUENCE_URL plus CONFLUENCE_USERNAME + " +
          "CONFLUENCE_API_TOKEN (or ATLASSIAN_USERNAME + ATLASSIAN_API_TOKEN). " +
          "Run `/atlassian-suite:init` to configure.",
      );
    }
    cachedCfg = cfg;
  }
  return cachedCfg;
}

export function confluenceV2(): AtlassianHttp {
  if (cachedV2) return cachedV2;
  cachedV2 = createConfluenceV2Http(getCfg());
  return cachedV2;
}

export function confluenceV1(): AtlassianHttp {
  if (cachedV1) return cachedV1;
  cachedV1 = createConfluenceV1Http(getCfg());
  return cachedV1;
}

export function confluenceIsConfigured(): boolean {
  return loadConfluenceConfig() !== null;
}

export function confluenceSpacesFilter(): string[] | undefined {
  return getCfg().spacesFilter;
}

/** Reset the cached clients. Test hook only — not used at runtime. */
export function __resetConfluenceClients(): void {
  cachedV1 = null;
  cachedV2 = null;
  cachedCfg = null;
}
