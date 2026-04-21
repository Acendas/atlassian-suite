#!/usr/bin/env node
// auth.mjs — interactive credential setup for the Acendas Atlassian Suite.
//
// Writes directly to ~/.acendas-atlassian/config.json (mode 0600) using the
// same atomic-write + rolling-backup semantics as the MCP server's
// configure_credentials tool. Zero dependencies; works on macOS, Linux, Windows.
//
// Usage:
//   node auth.mjs web                   # open a localhost-only browser wizard (recommended)
//   node auth.mjs open-url              # open token-generation page in default browser
//   node auth.mjs jira                  # configure Jira (url + email + token, interactive TTY)
//   node auth.mjs confluence            # configure Confluence (url + email + token, interactive TTY)
//   node auth.mjs bitbucket             # configure Bitbucket (workspace + email + token, interactive TTY)
//   node auth.mjs shared                # configure shared Atlassian identity (email + token, interactive TTY)
//   node auth.mjs scopes <product>      # print the canonical scope list for a product (no I/O, no TTY)
//   node auth.mjs verify [product|all]  # hit each product's whoami API to check credentials
//   node auth.mjs status                # print masked view of the current config
//
// Secrets never appear in the Claude Code transcript: the token prompt runs in
// raw mode on the user's terminal. If stdin is not a TTY (e.g. invoked via the
// `!` prefix inside Claude Code), the script refuses and tells the user to run
// it directly in their terminal.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CONFIG_DIR = join(homedir(), ".acendas-atlassian");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const BACKUP_FILE = join(CONFIG_DIR, "config.json.bak");
const TMP_FILE = join(CONFIG_DIR, "config.json.tmp");
const TOKEN_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

const USAGE =
  "Usage: node auth.mjs {web|open-url|jira|confluence|bitbucket|shared|scopes|verify|status}";

// Scope catalog — what the Acendas suite needs per product.
// `probe` tells verify how to test: GET for read scopes, POST-empty for write.
//   200 → scope granted
//   400 → scope granted (we hit the endpoint, server rejected our empty body)
//   401 → auth failed (email+token is wrong, not a scope issue)
//   403 → scope missing (or other permission issue)
//   404 → endpoint URL wrong — usually means base URL is wrong
const SCOPES = {
  jira: [
    {
      scope: "read:jira-work",
      required: true,
      why: "list/read issues, projects, comments",
      // Was /rest/api/3/search/jql?maxResults=0 — but the new search endpoint
      // requires maxResults between 1 and 5000 (returns 400). The legacy
      // /rest/api/3/search is 410 Gone. /project is the cleanest scope-bearing
      // read endpoint that doesn't actually execute a search.
      probe: { method: "GET", path: "/rest/api/3/project?recent=1" },
    },
    {
      scope: "write:jira-work",
      required: true,
      why: "create issues, add comments, transition, worklogs",
      probe: { method: "POST", path: "/rest/api/3/issue", body: "{}" },
    },
    {
      scope: "read:jira-user",
      required: false,
      why: "look up users by accountId or email",
      probe: { method: "GET", path: "/rest/api/3/users/search?query=a&maxResults=1" },
    },
  ],
  confluence: [
    // NB: paths here MUST NOT start with /wiki — resolveProbeUrl() routes
    // confluence through wikiBase() which already appends /wiki to the base
    // URL. Leading /wiki here would produce /wiki/wiki/... → 404.
    //
    // The plugin is v2-first + v1-targeted-fallback:
    //   - v2 endpoints (/api/v2/…) use the GRANULAR scope family
    //     (read:page:confluence, write:page:confluence, …).
    //   - v1 endpoints (/rest/api/…) use the CLASSIC scope family
    //     (search:confluence, write:confluence-content, …).
    // A single scoped API token can hold scopes from both families, so
    // the user ticks one set of boxes on the token-creation page.
    //
    // The `family` field distinguishes them so the wizard can present
    // them in two labeled groups — users shouldn't have to decode
    // scope-name conventions to understand which group a scope belongs
    // to.

    // ---------------- GRANULAR (for v2 endpoints) ----------------
    {
      scope: "read:page:confluence",
      family: "granular",
      required: true,
      why: "read pages, children, descendants, versions, labels, attachments-on-page",
      probe: { method: "GET", path: "/api/v2/pages?limit=1" },
    },
    {
      scope: "write:page:confluence",
      family: "granular",
      required: true,
      why: "create, update, and edit pages (including surgical edits)",
      // Empty body → 400 "authorized:true" when scope ok; 401 when missing.
      probe: { method: "POST", path: "/api/v2/pages", body: "{}" },
    },
    {
      scope: "read:space:confluence",
      family: "granular",
      required: true,
      why: "list and get spaces (getConfluenceSpaces, confluence_get_space)",
      probe: { method: "GET", path: "/api/v2/spaces?limit=1" },
    },
    {
      scope: "read:comment:confluence",
      family: "granular",
      required: true,
      why: "list footer and inline comments",
      probe: { method: "GET", path: "/api/v2/footer-comments?limit=1" },
    },
    {
      scope: "write:comment:confluence",
      family: "granular",
      required: true,
      why: "add/reply/resolve footer and inline comments",
      probe: { method: "POST", path: "/api/v2/footer-comments", body: "{}" },
    },
    {
      scope: "read:attachment:confluence",
      family: "granular",
      required: true,
      why: "list and read attachments (uploads use a classic scope — see below)",
      probe: { method: "GET", path: "/api/v2/attachments?limit=1" },
    },
    // read:user:confluence is DELIBERATELY NOT REQUIRED. Empirical testing
    // (April 2026) showed Atlassian's scoped-token implementation rejects
    // this granular scope on every /users/* and /user/* endpoint we tried,
    // both v1 and v2 — the "overlap" claimed in older docs does not exist.
    // All user tools (confluence_get_current_user, confluence_get_user,
    // confluence_search_user) have been reimplemented to use CQL search
    // via /rest/api/search, which works with the `search:confluence`
    // classic scope below. See tests/fixtures/scope-matrix.md if that
    // ever gets added.
    //
    // Optional granular — destructive. Users who never delete don't need these.
    {
      scope: "delete:page:confluence",
      family: "granular",
      required: false,
      why: "trash and purge pages (confluence_delete_page)",
      probe: null,
    },
    {
      scope: "delete:comment:confluence",
      family: "granular",
      required: false,
      why: "delete comments (not yet exposed as a tool, reserve for future)",
      probe: null,
    },
    {
      scope: "delete:attachment:confluence",
      family: "granular",
      required: false,
      why: "trash and purge attachments (confluence_delete_attachment)",
      probe: null,
    },

    // ---------------- CLASSIC (for v1 fallbacks) ----------------
    // These scopes power tools that v2 doesn't offer: CQL search, label
    // add/remove, attachment upload, page copy, version restore,
    // watch/unwatch. Keep this set minimal.
    {
      scope: "search:confluence",
      family: "classic",
      required: true,
      why: "CQL search — confluence_search, confluence_search_user (v2 has no CQL)",
      probe: { method: "GET", path: "/rest/api/content/search?cql=type%3Dpage&limit=1" },
    },
    {
      scope: "write:confluence-content",
      family: "classic",
      required: true,
      why: "label add/remove, page move, page copy, version restore, watch/unwatch (v2 lacks these)",
      probe: { method: "POST", path: "/rest/api/content", body: "{}" },
    },
    {
      scope: "write:confluence-file",
      family: "classic",
      required: false,
      why: "upload attachments (confluence_upload_attachment — v2 has no upload endpoint)",
      // Multipart probe without a real page id isn't meaningful; surface
      // the scope in the required list and let runtime errors guide fix-ups.
      probe: null,
    },
  ],
  bitbucket: [
    {
      scope: "read:user:bitbucket",
      required: true,
      why: "identify the authenticated user",
      probe: { method: "GET", path: "https://api.bitbucket.org/2.0/user" },
    },
    {
      scope: "read:workspace:bitbucket",
      required: true,
      why: "read workspace metadata",
      probe: { method: "GET", path: "https://api.bitbucket.org/2.0/workspaces/{workspace}" },
    },
    {
      scope: "read:repository:bitbucket",
      required: true,
      why: "list/read repositories",
      probe: { method: "GET", path: "https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1" },
    },
    {
      scope: "read:pullrequest:bitbucket",
      required: true,
      why: "list/read pull requests",
      probe: { method: "GET", path: "https://api.bitbucket.org/2.0/pullrequests/{username}?pagelen=1" },
    },
    {
      scope: "write:repository:bitbucket",
      required: false,
      why: "create branches, push commits (write tools)",
      probe: null, // no safe dry-run; report NOT_TESTED
    },
    {
      scope: "write:pullrequest:bitbucket",
      required: false,
      why: "create/update PRs, approve, merge",
      probe: null,
    },
    {
      scope: "read:pipeline:bitbucket",
      required: false,
      why: "read pipeline runs + deployments (only if you use pipelines)",
      probe: null,
    },
    {
      scope: "write:pipeline:bitbucket",
      required: false,
      why: "trigger pipelines (only if you use pipelines)",
      probe: null,
    },
  ],
};

