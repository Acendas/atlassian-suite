// Confluence v1 + v2 HTTP clients.
//
// Both are thin createAtlassianHttp wrappers. v2 is the primary surface
// (modern REST, granular scopes). v1 is kept for operations v2 lacks:
// CQL search, attachment upload, label add/remove, page copy, page move,
// watch/unwatch, version restore.
//
// Gateway URL notes:
//   cfg.baseUrl = https://api.atlassian.com/ex/confluence/{cloudId}/wiki
// so:
//   v1 base = baseUrl + /rest/api
//   v2 base = baseUrl + /api/v2
// Both BASE paths already carry `/wiki` from cfg.baseUrl. Tool call paths
// should begin with a bare leading slash (e.g. "/pages/{id}" for v2,
// "/content/{id}" for v1).

import type { ConfluenceConfig } from "./config.js";
import { createAtlassianHttp, type AtlassianHttp } from "./http.js";

/** v2 REST client — modern surface, granular scopes. */
export function createConfluenceV2Http(cfg: ConfluenceConfig): AtlassianHttp {
  return createAtlassianHttp({
    baseUrl: `${cfg.baseUrl}/api/v2`,
    username: cfg.username,
    apiToken: cfg.apiToken,
    productLabel: "Confluence v2",
  });
}

/** v1 REST client — legacy, used only for operations v2 lacks. */
export function createConfluenceV1Http(cfg: ConfluenceConfig): AtlassianHttp {
  return createAtlassianHttp({
    baseUrl: `${cfg.baseUrl}/rest/api`,
    username: cfg.username,
    apiToken: cfg.apiToken,
    productLabel: "Confluence v1",
  });
}
