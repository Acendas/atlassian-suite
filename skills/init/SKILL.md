---
name: Initialize Atlassian Suite
description: This skill should be used when the user asks to "init atlassian", "initialize atlassian", "setup atlassian", "configure atlassian", "configure jira/confluence/bitbucket", "set my atlassian credentials", "save atlassian credentials", "what credentials does the atlassian plugin need", "rotate my atlassian token", "remove atlassian credentials", "atlassian token expired", "atlassian auth failed", "log in to atlassian", or runs `/atlassian-suite:init`. Hands off to a localhost-only browser wizard (`auth.mjs web`) that opens the Atlassian token page, shows the exact OAuth scopes per product, accepts unbounded-length token paste in a real textarea, persists atomically to the config file, and self-tests against each product API. Tokens never appear in the Claude Code transcript.
argument-hint: ""
allowed-tools: Bash, mcp__acendas-atlassian__clear_credentials
---

# Initialize the Atlassian Suite — Browser Wizard Handoff

Drive credential setup by handing off to a local browser wizard. The wizard runs entirely on `127.0.0.1` with a one-time URL secret, accepts URL/email/workspace/token in a real HTML form (no length cap, real textarea for the token), atomically writes to `~/.acendas-atlassian/config.json` (mode 0600, rolling `.bak`), and self-tests each product against its API. Tokens never enter the Claude Code transcript.

**Only use the browser wizard for credential init.** Other skills in this plugin still use `AskUserQuestion` for short structured choices — that's appropriate for those flows. The web wizard exists because Atlassian API tokens are 190+ characters and hit `AskUserQuestion`'s single-line input cap.

## Iron rules

1. **Never** ask the user to paste an API token, URL, or email into the Claude Code chat. The wizard is the only collection mechanism.
2. **Never** call `mcp__acendas-atlassian__configure_credentials` from this skill — the wizard's `/save` endpoint does the persistence directly via the same atomic-write logic.
3. **Always** check state via `auth.mjs status` first (MCP-agnostic — works on first install before the MCP server is registered).
4. **Always** finish with `auth.mjs verify all` to surface the per-scope pass/fail summary in the chat.
5. If the wizard's TTY refuses (e.g. `!` runs in a non-interactive context that can't fork the browser), tell the user to run the same command directly in their own terminal and wait for them to confirm.

## What to do

### 1. Detect state

Run via Bash:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" status
```

Parse which of `jira` / `confluence` / `bitbucket` already have entries. Report a one-line summary to the user (e.g. "Jira + Confluence configured, Bitbucket missing").

If the user said "remove credentials" / "clear credentials" / "log out of atlassian", call `mcp__acendas-atlassian__clear_credentials` with `confirm: true` and stop.

### 2. Launch the browser wizard directly

Run the wizard via Bash with `run_in_background: true` — the script is a long-running HTTP server, not a one-shot, so do NOT block on it:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" web
```

The script auto-opens the user's default browser via `open` (macOS) / `start` (Windows) / `xdg-open` (Linux), so the wizard window pops up on its own. There is no TTY requirement — the HTTP server doesn't need stdin.

Then read stdout via `BashOutput` once (after a short beat, ~1–2 seconds is enough) and pull the line that starts with `Open: http://127.0.0.1:`. That's the one-time-secret-bound URL. Show it to the user as a fallback in case the browser didn't auto-open.

What the wizard does:
- Spins up an HTTP server on `127.0.0.1` at a random port, bound to a one-time URL secret (other localhost processes can't probe it).
- Stepped UI: Welcome → Pick product → Generate token (with scope checklist) → Paste credentials → Verify result. One product at a time.
- "Save & Test" per product → atomically writes that product's section to `~/.acendas-atlassian/config.json` → runs the same per-scope self-test the CLI verify uses → renders the result inline.
- "Done" in the browser shuts the server down. 30-min inactivity timeout otherwise.

**Do NOT** prefix the command with `!` and ask the user to paste it. **Do NOT** wait for the script to exit (it won't, until the user clicks Done in the browser). Run it in the background and let it do its thing.

### 3. Wait for the user

After launching the wizard, tell the user something like "Wizard is open in your browser — set up your credentials there, then come back and tell me 'done'." Then wait. Don't poll the background process; don't repeatedly call `BashOutput`. The user explicitly tells you when they're finished by their next message.

### 4. Final verify + restart reminder

When the user confirms they've finished the wizard, run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" verify all
```

Surface the full output. Pass = every required scope `OK` for every product they configured.

Then tell the user, exactly:

> Restart Claude Code (or reload the MCP server) for `mcp__acendas-atlassian__*` tools to pick up the new credentials. Until restart, those tools will use the prior credentials (or be unavailable on a fresh install).

### 5. If a required scope is MISSING

The verify output will show `MISSING (required)` for any scope the token doesn't have. Tokens **cannot have scopes added after creation** — the user must:

1. Go back to <https://id.atlassian.com/manage-profile/security/api-tokens>
2. Create a fresh token with the missing scope ticked
3. Re-run the wizard (`! node ${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs web`) and paste the new token

Tell them this verbatim if you see `MISSING` — don't try to work around it.

## Notes

- **Two token modes — picked on the wizard's product-picker step.**
  - **Atlassian Cloud (classic token)** — one unscoped token covers both Jira + Confluence (Bitbucket still needs its own). Simpler, inherits full account permissions. Recommended if you don't care about least-privilege.
  - **Scoped tokens** — one token per product (Jira-only, Confluence-only, Bitbucket-only). Pick the individual product cards for this flow. Atlassian's token UI forces a single product per scoped token, so this path is intentionally one-at-a-time.
- **Bitbucket is always separate.** Bitbucket tokens are issued at `bitbucket.org/account/settings/api-tokens/`, not `id.atlassian.com`, regardless of classic vs scoped.
- **Localhost-only.** The wizard binds to `127.0.0.1` exclusively — never `0.0.0.0`. The URL secret prevents other processes on the same machine from posting to `/save`.
- **Token never in transcript.** The token travels: browser textarea → `POST http://127.0.0.1:<port>/save/<product>` → atomic file write. The wizard returns only structured pass/fail to the page, never echoes the token.
- **Empty/skip handling.** Leaving a panel blank in the wizard does nothing — existing config for that product is preserved. The user can run the wizard again any time to add or rotate one product without touching the others.
- **Per-project filters** (`jira_projects_filter`, `confluence_spaces_filter`) are out of scope for this wizard — hand-edit `~/.acendas-atlassian/config.json` after setup if you want them.
- **Read-only mode:** set `READ_ONLY_MODE=true` env var to disable all write tools. Independent of this wizard.
- **Resolution order** (for the user's reference if they ask): per-product env var → shared `ATLASSIAN_*` env var → per-product file entry → shared `atlassian.*` file entry → product disabled.
- **Backup**: every wizard save copies the prior config to `~/.acendas-atlassian/config.json.bak` first. Recover with `mv config.json.bak config.json`.