const sub = (process.argv[2] || "").toLowerCase();

async function main() {
  switch (sub) {
    case "web":
      await runWebWizard();
      return;
    case "open-url":
      openUrl(TOKEN_URL);
      console.log(`opened: ${TOKEN_URL}`);
      return;
    case "status":
      printStatus();
      return;
    case "scopes": {
      const product = (process.argv[3] || "").toLowerCase();
      if (!SCOPES[product]) {
        console.error(
          `usage: node auth.mjs scopes {jira|confluence|bitbucket}`,
        );
        process.exit(2);
      }
      printScopeSuggestion(product);
      return;
    }
    case "verify": {
      const target = (process.argv[3] || "all").toLowerCase();
      const ok = await verifyAll(target);
      process.exit(ok ? 0 : 5);
    }
    // eslint-disable-next-line no-fallthrough
    case "jira":
    case "confluence":
    case "bitbucket":
    case "shared":
      await configure(sub);
      return;
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

async function configure(product) {
  console.log("");
  console.log(`Acendas Atlassian Suite — configure ${product}`);
  console.log(`File: ${CONFIG_FILE} (mode 0600)`);
  console.log("");

  requireTTY();

  const before = loadConfig();
  const patch = {};

  if (product === "shared") {
    console.log(
      "Shared Atlassian identity — used as fallback for Jira + Confluence",
    );
    console.log("when a per-product value isn't set.");
    console.log("");
    const username = await promptVisible("Atlassian email: ");
    printScopeSuggestion(product === "shared" ? "jira" : product);
    if (product === "shared") {
      // Shared creds power both Jira and Confluence — show both lists.
      printScopeSuggestion("confluence");
    }
    openUrl(TOKEN_URL);
    console.log(`  (browser opened; if not: ${TOKEN_URL})`);
    const token = await promptHidden("Atlassian API token (hidden): ");
    assertNotEmpty({ email: username, token });
    patch.atlassian = { username, api_token: token };
  } else if (product === "jira") {
    const url = await promptVisible(
      "Jira site URL (e.g. https://acme.atlassian.net): ",
    );
    const username = await promptVisible("Atlassian email on that site: ");
    printScopeSuggestion(product === "shared" ? "jira" : product);
    if (product === "shared") {
      // Shared creds power both Jira and Confluence — show both lists.
      printScopeSuggestion("confluence");
    }
    openUrl(TOKEN_URL);
    console.log(`  (browser opened; if not: ${TOKEN_URL})`);
    const token = await promptHidden("Jira API token (hidden): ");
    assertNotEmpty({ url, email: username, token });
    patch.jira = { url, username, api_token: token };
  } else if (product === "confluence") {
    const url = await promptVisible(
      "Confluence site URL (typically https://<your-site>.atlassian.net/wiki): ",
    );
    const username = await promptVisible("Atlassian email on that site: ");
    printScopeSuggestion(product === "shared" ? "jira" : product);
    if (product === "shared") {
      // Shared creds power both Jira and Confluence — show both lists.
      printScopeSuggestion("confluence");
    }
    openUrl(TOKEN_URL);
    console.log(`  (browser opened; if not: ${TOKEN_URL})`);
    const token = await promptHidden("Confluence API token (hidden): ");
    assertNotEmpty({ url, email: username, token });
    patch.confluence = { url, username, api_token: token };
  } else if (product === "bitbucket") {
    const workspace = await promptVisible("Bitbucket workspace slug: ");
    const username = await promptVisible(
      "Atlassian email tied to Bitbucket: ",
    );
    printScopeSuggestion(product === "shared" ? "jira" : product);
    if (product === "shared") {
      // Shared creds power both Jira and Confluence — show both lists.
      printScopeSuggestion("confluence");
    }
    openUrl(TOKEN_URL);
    console.log(`  (browser opened; if not: ${TOKEN_URL})`);
    const token = await promptHidden("Bitbucket API token (hidden): ");
    assertNotEmpty({ workspace, email: username, token });
    patch.bitbucket = { workspace, username, api_token: token };
  }

  const after = mergeCreds(before, patch);
  saveConfig(after);

  const sectionKey = Object.keys(patch)[0];
  const savedToken = patch[sectionKey].api_token;

  console.log("");
  console.log(`saved ${product} credentials to ${CONFIG_FILE}`);
  console.log(`  token: ${mask(savedToken)}`);
  if (existsSync(BACKUP_FILE)) {
    console.log(`  backup: ${BACKUP_FILE}`);
  }

  console.log("");
  console.log("Self-test: hitting the product API with Basic Auth…");
  const ok = await verifyProduct(product === "shared" ? "jira" : product, after);
  if (product === "shared" && ok) {
    // Shared creds also power Confluence — probe that too.
    await verifyProduct("confluence", after);
  }

  console.log("");
  console.log(
    "Restart Claude Code (or just the MCP server) for the new credentials to take effect.",
  );
  console.log("");
}

// ---------- API self-test ----------

// Resolve effective credentials for a product, honouring env > per-product file > shared file.
function resolveCreds(product, cfg) {
  const envUpper = product.toUpperCase();
  const envUser =
    process.env[`${envUpper}_USERNAME`] || process.env.ATLASSIAN_USERNAME;
  const envToken =
    process.env[`${envUpper}_API_TOKEN`] || process.env.ATLASSIAN_API_TOKEN;
  const envUrl =
    product === "bitbucket"
      ? process.env.BITBUCKET_WORKSPACE
      : process.env[`${envUpper}_URL`];
  const envCloudId = process.env[`${envUpper}_CLOUD_ID`];

  const section = cfg[product] || {};
  const shared = cfg.atlassian || {};

  return {
    url:
      envUrl ||
      section.url ||
      (product === "bitbucket" ? section.workspace : undefined),
    workspace: product === "bitbucket" ? envUrl || section.workspace : undefined,
    username: envUser || section.username || shared.username,
    apiToken: envToken || section.api_token || shared.api_token,
    cloudId: envCloudId || section.cloud_id,
  };
}

async function verifyAll(target) {
  const cfg = loadConfig();
  const products =
    target === "all"
      ? ["jira", "confluence", "bitbucket"]
      : [target];
  let allOk = true;
  for (const p of products) {
    if (!["jira", "confluence", "bitbucket"].includes(p)) {
      console.error(`unknown product: ${p}`);
      return false;
    }
    const ok = await verifyProduct(p, cfg);
    if (!ok) allOk = false;
  }
  return allOk;
}

// Structured verifier — used by both the CLI verify path (which prints the
// results) and the web wizard (which serialises the same shape as JSON).
async function runVerifyStructured(product, cfg) {
  // "atlassian" mode verifies a single classic (unscoped) token against
  // BOTH Jira and Confluence endpoints. Classic tokens carry full
  // permissions for whichever Atlassian products the user has access
  // to; scoped tokens are one-product-only and use the per-product
  // paths below.
  if (product === "atlassian") {
    const jiraR = await runVerifyStructured("jira", cfg);
    const confR = await runVerifyStructured("confluence", cfg);
    const allSkipped = jiraR.skipped && confR.skipped;
    // Merged scope list, each tagged with `_product` so the UI can
    // render them under separate headings.
    const scopes = [
      ...jiraR.scopes.map((s) => ({ ...s, _product: "jira" })),
      ...confR.scopes.map((s) => ({ ...s, _product: "confluence" })),
    ];
    return {
      product: "atlassian",
      skipped: allSkipped,
      skipReason: allSkipped
        ? (jiraR.skipReason || confR.skipReason)
        : undefined,
      // Prefer a successful auth for the "who" display; fall back to Jira's.
      auth: jiraR.auth?.status === "ok" ? jiraR.auth : (confR.auth || jiraR.auth),
      scopes,
      requiredOk: jiraR.requiredOk && confR.requiredOk,
      sub: { jira: jiraR, confluence: confR },
    };
  }

  const creds = resolveCreds(product, cfg);

  if (product === "bitbucket") {
    if (!creds.username || !creds.apiToken || !creds.workspace) {
      return {
        product,
        skipped: true,
        skipReason: "missing workspace/username/token",
        auth: null,
        scopes: [],
        requiredOk: false,
      };
    }
  } else {
    if (!creds.url || !creds.username || !creds.apiToken) {
      return {
        product,
        skipped: true,
        skipReason: "missing url/username/token",
        auth: null,
        scopes: [],
        requiredOk: false,
      };
    }
  }

  const whoami = await whoamiProbe(product, creds);
  const result = { product, skipped: false, auth: whoami, scopes: [], requiredOk: true };

  if (whoami.status !== "ok") {
    result.requiredOk = false;
    return result;
  }

  for (const spec of SCOPES[product]) {
    if (!spec.probe) {
      result.scopes.push({
        scope: spec.scope,
        required: spec.required,
        status: "not_tested",
        why: spec.why,
      });
      continue;
    }
    const probeResult = await scopeProbe(product, creds, spec);
    const entry = { scope: spec.scope, required: spec.required, why: spec.why };
    if (probeResult === "ok") {
      entry.status = "ok";
    } else if (probeResult === "missing") {
      entry.status = "missing";
      if (spec.required) result.requiredOk = false;
    } else if (probeResult === "auth") {
      entry.status = "auth_fail";
      if (spec.required) result.requiredOk = false;
    } else {
      entry.status = "unknown";
      entry.detail = probeResult;
    }
    result.scopes.push(entry);
  }

  return result;
}

async function verifyProduct(product, cfg) {
  const r = await runVerifyStructured(product, cfg);

  if (r.skipped) {
    console.log(`  ${product}: SKIP (${r.skipReason})`);
    return false;
  }

  console.log(`  ${product}:`);

  if (r.auth.status === "auth-failed") {
    console.log(
      `    auth:            FAIL (${r.auth.detail}) — fix email+token before checking scopes`,
    );
    return false;
  }
  if (r.auth.status === "url-wrong" || r.auth.status === "network") {
    console.log(`    auth:            FAIL (${r.auth.detail})`);
    return false;
  }
  console.log(`    auth:            OK (${r.auth.who})`);

  for (const s of r.scopes) {
    const label = s.scope.padEnd(32, " ");
    const flag = s.required ? " (required)" : "";
    if (s.status === "ok") {
      console.log(`    ${label} OK${flag}`);
    } else if (s.status === "missing") {
      console.log(`    ${label} MISSING${flag} — needed to ${s.why}`);
    } else if (s.status === "auth_fail") {
      console.log(`    ${label} FAIL (auth)${flag}`);
    } else if (s.status === "not_tested") {
      const tag = s.required ? "NOT_TESTED (required)" : "NOT_TESTED";
      console.log(`    ${label} ${tag} — ${s.why}`);
    } else {
      console.log(`    ${label} UNKNOWN${flag} — ${s.detail || ""}`);
    }
  }

  return r.requiredOk;
}

async function whoamiProbe(product, creds) {
  let url;
  if (product === "jira") {
    // Scoped tokens REQUIRE the api.atlassian.com gateway URL with cloudId.
    // Legacy /rest/... on yoursite.atlassian.net only works for unscoped
    // tokens (which Atlassian deprecates Mar–May 2026). If we have a cloudId
    // (auto-discovered on save), use the gateway. Otherwise fall back to
    // legacy and let the user see the resulting failure verbatim.
    url = creds.cloudId
      ? `https://api.atlassian.com/ex/jira/${creds.cloudId}/rest/api/3/myself`
      : `${stripTrailingSlash(creds.url)}/rest/api/3/myself`;
  } else if (product === "confluence") {
    // Was /rest/api/user/current — but that endpoint requires read:confluence-user,
    // which we mark optional. A token with only the required read scopes
    // 401s here and the verifier short-circuits before probing anything
    // else. Use /rest/api/space?limit=1 instead: requires
    // read:confluence-space.summary (required scope #1), validates auth +
    // site URL + cloudId in one shot. "who" falls back to configured email
    // since the response has no identity info.
    url = creds.cloudId
      ? `https://api.atlassian.com/ex/confluence/${creds.cloudId}/wiki/rest/api/space?limit=1`
      : `${wikiBase(creds.url)}/rest/api/space?limit=1`;
  } else {
    url = "https://api.bitbucket.org/2.0/user";
  }
  const res = await httpFetch({ url, username: creds.username, token: creds.apiToken });
  if (res.kind === "network") return { status: "network", detail: res.detail };

  // For non-200 responses, capture Atlassian's actual error body so the user
  // sees something like "Token is invalid, expired, or not supported for this
  // endpoint" instead of our generic "401 — email or token wrong". Real error
  // text is the difference between 5 minutes of self-diagnosis and a support
  // ticket.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const body = await safeText(res.response);
    const atlasMsg = extractAtlasError(body);
    const baseMap = {
      401: "401 Unauthorized",
      403: "403 Forbidden — token likely missing required scopes",
      404: "404 — endpoint URL wrong (check site URL / cloudId / workspace)",
    };
    const base = baseMap[res.status];
    return {
      status: res.status === 404 ? "url-wrong" : "auth-failed",
      detail: atlasMsg ? `${base} — ${atlasMsg}` : base,
    };
  }

  if (res.status >= 200 && res.status < 300) {
    const body = await safeJson(res.response);
    // Confluence whoami uses /rest/api/space (no identity in response) —
    // fall back to the configured email so the user sees something
    // meaningful on the "auth: OK" line.
    const fallback = product === "confluence" ? creds.username : "(ok)";
    const who =
      body?.emailAddress ||
      body?.email ||
      body?.username ||
      body?.display_name ||
      body?.displayName ||
      body?.accountId ||
      body?.account_id ||
      fallback;
    return { status: "ok", who };
  }
  return { status: "auth-failed", detail: `HTTP ${res.status}` };
}

// Extract the human-readable error from an Atlassian API response body.
// Handles all three product flavours:
//   - Jira/Confluence:  {"errorMessages": ["..."], "errors": {...}}
//   - Bitbucket:        {"type": "error", "error": {"message": "..."}}
//   - Plain text:       "Client must be authenticated to access this resource."
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function extractAtlasError(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Try JSON shapes first.
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      // Bitbucket: {"type":"error","error":{"message":"..."}}
      if (j?.error?.message) return String(j.error.message);
      // Jira/Confluence: {"errorMessages":["..."]}
      if (Array.isArray(j?.errorMessages) && j.errorMessages.length > 0) {
        return String(j.errorMessages[0]);
      }
      // OAuth-style: {"message":"..."}
      if (typeof j?.message === "string") return j.message;
    } catch {
      // fall through to plain-text handling
    }
  }
  // Plain text. Cap to one line / 120 chars so we don't dump HTML pages.
  const oneLine = trimmed.replace(/\s+/g, " ").slice(0, 120);
  return oneLine || null;
}

