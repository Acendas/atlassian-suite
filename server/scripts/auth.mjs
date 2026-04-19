#!/usr/bin/env node
// auth.mjs — interactive credential setup for the Acendas Atlassian Suite.
//
// Writes directly to ~/.acendas-atlassian/config.json (mode 0600) using the
// same atomic-write + rolling-backup semantics as the MCP server's
// configure_credentials tool. Zero dependencies; works on macOS, Linux, Windows.
//
// Usage:
//   node auth.mjs open-url              # open token-generation page in default browser
//   node auth.mjs jira                  # configure Jira (url + email + token, interactive)
//   node auth.mjs confluence            # configure Confluence (url + email + token, interactive)
//   node auth.mjs bitbucket             # configure Bitbucket (workspace + email + token, interactive)
//   node auth.mjs shared                # configure shared Atlassian identity (email + token, interactive)
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
  "Usage: node auth.mjs {open-url|jira|confluence|bitbucket|shared|scopes|verify|status}";

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
      probe: { method: "GET", path: "/rest/api/3/search/jql?jql=order+by+created&fields=summary&maxResults=0" },
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
    {
      scope: "read:confluence-space.summary",
      required: true,
      why: "list spaces",
      probe: { method: "GET", path: "/wiki/api/v2/spaces?limit=1" },
    },
    {
      scope: "read:confluence-content.all",
      required: true,
      why: "read pages + attachments",
      probe: { method: "GET", path: "/wiki/api/v2/pages?limit=1" },
    },
    {
      scope: "write:confluence-content",
      required: true,
      why: "create/edit pages, add comments",
      probe: { method: "POST", path: "/wiki/api/v2/pages", body: "{}" },
    },
    {
      scope: "read:confluence-user",
      required: false,
      why: "look up users",
      probe: { method: "GET", path: "/wiki/rest/api/user/current" },
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

async function verifyProduct(product, cfg) {
  const creds = resolveCreds(product, cfg);

  // Preflight — do we have enough to probe at all?
  if (product === "bitbucket") {
    if (!creds.username || !creds.apiToken || !creds.workspace) {
      console.log(`  bitbucket: SKIP (missing workspace/username/token)`);
      return false;
    }
  } else {
    if (!creds.url || !creds.username || !creds.apiToken) {
      console.log(`  ${product}: SKIP (missing url/username/token)`);
      return false;
    }
  }

  console.log(`  ${product}:`);

  // Basic whoami to confirm the token authenticates at all before drilling into scopes.
  const whoami = await whoamiProbe(product, creds);
  if (whoami.status === "auth-failed") {
    console.log(
      `    auth:            FAIL (${whoami.detail}) — fix email+token before checking scopes`,
    );
    return false;
  }
  if (whoami.status === "url-wrong") {
    console.log(`    auth:            FAIL (${whoami.detail})`);
    return false;
  }
  if (whoami.status === "network") {
    console.log(`    auth:            FAIL (${whoami.detail})`);
    return false;
  }
  console.log(`    auth:            OK (${whoami.who})`);

  // Per-scope probing.
  let requiredOk = true;
  for (const spec of SCOPES[product]) {
    const label = spec.scope.padEnd(32, " ");
    if (!spec.probe) {
      const tag = spec.required ? "NOT_TESTED (required)" : "NOT_TESTED";
      console.log(`    ${label} ${tag} — ${spec.why}`);
      continue;
    }
    const result = await scopeProbe(product, creds, spec);
    const flag = spec.required ? " (required)" : "";
    if (result === "ok") {
      console.log(`    ${label} OK${flag}`);
    } else if (result === "missing") {
      console.log(`    ${label} MISSING${flag} — needed to ${spec.why}`);
      if (spec.required) requiredOk = false;
    } else if (result === "auth") {
      console.log(`    ${label} FAIL (auth)${flag}`);
      if (spec.required) requiredOk = false;
    } else {
      console.log(`    ${label} UNKNOWN${flag} — ${result}`);
    }
  }

  return requiredOk;
}

async function whoamiProbe(product, creds) {
  let url;
  if (product === "jira") {
    url = `${stripTrailingSlash(creds.url)}/rest/api/3/myself`;
  } else if (product === "confluence") {
    url = `${wikiBase(creds.url)}/rest/api/user/current`;
  } else {
    url = "https://api.bitbucket.org/2.0/user";
  }
  const res = await httpFetch({ url, username: creds.username, token: creds.apiToken });
  if (res.kind === "network") return { status: "network", detail: res.detail };
  if (res.status === 401) return { status: "auth-failed", detail: "401 — email or token wrong" };
  if (res.status === 404) return { status: "url-wrong", detail: "404 — check the URL" };
  if (res.status >= 200 && res.status < 300) {
    const body = await safeJson(res.response);
    const who =
      body?.emailAddress ||
      body?.email ||
      body?.username ||
      body?.display_name ||
      body?.displayName ||
      body?.accountId ||
      body?.account_id ||
      "(ok)";
    return { status: "ok", who };
  }
  // 403 on whoami is unusual but can indicate the token has NO scopes at all.
  if (res.status === 403) return { status: "auth-failed", detail: "403 — token likely has no scopes at all" };
  return { status: "auth-failed", detail: `HTTP ${res.status}` };
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
  // 401 → bad auth (we already passed whoami though, so this is weird; still report).
  if (s === 401) return "auth";
  // 403 → scope missing, or other permission issue.
  if (s === 403) return "missing";
  // 404 → URL mismatch. Usually workspace has no repos yet or user has no PRs — treat as ok-ish.
  if (s === 404) return spec.scope.startsWith("read:") ? "ok" : "missing";
  // Anything else → unknown.
  return `HTTP ${s}`;
}

function resolveProbeUrl(product, creds, path) {
  if (path.startsWith("http")) {
    return path
      .replace("{workspace}", encodeURIComponent(creds.workspace || ""))
      .replace("{username}", encodeURIComponent(creds.username || ""));
  }
  const base = product === "confluence" ? wikiBase(creds.url) : stripTrailingSlash(creds.url);
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

function printScopeSuggestion(product) {
  const list = SCOPES[product];
  if (!list) return;
  const required = list.filter((s) => s.required);
  const optional = list.filter((s) => !s.required);
  console.log("");
  console.log(`  ┌─ Scopes to tick on the token-creation page (${product})`);
  console.log("  │");
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

main().catch((err) => {
  console.error(`error: ${err.message || err}`);
  process.exit(1);
});