async function scopeProbe(product, creds, spec) {
  const url = resolveProbeUrl(product, creds, spec.probe.path);
  const res = await httpFetch({
    url,
    username: creds.username,
    token: creds.apiToken,
    method: spec.probe.method,
    body: spec.probe.body,
  });
  if (res.kind === "network") return `network: ${res.detail}`;
  const s = res.status;
  // 200-299 → scope granted, endpoint happy.
  if (s >= 200 && s < 300) return "ok";
  // 400 on our intentional empty POST → we got past auth+scope, server rejected payload.
  //   That means the write scope IS granted.
  if (spec.probe.method === "POST" && (s === 400 || s === 422)) return "ok";
  // 401 → ambiguous in theory (bad auth vs missing scope), but Atlassian's
  // scoped tokens 401 with "Unauthorized; scope does not match" when the
  // token is valid but lacks the scope for this endpoint. Since whoami has
  // already passed by the time we call scopeProbe, we know auth is good —
  // so a 401 with that marker is always missing-scope, not bad creds.
  if (s === 401) {
    const body = await safeText(res.response);
    if (/scope\s+does\s+not\s+match/i.test(body)) return "missing";
    return "auth";
  }
  // 403 → scope missing, or other permission issue.
  if (s === 403) return "missing";
  // 404 handling is heuristic and product/scope-specific:
  // - Bitbucket /workspaces/{ws} endpoint: 404 = wrong workspace slug, NOT
  //   "no data" — must surface as MISSING so the user knows to fix the slug.
  // - Bitbucket /repositories/{ws} or /pullrequests/{user}: 404 can legitimately
  //   mean "workspace has no repos" / "user has no PRs" — auto-pass for reads.
  // - Jira / Confluence: 404 is always URL drift — never silently auto-pass.
  if (s === 404) {
    if (product === "bitbucket" && spec.scope.startsWith("read:")) {
      // Workspace probe specifically: 404 means workspace doesn't exist.
      if (spec.scope === "read:workspace:bitbucket") return "missing";
      return "ok";
    }
    return "missing";
  }
  // Anything else → unknown.
  return `HTTP ${s}`;
}

function resolveProbeUrl(product, creds, path) {
  if (path.startsWith("http")) {
    return path
      .replace("{workspace}", encodeURIComponent(creds.workspace || ""))
      .replace("{username}", encodeURIComponent(creds.username || ""));
  }
  // Prefer the api.atlassian.com gateway when we have a cloudId — that's the
  // only URL pattern that accepts scoped API tokens via Basic auth. Legacy
  // {site}.atlassian.net is the fallback for tokens that pre-date scoping.
  let base;
  if (product === "jira") {
    base = creds.cloudId
      ? `https://api.atlassian.com/ex/jira/${creds.cloudId}`
      : stripTrailingSlash(creds.url);
  } else if (product === "confluence") {
    base = creds.cloudId
      ? `https://api.atlassian.com/ex/confluence/${creds.cloudId}/wiki`
      : wikiBase(creds.url);
  } else {
    base = stripTrailingSlash(creds.url);
  }
  return (
    base +
    path.replace("{workspace}", encodeURIComponent(creds.workspace || ""))
  );
}

async function httpFetch({ url, username, token, method = "GET", body }) {
  const auth = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "User-Agent": "acendas-atlassian-auth/0.1",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(url, { method, headers, body });
    return { kind: "http", status: response.status, response };
  } catch (err) {
    return { kind: "network", detail: err?.message || String(err) };
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function wikiBase(url) {
  const base = stripTrailingSlash(url);
  return /\/wiki$/i.test(base) ? base : `${base}/wiki`;
}

// Strip /wiki suffix from a Confluence URL to get the bare site URL needed
// for tenant_info discovery (which is /_edge/tenant_info on the site root).
function siteBase(url) {
  return stripTrailingSlash(url).replace(/\/wiki$/i, "");
}

// Atlassian's cloudId is required to use scoped API tokens via the
// api.atlassian.com gateway. It can be fetched without auth from
// {site}/_edge/tenant_info. Returns null on any failure (network, parse).
async function discoverCloudId(siteUrl) {
  try {
    const url = `${siteBase(siteUrl)}/_edge/tenant_info`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.cloudId === "string" ? body.cloudId : null;
  } catch {
    return null;
  }
}

function printScopeSuggestion(product) {
  const list = SCOPES[product];
  if (!list) return;

  // Group by family when present (Confluence uses granular + classic).
  // For products without a `family` field (Jira, Bitbucket), fall back to
  // the flat required/optional layout.
  const hasFamilies = list.some((s) => s.family);

  console.log("");
  console.log(`  ┌─ Scopes to tick on the token-creation page (${product})`);
  console.log("  │");

  if (hasFamilies) {
    // Confluence: two-family grouping.
    const groups = [
      { label: "GRANULAR family (for v2 endpoints)", key: "granular" },
      { label: "CLASSIC family (for v1 fallbacks)", key: "classic" },
    ];
    for (const g of groups) {
      const inGroup = list.filter((s) => s.family === g.key);
      if (inGroup.length === 0) continue;
      const req = inGroup.filter((s) => s.required);
      const opt = inGroup.filter((s) => !s.required);
      console.log(`  │  ${g.label}`);
      if (req.length > 0) {
        console.log("  │    Required:");
        for (const s of req) {
          console.log(`  │      • ${s.scope}`);
          console.log(`  │          ${s.why}`);
        }
      }
      if (opt.length > 0) {
        console.log("  │    Optional:");
        for (const s of opt) {
          console.log(`  │      • ${s.scope}`);
          console.log(`  │          ${s.why}`);
        }
      }
      console.log("  │");
    }
  } else {
    const required = list.filter((s) => s.required);
    const optional = list.filter((s) => !s.required);
    console.log("  │  Required:");
    for (const s of required) {
      console.log(`  │    • ${s.scope}`);
      console.log(`  │        ${s.why}`);
    }
    if (optional.length > 0) {
      console.log("  │");
      console.log("  │  Optional:");
      for (const s of optional) {
        console.log(`  │    • ${s.scope}`);
        console.log(`  │        ${s.why}`);
      }
    }
    console.log("  │");
  }

  console.log(
    "  │  On the page: click 'Create API token with scopes' →",
  );
  console.log(`  │  select the ${productDisplayName(product)} app → tick the scopes above.`);
  console.log("  └─");
  console.log("");
}

function productDisplayName(product) {
  if (product === "jira") return "Jira";
  if (product === "confluence") return "Confluence";
  if (product === "bitbucket") return "Bitbucket";
  return product;
}

function stripTrailingSlash(s) {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function printStatus() {
  const cfg = loadConfig();
  const masked = JSON.parse(JSON.stringify(cfg));
  for (const s of ["atlassian", "jira", "confluence", "bitbucket"]) {
    if (masked[s]?.api_token) masked[s].api_token = mask(masked[s].api_token);
  }
  console.log(`file: ${CONFIG_FILE}`);
  console.log(`exists: ${existsSync(CONFIG_FILE)}`);
  console.log(JSON.stringify(masked, null, 2));
}

// ---------- prompt helpers ----------

function requireTTY() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "error: this command needs an interactive terminal for the hidden token prompt.",
    );
    console.error(
      "Run it directly in your terminal — not via the `!` prefix inside Claude Code.",
    );
    console.error("");
    console.error("  node <path-to-plugin>/server/scripts/auth.mjs " + sub);
    process.exit(3);
  }
}

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdout.write("\n");
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (c < " ") continue;
        buf += c;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function assertNotEmpty(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (!value || (typeof value === "string" && value.trim().length === 0)) {
      console.error(`error: ${name} is required`);
      process.exit(4);
    }
  }
}

// ---------- URL open ----------

function openUrl(url) {
  try {
    const p = platform();
    if (p === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (p === "win32") {
      spawn("cmd", ["/c", "start", '""', url], {
        stdio: "ignore",
        detached: true,
        shell: false,
      }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Best effort — script still works if the browser can't be launched.
  }
}

// ---------- config file I/O ----------

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(creds) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(CONFIG_DIR, 0o700);
    } catch {
      // Best effort — Windows ignores chmod
    }
  }
  if (existsSync(CONFIG_FILE)) {
    try {
      copyFileSync(CONFIG_FILE, BACKUP_FILE);
      chmodSync(BACKUP_FILE, 0o600);
    } catch {
      console.error("warn: failed to back up prior config before write");
    }
  }
  const json = JSON.stringify(creds, null, 2) + "\n";
  writeFileSync(TMP_FILE, json, { mode: 0o600 });
  try {
    const fd = openSync(TMP_FILE, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // fsync is best-effort; rename still succeeds
  }
  renameSync(TMP_FILE, CONFIG_FILE);
  chmodSync(CONFIG_FILE, 0o600);
}

// Merge semantics match server/src/common/credStore.ts mergeCreds:
// undefined / null / empty strings / empty arrays in patch never clobber.
function mergeCreds(base, patch) {
  const result = JSON.parse(JSON.stringify(base || {}));
  for (const section of ["atlassian", "jira", "confluence", "bitbucket"]) {
    const src = patch[section];
    if (!src) continue;
    const dst = (result[section] = result[section] || {});
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.length === 0) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      dst[key] = value;
    }
  }
  return result;
}

function mask(token) {
  if (!token) return "(empty)";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`;
}

// ---------- web wizard ----------

// Spins up a 127.0.0.1-only HTTP server with a one-time URL secret.
// Serves a single HTML page that posts back to /save/<product> with credentials,
// runs the same self-test verifyProduct uses, and returns structured per-scope
// results. Token never appears in the Claude transcript — it's pasted into a
// browser textarea (no length cap) and posted directly to localhost.
async function runWebWizard() {
  const http = await import("node:http");
  const { randomBytes, timingSafeEqual } = await import("node:crypto");

  const secret = randomBytes(24).toString("hex");
  const secretBuf = Buffer.from(secret, "utf8");

  const INACTIVITY_MS = 30 * 60 * 1000;
  let inactivityTimer;
  const bumpInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log("inactivity timeout (30 min) — shutting down");
      process.exit(2);
    }, INACTIVITY_MS);
  };

  const checkAuth = (url) => {
    const t = url.searchParams.get("t");
    if (!t || t.length !== secret.length) return false;
    try {
      return timingSafeEqual(Buffer.from(t, "utf8"), secretBuf);
    } catch {
      return false;
    }
  };

  const server = http.createServer(async (req, res) => {
    bumpInactivity();
    const url = new URL(req.url, `http://127.0.0.1`);

    if (!checkAuth(url)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("unauthorized — wrong or missing one-time token");
    }

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.end(buildHtml(secret));
      }

      if (req.method === "GET" && url.pathname === "/state") {
        const cfg = loadConfig();
        const masked = {
          jira: cfg.jira ? maskSection(cfg.jira) : null,
          confluence: cfg.confluence ? maskSection(cfg.confluence) : null,
          bitbucket: cfg.bitbucket ? maskSection(cfg.bitbucket) : null,
          atlassian: cfg.atlassian ? maskSection(cfg.atlassian) : null,
          file: CONFIG_FILE,
        };
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(masked));
      }

      if (req.method === "GET" && url.pathname === "/scopes") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(SCOPES));
      }

      if (req.method === "POST" && url.pathname.startsWith("/save/")) {
        const product = url.pathname.slice("/save/".length);
        if (!["jira", "confluence", "bitbucket", "atlassian"].includes(product)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: "unknown product" }));
        }
        const body = await readBody(req);
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        }

        const before = loadConfig();
        const patch = {};
        if (product === "atlassian") {
          // Classic-token mode: one token for both Jira + Confluence.
          // Writes:
          //   - atlassian.username, atlassian.api_token (shared)
          //   - jira.url + jira.cloud_id (per-product URL, no token — resolves via atlassian.*)
          //   - confluence.url + confluence.cloud_id (same idea, /wiki appended)
          // Config.ts resolves per-product-token-first-then-shared, so leaving
          // jira.api_token and confluence.api_token unset means the tools will
          // use the shared atlassian token automatically.
          if (!data.url || !data.email || !data.token) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ ok: false, error: "url, email, token are required" }));
          }
          // Normalise tenant URL: strip trailing slash + trailing /wiki so we
          // have a clean tenant root (e.g. https://acme.atlassian.net).
          const tenantUrl = stripTrailingSlash(data.url.trim()).replace(/\/wiki$/i, "");
          const cloudId = await discoverCloudId(tenantUrl);
          patch.atlassian = {
            username: data.email.trim(),
            api_token: data.token,
          };
          patch.jira = {
            url: tenantUrl,
            ...(cloudId ? { cloud_id: cloudId } : {}),
          };
          patch.confluence = {
            url: `${tenantUrl}/wiki`,
            ...(cloudId ? { cloud_id: cloudId } : {}),
          };
        } else if (product === "jira") {
          if (!data.url || !data.email || !data.token) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ ok: false, error: "url, email, token are required" }));
          }
          // Discover cloudId so the MCP server (and verify probes) can hit
          // the api.atlassian.com gateway, which is the only path that
          // accepts scoped API tokens. Failure is non-fatal — falls back
          // to legacy yoursite.atlassian.net Basic auth (works only for
          // unscoped tokens, which Atlassian deprecates Mar–May 2026).
          const cloudId = await discoverCloudId(data.url.trim());
          patch.jira = {
            url: data.url.trim(),
            username: data.email.trim(),
            api_token: data.token,
            ...(cloudId ? { cloud_id: cloudId } : {}),
          };
        } else if (product === "confluence") {
          if (!data.url || !data.email || !data.token) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ ok: false, error: "url, email, token are required" }));
          }
          const cloudId = await discoverCloudId(data.url.trim());
          patch.confluence = {
            url: data.url.trim(),
            username: data.email.trim(),
            api_token: data.token,
            ...(cloudId ? { cloud_id: cloudId } : {}),
          };
        } else if (product === "bitbucket") {
          if (!data.workspace || !data.email || !data.token) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ ok: false, error: "workspace, email, token are required" }));
          }
          patch.bitbucket = {
            workspace: data.workspace.trim(),
            username: data.email.trim(),
            api_token: data.token,
          };
        }

        const after = mergeCreds(before, patch);
        // In atlassian (classic) mode, remove any stale per-product token
        // and username entries so the resolver falls back to the shared
        // atlassian.* credentials. Without this, a user who previously set
        // scoped tokens and then switches to classic would keep using the
        // old per-product tokens (per-product wins in resolution order).
        if (product === "atlassian") {
          for (const p of ["jira", "confluence"]) {
            if (after[p]) {
              delete after[p].api_token;
              delete after[p].username;
            }
          }
        }
        saveConfig(after);

        const verify = await runVerifyStructured(product, after);
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({ ok: true, file: CONFIG_FILE, verify }, null, 2),
        );
      }

      if (req.method === "POST" && url.pathname === "/done") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, message: "shutting down" }));
        console.log("user clicked Done — shutting down");
        setTimeout(() => process.exit(0), 100);
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const wizardUrl = `http://127.0.0.1:${port}/?t=${secret}`;
    console.log("");
    console.log("Acendas Atlassian Suite — credential web wizard");
    console.log(`File: ${CONFIG_FILE} (mode 0600)`);
    console.log("");
    console.log(`Listening on  127.0.0.1:${port}  (one-time URL secret bound)`);
    console.log(`Open:         ${wizardUrl}`);
    console.log("");
    console.log("Server exits when you click Done in the browser, or after 30 min idle.");
    console.log("Press Ctrl-C to abort.");
    openUrl(wizardUrl);
    bumpInactivity();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // 64KB cap — tokens are <1KB, more than that is hostile
      if (data.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function maskSection(section) {
  const clone = { ...section };
  if (clone.api_token) clone.api_token = mask(clone.api_token);
  return clone;
}

function buildHtml(secret) {
  // Inline stepped wizard — one screen at a time. No build step, no external
  // assets. The `__SECRET__` placeholder is replaced with the per-session
  // secret so the page can call /state, /scopes, /save, /done.
  const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Acendas Atlassian — Credential Wizard</title>
<style>
  :root {
    --bg: #0b1220;
    --panel: #131c2e;
    --panel-2: #1a2540;
    --border: #2a3a55;
    --border-2: #3a4d70;
    --text: #f0f3fa;
    --muted: #8aa0c7;
    --muted-2: #6b7c9a;
    --accent: #4f8cff;
    --accent-hover: #6ba0ff;
    --ok: #4ade80;
    --warn: #fbbf24;
    --fail: #f87171;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: linear-gradient(180deg, var(--bg) 0%, #0a101c 100%);
    color: var(--text);
    font: 15px/1.55 var(--sans);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 32px 16px;
    gap: 0;
  }
  .wizard {
    width: 100%;
    max-width: 620px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    overflow: hidden;
    flex-shrink: 0;
  }
  .footer-meta-wrap { flex-shrink: 0; }
  header {
    padding: 18px 24px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }
  .brand {
    font-size: 12px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--muted-2);
    margin-bottom: 12px;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 26px;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    transition: background 0.2s;
  }
  .dot.done { background: var(--accent); }
  .dot.current { background: var(--text); }
  .step-label {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted-2);
    font-variant-numeric: tabular-nums;
  }
  main {
    padding: 32px 28px 24px;
    min-height: 380px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .lede {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
    margin: 0 0 24px;
  }
  .section { display: none; animation: fade 0.18s ease-out; }
  .section.active { display: block; }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  .chip-row { display: flex; gap: 8px; margin: 18px 0; flex-wrap: wrap; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
  }
  .chip.set { color: var(--ok); border-color: rgba(74, 222, 128, 0.35); }
  .chip .check { font-size: 10px; }

  .product-list { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 4px; }
  .product-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.05s;
    text-align: left;
    width: 100%;
    color: inherit;
    font: inherit;
  }
  .product-card:hover { border-color: var(--accent); }
  .product-card:active { transform: translateY(1px); }
  .product-card .icon {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--panel);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    color: var(--accent);
    font-size: 14px;
    flex-shrink: 0;
  }
  .product-card .name { font-size: 15px; font-weight: 500; }
  .product-card .desc { font-size: 12px; color: var(--muted-2); margin-top: 1px; }
  .product-card .meta { font-size: 11px; color: var(--muted-2); font-family: var(--mono); margin-top: 3px; word-break: break-all; }
  .product-card .text-col { flex: 1; min-width: 0; }
  .product-card .right { font-size: 11px; color: var(--muted-2); }
  .product-card .right.set { color: var(--ok); }

  ol.steps { list-style: none; counter-reset: stepc; padding: 0; margin: 0 0 18px; }
  ol.steps li {
    counter-increment: stepc;
    padding: 10px 0 10px 38px;
    position: relative;
    color: var(--text);
    font-size: 14px;
    line-height: 1.55;
  }
  ol.steps li::before {
    content: counter(stepc);
    position: absolute;
    left: 0;
    top: 8px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 500;
  }
  ol.steps li b { color: var(--text); }
  ol.steps li code { background: var(--panel-2); padding: 1px 6px; border-radius: 4px; font-size: 12px; color: var(--accent); }

  .scope-box {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    margin: 14px 0 18px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.7;
    max-height: 280px;
    overflow-y: auto;
  }
  .scope-box .group-label {
    color: var(--muted);
    font-weight: 600;
    font-family: var(--sans);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 6px;
  }
  .scope-box .group-label.optional { margin-top: 12px; color: var(--muted-2); }
  .scope-box .scope-line { display: flex; gap: 8px; align-items: baseline; padding: 1px 0; }
  .scope-box .scope-line .check { color: var(--muted-2); font-size: 11px; }
  .scope-box .scope-line .name { color: var(--text); }
  .scope-box .scope-line.optional .name { color: var(--muted); }
  .scope-box .scope-line .why { color: var(--muted-2); margin-left: 6px; font-size: 11px; }

  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
  .field .hint { display: block; font-size: 11px; color: var(--muted-2); margin-top: 4px; }
  .field input, .field textarea {
    width: 100%;
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font: 14px var(--mono);
    transition: border-color 0.15s;
  }
  .field input:focus, .field textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .field textarea { resize: vertical; min-height: 80px; line-height: 1.45; }

  .privacy-note {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(79, 140, 255, 0.08);
    border: 1px solid rgba(79, 140, 255, 0.2);
    border-radius: 8px;
    font-size: 12px;
    color: var(--muted);
    margin: 8px 0 18px;
  }
  .privacy-note b { color: var(--text); }

  .verify-summary {
    padding: 16px 18px;
    border-radius: 10px;
    margin-bottom: 16px;
    border: 1px solid;
  }
  .verify-summary.ok { background: rgba(74, 222, 128, 0.07); border-color: rgba(74, 222, 128, 0.3); }
  .verify-summary.fail { background: rgba(248, 113, 113, 0.07); border-color: rgba(248, 113, 113, 0.3); }
  .verify-summary .headline { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .verify-summary .sub { color: var(--muted); font-size: 13px; margin-top: 6px; line-height: 1.5; }
  .verify-summary .icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
  .verify-summary.ok .icon { background: var(--ok); color: #062b14; }
  .verify-summary.fail .icon { background: var(--fail); color: #2b0606; }
  .scope-results { display: flex; flex-direction: column; gap: 4px; font-family: var(--mono); font-size: 12px; }
  .scope-results .row { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; }
  .scope-results .row .status { width: 84px; flex-shrink: 0; font-weight: 600; }
  .scope-results .row.ok .status { color: var(--ok); }
  .scope-results .row.miss .status { color: var(--fail); }
  .scope-results .row.nt .status { color: var(--warn); }
  .scope-results .row.unknown .status { color: var(--muted-2); }
  .scope-results .row .scope-name { color: var(--text); }
  .scope-results .row .scope-why { color: var(--muted-2); margin-left: 4px; }

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 28px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }
  button {
    border: none;
    border-radius: 8px;
    padding: 11px 18px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    font-family: var(--sans);
    transition: background 0.15s, opacity 0.15s;
  }
  button.primary { background: var(--accent); color: white; margin-left: auto; }
  button.primary:hover { background: var(--accent-hover); }
  button.primary:disabled { opacity: 0.6; cursor: wait; }
  button.secondary {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
  }
  button.secondary:hover { color: var(--text); border-color: var(--border-2); }
  button.ghost {
    background: transparent;
    color: var(--muted);
    padding: 8px 12px;
  }
  button.ghost:hover { color: var(--text); }

  a.btn-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    padding: 12px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    margin: 8px 0;
    transition: border-color 0.15s;
  }
  a.btn-link:hover { border-color: var(--accent); }
  a.btn-link::after { content: "↗"; color: var(--muted); margin-left: 4px; }

  .footer-meta {
    width: 100%;
    max-width: 620px;
    text-align: center;
    color: var(--muted-2);
    font-size: 11px;
    padding: 14px 12px 0;
  }
  .file-path { font-family: var(--mono); }
</style>
</head>
<body>
<div class="wizard">
  <header>
    <div class="brand">Acendas Atlassian Wizard</div>
    <div class="progress">
      <span class="dot current" data-step="1"></span>
      <span class="dot" data-step="2"></span>
      <span class="dot" data-step="3"></span>
      <span class="dot" data-step="4"></span>
      <span class="dot" data-step="5"></span>
      <span class="step-label" id="step-label">Step 1 of 5</span>
    </div>
  </header>
  <main>
    <section class="section active" data-step="1">
      <h1>Welcome</h1>
      <p class="lede">Set up your Atlassian credentials for Claude Code. Tokens stay on your machine — they're posted to localhost only and never enter the chat transcript.</p>
      <div class="chip-row" id="status-chips">
        <span class="chip" data-product="atlassian"><span class="check">●</span> Atlassian Cloud</span>
        <span class="chip" data-product="jira"><span class="check">●</span> Jira</span>
        <span class="chip" data-product="confluence"><span class="check">●</span> Confluence</span>
        <span class="chip" data-product="bitbucket"><span class="check">●</span> Bitbucket</span>
      </div>
      <div class="actions">
        <button class="primary" onclick="next()">Get started →</button>
      </div>
    </section>

    <section class="section" data-step="2">
      <h1>What are you configuring?</h1>
      <p class="lede">Jira + Confluence come from the same Atlassian tenant and share auth. Bitbucket uses a separate issuer and always needs its own token.</p>
      <div class="product-list">
        <button class="product-card" onclick="pickSurface('atlassian')">
          <div class="icon">A</div>
          <div class="text-col">
            <div class="name">Jira + Confluence</div>
            <div class="desc">One tenant. You'll pick between a single classic token or two scoped tokens on the next step.</div>
            <div class="meta" id="meta-atlassian"></div>
          </div>
          <div class="right" id="badge-atlassian">not set</div>
        </button>
        <button class="product-card" onclick="pickSurface('bitbucket')">
          <div class="icon">B</div>
          <div class="text-col">
            <div class="name">Bitbucket</div>
            <div class="desc">Separate Bitbucket API token (bitbucket.org/account/settings/api-tokens/). Repositories, pull requests, pipelines.</div>
            <div class="meta" id="meta-bitbucket"></div>
          </div>
          <div class="right" id="badge-bitbucket">not set</div>
        </button>
      </div>
      <div class="actions">
        <button class="ghost" onclick="back()">← Back</button>
      </div>
    </section>

    <section class="section" data-step="2b">
      <h1>Classic or scoped?</h1>
      <p class="lede">Both work. Classic is simpler; scoped is least-privilege.</p>
      <div class="product-list">
        <button class="product-card" onclick="pickMode('classic')">
          <div class="icon">1</div>
          <div class="text-col">
            <div class="name">Classic — one-shot (recommended)</div>
            <div class="desc">One unscoped Atlassian API token covers Jira + Confluence. Single form. Full account permissions.</div>
          </div>
          <div class="right">1 token</div>
        </button>
        <button class="product-card" onclick="pickMode('scoped')">
          <div class="icon">2</div>
          <div class="text-col">
            <div class="name">Scoped — separate tokens per product</div>
            <div class="desc">Two scoped tokens (Jira-only and Confluence-only). You'll configure Jira first, then Confluence. Least-privilege.</div>
          </div>
          <div class="right">2 tokens</div>
        </button>
      </div>
      <div class="actions">
        <button class="ghost" onclick="back()">← Back</button>
      </div>
    </section>

    <section class="section" data-step="3">
      <h1>Generate your <span id="step3-product">…</span> token</h1>
      <p class="lede" id="step3-lede">Create a scoped API token on Atlassian's identity page, then paste it on the next screen.</p>
      <div class="privacy-note" id="step3-warn" style="background: rgba(251, 191, 36, 0.07); border-color: rgba(251, 191, 36, 0.25);">
        <b>⚠️</b>
        <span>Each product needs its <b>own token</b>. A token created under the Jira app won't work for Confluence or Bitbucket — the scopes are app-bound. Make sure you pick the <b id="step3-app-warn">…</b> app on the next page, not whatever app is selected by default.</span>
      </div>
      <ol class="steps" id="step3-steps">
        <li>Click <b>Open token page</b> below — it opens in a new tab.</li>
        <li>Click <b>Create API token with scopes</b>.</li>
        <li>Pick the <b id="step3-app">…</b> app (this is the easy step to get wrong).</li>
        <li>Tick the scopes shown below, then create the token.</li>
        <li>Copy the token to your clipboard — you won't see it again after closing the dialog.</li>
      </ol>
      <div class="scope-box" id="scope-checklist">…</div>
      <a class="btn-link" id="open-token-page" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">Open token page</a>
      <div class="actions">
        <button class="ghost" onclick="back()">← Back</button>
        <button class="primary" onclick="next()">I have my token →</button>
      </div>
    </section>

    <section class="section" data-step="4">
      <h1>Enter your <span id="step4-product">…</span> credentials</h1>
      <p class="lede">Just three fields. Paste the token directly into the textarea — no length limit.</p>
      <form onsubmit="event.preventDefault(); save();" autocomplete="off">
        <div class="field" data-field="url">
          <label for="f-url" id="lbl-url">Site URL</label>
          <input id="f-url" type="text" name="url" autocomplete="off" />
          <span class="hint" id="hint-url"></span>
        </div>
        <div class="field" data-field="workspace">
          <label for="f-workspace">Workspace slug</label>
          <input id="f-workspace" type="text" name="workspace" autocomplete="off" />
          <span class="hint">The <code>&lt;workspace&gt;</code> in <code>bitbucket.org/&lt;workspace&gt;/…</code></span>
        </div>
        <div class="field">
          <label for="f-email">Atlassian email</label>
          <input id="f-email" type="email" name="email" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-token">API token</label>
          <textarea id="f-token" name="token" rows="3" spellcheck="false" autocomplete="off" placeholder="ATATT3xFfGF0…"></textarea>
        </div>
        <div class="privacy-note">
          <b>🔒</b>
          <span>Your token is sent only to <b>localhost</b> via this page. It's written directly to your config file. It never touches the Claude Code chat transcript.</span>
        </div>
      </form>
      <div class="actions">
        <button class="ghost" onclick="back()">← Back</button>
        <button class="primary" id="save-btn" onclick="save()">Save & test →</button>
      </div>
    </section>

    <section class="section" data-step="5">
      <h1 id="result-title">…</h1>
      <div id="result-summary"></div>
      <div class="scope-results" id="result-scopes"></div>
      <div class="actions" id="result-actions"></div>
    </section>
  </main>
</div>
<div class="footer-meta" id="footer-meta"></div>

<script>
const SECRET = "__SECRET__";
const Q = (s, root) => (root || document).querySelector(s);
const QA = (s, root) => Array.from((root || document).querySelectorAll(s));

const PRODUCT_LABEL = {
  jira: "Jira",
  confluence: "Confluence",
  bitbucket: "Bitbucket",
  atlassian: "Atlassian Cloud",
};
const PRODUCT_HINTS = {
  jira: { url: "Site URL", urlHint: "e.g. https://acme.atlassian.net", showWorkspace: false },
  confluence: { url: "Site URL", urlHint: "Typically https://acme.atlassian.net/wiki", showWorkspace: false },
  bitbucket: { url: null, urlHint: "", showWorkspace: true },
  // Atlassian (classic) mode: single tenant URL covers both Jira + Confluence.
  // We auto-derive confluence.url = tenant/wiki on the backend.
  atlassian: { url: "Atlassian tenant URL", urlHint: "e.g. https://acme.atlassian.net (no /wiki)", showWorkspace: false },
};

let state = {
  step: 1,
  // surface: "atlassian" (Jira + Confluence) or "bitbucket". Drives whether
  // the mode-picker step (2b) is shown.
  surface: null,
  // mode: for surface=atlassian, "classic" (single token covers both) or
  // "scoped" (two tokens, configured sequentially — Jira then Confluence).
  mode: null,
  // product: the concrete product the current step is saving creds for.
  //   surface=atlassian + mode=classic  → product="atlassian" (shared)
  //   surface=atlassian + mode=scoped   → product="jira" then "confluence"
  //   surface=bitbucket                 → product="bitbucket"
  product: null,
  scopes: null,
  config: null,
};

async function api(path, opts = {}) {
  const url = path + (path.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(SECRET);
  const res = await fetch(url, opts);
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// Steps the user walks through, in order. "2b" is the mode-picker,
// only visited when surface=atlassian. Total dots shown on the progress
// bar is derived from this list so Bitbucket doesn't see a phantom dot.
function pathForSurface(surface) {
  if (surface === "bitbucket") return [1, 2, 3, 4, 5];
  return [1, 2, "2b", 3, 4, 5];
}

function gotoStep(n) {
  state.step = n;
  QA(".section").forEach(s => s.classList.toggle("active", String(s.dataset.step) === String(n)));
  // Render progress dots based on the current path.
  const path = pathForSurface(state.surface);
  const total = path.length;
  const idx = path.indexOf(n);
  const progress = Q(".progress");
  if (progress) {
    const dots = QA(".dot", progress);
    // Ensure enough dots exist (HTML ships with 5; mode-picker path needs 6).
    while (dots.length < total) {
      const d = document.createElement("span");
      d.className = "dot";
      progress.insertBefore(d, Q("#step-label"));
      dots.push(d);
    }
    QA(".dot", progress).forEach((d, i) => {
      const visible = i < total;
      d.style.display = visible ? "" : "none";
      d.classList.toggle("done", visible && i < idx);
      d.classList.toggle("current", visible && i === idx);
    });
  }
  Q("#step-label").textContent = idx >= 0
    ? "Step " + (idx + 1) + " of " + total
    : "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (n === 3) renderStep3();
  if (n === 4) renderStep4();
}

function next() {
  if (state.step === 1) gotoStep(2);
  else if (state.step === 3) gotoStep(4);
}

function back() {
  const p = state.step;
  if (p === 2) return gotoStep(1);
  if (p === "2b") return gotoStep(2);
  if (p === 3) return gotoStep(state.surface === "atlassian" ? "2b" : 2);
  if (p === 4) return gotoStep(3);
  if (p === 5) return gotoStep(2);
}

// Outer pick: Atlassian (Jira + Confluence) or Bitbucket.
function pickSurface(s) {
  state.surface = s;
  if (s === "bitbucket") {
    state.mode = null;
    state.product = "bitbucket";
    gotoStep(3);
  } else {
    // Go to mode picker.
    gotoStep("2b");
  }
}

// Mode pick (only meaningful when surface=atlassian).
function pickMode(m) {
  state.mode = m;
  // Classic mode → one "atlassian" product step. Scoped → start with jira.
  state.product = m === "classic" ? "atlassian" : "jira";
  gotoStep(3);
}

// Continue to the next product after a scoped-mode save (Jira → Confluence).
function continueScoped() {
  state.product = "confluence";
  gotoStep(3);
}

function renderStep3() {
  const p = state.product;
  Q("#step3-product").textContent = PRODUCT_LABEL[p];
  Q("#step3-app").textContent = PRODUCT_LABEL[p];
  Q("#step3-app-warn").textContent = PRODUCT_LABEL[p];

  // Atlassian (classic) mode: no scope picker. Classic tokens aren't
  // scope-bound — they inherit the user's full Atlassian permissions.
  // Show a simpler instruction card instead of a scope checklist, and
  // rewrite the lede + steps so the wording matches the classic flow.
  if (p === "atlassian") {
    Q("#step3-lede").innerHTML =
      "Create a classic (unscoped) Atlassian API token — one token that works for both Jira and Confluence.";
    Q("#step3-warn").innerHTML =
      '<b>ℹ️</b><span>Classic tokens carry your full Atlassian account permissions. If you need least-privilege scoping, go back and pick Jira + Confluence individually (scoped tokens are one-product-only).</span>';
    Q("#step3-steps").innerHTML =
      "<li>Click <b>Open token page</b> below — it opens in a new tab.</li>" +
      "<li>Click <b>Create API token</b> (<i>not</i> &ldquo;Create API token with scopes&rdquo;).</li>" +
      "<li>Give it any label (e.g. &ldquo;Claude Code&rdquo;). Expiration is up to you.</li>" +
      "<li>Copy the token — you won't see it again after closing the dialog.</li>";
    Q("#scope-checklist").innerHTML =
      '<div class="group-label">No scopes to tick</div>' +
      '<div class="scope-line"><span class="check">ℹ</span><span class="name">Classic Atlassian API tokens have no scope selection — they inherit your account permissions. Jira + Confluence both work with this single token.</span></div>';
    return;
  }

  // Scoped mode: restore the default lede/warn/steps text in case the
  // user toggled back from atlassian mode.
  Q("#step3-lede").innerHTML =
    "Create a scoped API token on Atlassian's identity page, then paste it on the next screen.";
  Q("#step3-warn").innerHTML =
    '<b>⚠️</b><span>Each product needs its <b>own token</b>. A token created under the Jira app won\'t work for Confluence or Bitbucket — the scopes are app-bound. Make sure you pick the <b>' +
    escapeHtml(PRODUCT_LABEL[p]) +
    '</b> app on the next page, not whatever app is selected by default.</span>';
  Q("#step3-steps").innerHTML =
    "<li>Click <b>Open token page</b> below — it opens in a new tab.</li>" +
    "<li>Click <b>Create API token with scopes</b>.</li>" +
    "<li>Pick the <b>" + escapeHtml(PRODUCT_LABEL[p]) + "</b> app (this is the easy step to get wrong).</li>" +
    "<li>Tick the scopes shown below, then create the token.</li>" +
    "<li>Copy the token to your clipboard — you won't see it again after closing the dialog.</li>";

  const scopes = (state.scopes && state.scopes[p]) || [];
  const hasFamilies = scopes.some(s => s.family);

  const renderGroup = (label, items, extraClass) => {
    if (!items.length) return "";
    let h = '<div class="group-label ' + (extraClass || "") + '">' + escapeHtml(label) + '</div>';
    for (const s of items) {
      h += '<div class="scope-line' + (extraClass === "optional" ? " optional" : "") +
        '"><span class="check">☐</span><span class="name">' + escapeHtml(s.scope) +
        '</span><span class="why">' + escapeHtml(s.why) + '</span></div>';
    }
    return h;
  };

  let html = "";
  if (hasFamilies) {
    // Confluence — split by family so users see "these are for v2, these
    // are for v1 fallback" without parsing scope-name prefixes.
    const families = [
      { key: "granular", label: "GRANULAR family (modern v2 endpoints)" },
      { key: "classic",  label: "CLASSIC family (v1 fallbacks)" },
    ];
    for (const f of families) {
      const inFam = scopes.filter(s => s.family === f.key);
      if (!inFam.length) continue;
      html += '<div class="group-label family">' + escapeHtml(f.label) + '</div>';
      html += renderGroup("Required — tick all of these", inFam.filter(s => s.required));
      html += renderGroup("Optional — tick if you want the matching tools",
                          inFam.filter(s => !s.required), "optional");
    }
  } else {
    html += renderGroup("Required — tick all of these", scopes.filter(s => s.required));
    html += renderGroup("Optional — tick if you want the matching tools",
                        scopes.filter(s => !s.required), "optional");
  }
  Q("#scope-checklist").innerHTML = html;
}

function renderStep4() {
  const p = state.product;
  Q("#step4-product").textContent = PRODUCT_LABEL[p];
  const cfg = (state.config && state.config[p]) || {};
  const shared = (state.config && state.config.atlassian) || {};
  const meta = PRODUCT_HINTS[p];

  Q('[data-field="url"]').style.display = meta.url ? "" : "none";
  Q('[data-field="workspace"]').style.display = meta.showWorkspace ? "" : "none";

  if (meta.url) {
    Q("#lbl-url").textContent = meta.url;
    Q("#hint-url").textContent = meta.urlHint;
    Q("#f-url").value = cfg.url || "";
  }
  if (meta.showWorkspace) {
    Q("#f-workspace").value = cfg.workspace || "";
  }
  Q("#f-email").value = cfg.username || shared.username || "";
  Q("#f-token").value = "";
  setTimeout(() => {
    if (meta.url && !Q("#f-url").value) Q("#f-url").focus();
    else if (meta.showWorkspace && !Q("#f-workspace").value) Q("#f-workspace").focus();
    else if (!Q("#f-email").value) Q("#f-email").focus();
    else Q("#f-token").focus();
  }, 50);
}

async function save() {
  const p = state.product;
  const meta = PRODUCT_HINTS[p];
  const data = { email: Q("#f-email").value.trim(), token: Q("#f-token").value };
  if (meta.url) data.url = Q("#f-url").value.trim();
  if (meta.showWorkspace) data.workspace = Q("#f-workspace").value.trim();

  if (!data.token) {
    Q("#f-token").focus();
    Q("#f-token").style.borderColor = "var(--fail)";
    return;
  }
  Q("#f-token").style.borderColor = "";

  const btn = Q("#save-btn");
  btn.disabled = true;
  btn.textContent = "Saving + testing…";

  try {
    const result = await api("/save/" + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!result.ok) {
      btn.disabled = false;
      btn.textContent = "Save & test →";
      alert("Save failed: " + (result.error || "unknown"));
      return;
    }
    state.config = await api("/state");
    refreshChips();
    renderResult(result.verify);
    gotoStep(5);
  } catch (e) {
    alert("Network error: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save & test →";
  }
}

function renderResult(v) {
  const p = state.product;
  const title = Q("#result-title");
  const summaryBox = Q("#result-summary");
  const scopeBox = Q("#result-scopes");
  const actions = Q("#result-actions");

  if (v.skipped) {
    title.textContent = "Couldn't run the test";
    summaryBox.innerHTML = '<div class="verify-summary fail"><div class="headline"><span class="icon">!</span> Missing fields</div><div class="sub">' + escapeHtml(v.skipReason) + '</div></div>';
    scopeBox.innerHTML = "";
  } else if (v.requiredOk) {
    title.textContent = PRODUCT_LABEL[p] + " is configured";
    summaryBox.innerHTML = '<div class="verify-summary ok"><div class="headline"><span class="icon">✓</span> Authenticated as ' + escapeHtml(v.auth.who) + '</div><div class="sub">All required scopes granted. Restart Claude Code to pick up the new credentials.</div></div>';
    scopeBox.innerHTML = renderScopeRows(v.scopes);
  } else if (v.auth.status !== "ok") {
    title.textContent = "Authentication failed";
    summaryBox.innerHTML = '<div class="verify-summary fail"><div class="headline"><span class="icon">×</span> ' + escapeHtml(v.auth.detail || v.auth.status) + '</div><div class="sub">Double-check the URL, email, and token, then try again.</div></div>';
    scopeBox.innerHTML = "";
  } else {
    title.textContent = "Token is missing scopes";
    summaryBox.innerHTML = '<div class="verify-summary fail"><div class="headline"><span class="icon">!</span> ' + escapeHtml(v.auth.who) + '</div><div class="sub">Tokens cannot have scopes added after creation. Generate a new token with the missing scopes ticked.</div></div>';
    scopeBox.innerHTML = renderScopeRows(v.scopes);
  }

  let btns = "";
  if (v.requiredOk) {
    // In scoped mode after finishing Jira, offer to continue with Confluence.
    const needsConfluenceNext =
      state.surface === "atlassian" &&
      state.mode === "scoped" &&
      state.product === "jira";
    if (needsConfluenceNext) {
      btns += '<button class="secondary" onclick="gotoStep(2)">Back to start</button>';
      btns += '<button class="primary" onclick="continueScoped()">Next: Configure Confluence →</button>';
    } else {
      btns += '<button class="secondary" onclick="gotoStep(2)">Configure another surface</button>';
      btns += '<button class="primary" onclick="finish()">Done — close wizard</button>';
    }
  } else if (v.auth.status === "ok") {
    btns += '<button class="ghost" onclick="window.open(\'https://id.atlassian.com/manage-profile/security/api-tokens\', \'_blank\')">Open token page</button>';
    btns += '<button class="primary" onclick="gotoStep(3)">Generate a new token</button>';
  } else {
    btns += '<button class="primary" onclick="gotoStep(4)">Try again</button>';
  }
  actions.innerHTML = btns;
}

function renderScopeRows(scopes) {
  // When scopes come from "atlassian" mode they carry _product tags so
  // the UI can group by product. Split + render under headings.
  const hasProductTags = scopes.some(s => s._product);
  if (hasProductTags) {
    const groups = { jira: [], confluence: [] };
    for (const s of scopes) groups[s._product || "jira"].push(s);
    let html = "";
    for (const key of ["jira", "confluence"]) {
      if (!groups[key].length) continue;
      html += '<div class="group-label" style="color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 4px">' +
        escapeHtml(PRODUCT_LABEL[key]) + '</div>';
      html += groups[key].map(renderOneScopeRow).join("");
    }
    return html;
  }
  return scopes.map(renderOneScopeRow).join("");
}

function renderOneScopeRow(s) {
  let cls = "row";
  let tag = "";
  if (s.status === "ok") { cls += " ok"; tag = "OK"; }
  else if (s.status === "missing") { cls += " miss"; tag = "MISSING"; }
  else if (s.status === "auth_fail") { cls += " miss"; tag = "AUTH FAIL"; }
  else if (s.status === "not_tested") { cls += " nt"; tag = "NOT TESTED"; }
  else { cls += " unknown"; tag = "?"; }
  const opt = s.required ? "" : ' <span style="color:var(--muted-2)">(optional)</span>';
  return '<div class="' + cls + '"><span class="status">' + tag + '</span><span class="scope-name">' + escapeHtml(s.scope) + opt + '</span><span class="scope-why">' + escapeHtml(s.why || "") + '</span></div>';
}

async function finish() {
  try { await api("/done", { method: "POST" }); } catch {}
  document.body.innerHTML = '<div style="text-align:center;padding:80px 20px;color:#8aa0c7;font-family:-apple-system,sans-serif"><div style="font-size:42px;margin-bottom:14px">✓</div><h2 style="color:#f0f3fa;margin:0 0 8px;font-weight:600">Wizard closed</h2><p style="margin:0">You can close this tab. Restart Claude Code to use the new credentials.</p></div>';
}

function refreshChips() {
  // Per-product chips + cards.
  for (const p of ["jira", "confluence", "bitbucket"]) {
    const chip = Q('#status-chips .chip[data-product="' + p + '"]');
    const cfg = state.config && state.config[p];
    const shared = state.config && state.config.atlassian;
    // A product counts as "set" if it has its own api_token OR the shared
    // atlassian.api_token is set AND the product has a url (Jira+Confluence).
    const hasOwnToken = cfg && cfg.api_token;
    const inheritsFromShared =
      shared && shared.api_token && (p === "jira" || p === "confluence") && cfg && cfg.url;
    const isSet = !!(hasOwnToken || inheritsFromShared);
    if (chip) {
      chip.classList.toggle("set", !!isSet);
      chip.querySelector(".check").textContent = isSet ? "✓" : "●";
    }
    const badge = Q("#badge-" + p);
    const meta = Q("#meta-" + p);
    if (badge) {
      badge.textContent = isSet
        ? (inheritsFromShared && !hasOwnToken ? "via Atlassian token" : "configured")
        : "not set";
      badge.classList.toggle("set", !!isSet);
    }
    if (meta) {
      if (isSet) {
        const detail = cfg.url || cfg.workspace || "";
        const tokenBit = hasOwnToken ? cfg.api_token : (inheritsFromShared ? shared.api_token : "");
        meta.textContent = (detail ? detail + "  •  " : "") + (tokenBit || "");
      } else {
        meta.textContent = "";
      }
    }
  }

  // Atlassian (classic) card on step 2 + chip on step 1.
  const aBadge = Q("#badge-atlassian");
  const aMeta = Q("#meta-atlassian");
  const shared = state.config && state.config.atlassian;
  const atlSet = !!(shared && shared.api_token);
  const aChip = Q('#status-chips .chip[data-product="atlassian"]');
  if (aChip) {
    aChip.classList.toggle("set", atlSet);
    aChip.querySelector(".check").textContent = atlSet ? "✓" : "●";
  }
  if (aBadge) {
    aBadge.textContent = atlSet ? "configured" : "not set";
    aBadge.classList.toggle("set", atlSet);
  }
  if (aMeta) {
    if (atlSet) {
      const j = state.config.jira || {};
      aMeta.textContent = (j.url || "") + (j.url ? "  •  " : "") + (shared.api_token || "");
    } else {
      aMeta.textContent = "";
    }
  }
}

(async () => {
  try {
    state.scopes = await api("/scopes");
    state.config = await api("/state");
    Q("#footer-meta").innerHTML = 'Config: <span class="file-path">' + escapeHtml(state.config.file) + '</span>';
    refreshChips();
  } catch (e) {
    document.body.innerHTML = '<div style="padding:60px 20px;color:#f87171;font-family:-apple-system,sans-serif"><h2>Failed to load</h2><p>' + escapeHtml(e.message) + '</p></div>';
  }
})();
</script>
</body>
</html>`;
  return html.replace(/__SECRET__/g, secret);
}

main().catch((err) => {
  console.error(`error: ${err.message || err}`);
  process.exit(1);
});
