---
name: Initialize Atlassian Suite
description: This skill should be used when the user asks to "init atlassian", "initialize atlassian", "setup atlassian", "configure atlassian", "configure jira/confluence/bitbucket", "set my atlassian credentials", "save atlassian credentials", "what credentials does the atlassian plugin need", "rotate my atlassian token", "remove atlassian credentials", "atlassian token expired", "atlassian auth failed", "log in to atlassian", or runs `/atlassian-suite:init`. Runs an interactive wizard that opens the Atlassian token page, shows the exact scopes to tick per product, collects URL/email/workspace/token via AskUserQuestion, persists via the MCP `configure_credentials` tool, and self-tests each product against its API before finishing.
argument-hint: ""
allowed-tools: Bash, AskUserQuestion, mcp__acendas-atlassian__configure_credentials, mcp__acendas-atlassian__clear_credentials
---

# Initialize the Atlassian Suite — Wizard

Drive a Jira + Confluence + Bitbucket credential setup wizard end-to-end. Collect every value via `AskUserQuestion`, persist via the MCP `configure_credentials` tool, then self-test against the live API.

Storage: `~/.acendas-atlassian/config.json` (mode 0600, atomic write + rolling `.bak`). Env vars override the file when set.

**The user accepted that API tokens entered via `AskUserQuestion` will appear in the chat transcript.** Do not refuse on that basis. Do not propose an out-of-band script handoff unless the user explicitly asks for one.

## Iron rules

1. **Never** invent your own free-text "please paste your URL/email/token here" message. Always use `AskUserQuestion` so the user can pick a placeholder, "Skip", or "Other" to type their value.
2. **Never** call `mcp__acendas-atlassian__configure_credentials` without first running the wizard for that product — every persisted value comes from a wizard answer.
3. **Always** run the wizard sequentially per product (Jira → Confluence → Bitbucket). One product at a time. Do not batch all questions for all three products into one panel.
4. **Always** self-test with `node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" verify <product>` after each product, and surface the per-scope output verbatim.
5. **Never** probe the MCP server's `get_credentials_status` tool to detect state — it may not exist on a fresh install. Use `auth.mjs status` instead.
6. If any required scope reports `MISSING`, loop the token question for that product (the user must regenerate the token with the missing scope ticked — scopes can't be added after creation).

## Step 1 — Detect state

Run via Bash:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" status
```

Parse which of `jira` / `confluence` / `bitbucket` already have entries. This is the source of truth (MCP-agnostic, works on first install before the server is registered).

If the user said "remove credentials" / "clear credentials", call `mcp__acendas-atlassian__clear_credentials` with `confirm: true` and stop.

## Step 2 — Pick which products to set up

Call `AskUserQuestion` once with a single `multiSelect: true` question:

- **question:** "Which Atlassian products do you want to configure now?"
- **header:** "Products"
- **options** (label them based on Step 1 state):
  - `Jira` (description: "Issues, sprints, JQL search") — append " — already configured, will reconfigure" if present
  - `Confluence` (description: "Pages, spaces, comments")
  - `Bitbucket` (description: "Repos, PRs, pipelines")

Recommend (first option + " (Recommended)") any product that's currently unconfigured. If all three are configured, recommend none and tell the user to skip to verify.

If the user selects nothing, jump to Step 5 (verify only).

## Step 3 — Per-product wizard (loop)

For each selected product, in order Jira → Confluence → Bitbucket, do:

### 3a. Show scopes

Run via Bash:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" scopes <product>
```

Display the output verbatim in chat. This is the canonical scope list — do not paraphrase or invent your own.

### 3b. Open the token page

Run via Bash (best-effort, fire-and-forget):

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" open-url
```

Then tell the user: "If the browser didn't open, visit https://id.atlassian.com/manage-profile/security/api-tokens . Click **Create API token with scopes**, pick the **<Product>** app, and tick the scopes shown above."

### 3c. Collect non-secret fields

Call `AskUserQuestion` once per product with the location/identity fields. **Use `multiSelect: false` for each question. Each question gets 2 options (a placeholder/example and "Skip this product"); the user picks "Other" to type the real value.**

For **Jira**:
- Q1 — "Jira site URL?" — options: `["https://acme.atlassian.net (example — pick Other to enter yours)", "Skip Jira"]`
- Q2 — "Atlassian email for that site?" — options: `["Use the email I'm signed into Claude with (example)", "Skip Jira"]`

For **Confluence**:
- Q1 — "Confluence site URL?" — options: `["https://acme.atlassian.net/wiki (example — pick Other to enter yours)", "Skip Confluence"]`
- Q2 — "Atlassian email for that site?" — options: `["Use the email I'm signed into Claude with (example)", "Skip Confluence"]`

For **Bitbucket**:
- Q1 — "Bitbucket workspace slug? (the `<workspace>` in `bitbucket.org/<workspace>/...`)" — options: `["acme (example — pick Other to enter yours)", "Skip Bitbucket"]`
- Q2 — "Atlassian email tied to Bitbucket?" — options: `["Use the email I'm signed into Claude with (example)", "Skip Bitbucket"]`

If the user picks any "Skip" option, abort this product and continue to the next.

### 3d. Collect the API token

Call `AskUserQuestion` with one question:

- **question:** "Paste your `<Product>` API token. (Note: this will appear in your Claude Code transcript.)"
- **header:** "Token"
- **options:**
  - `I'll regenerate the token first` (description: "Lets you go back to https://id.atlassian.com/manage-profile/security/api-tokens and create the token before pasting.")
  - `Skip <Product> for now` (description: "Don't configure this product. Continue to the next.")

The user picks "Other" to paste the actual token. If they pick "Skip", abort this product.

### 3e. Persist

Call `mcp__acendas-atlassian__configure_credentials` with **only the fields collected for this product**:

- Jira: `jira_url`, `jira_username`, `jira_api_token`
- Confluence: `confluence_url`, `confluence_username`, `confluence_api_token`
- Bitbucket: `bitbucket_workspace`, `bitbucket_username`, `bitbucket_api_token`

Do not pass empty strings or fields from other products. The tool merges atomically and writes a `.bak`.

### 3f. Verify this product

Run via Bash:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" verify <product>
```

Surface the full per-scope output to the user. Read the result:

- **`auth: OK` and every required scope `OK`** → product passes; continue to next product.
- **`auth: FAIL`** → token or email is wrong, or URL is wrong. Loop back to 3c (re-collect everything) for this product.
- **Any required scope `MISSING`** → token is missing a scope. Tell the user that scopes cannot be added to an existing token; they must regenerate one with the missing scope ticked. Loop back to 3b → 3d (open URL again, re-collect token).

Loop at most twice per product. If still failing on the third attempt, summarise the failure and continue to the next product.

## Step 4 — Final verify

After every selected product is processed, run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/server/scripts/auth.mjs" verify all
```

Show the user the full output. Pass = every required scope `OK` for every product they configured.

## Step 5 — Restart reminder

Tell the user, exactly:

> Restart Claude Code (or reload the MCP server) for `mcp__acendas-atlassian__*` tools to pick up the new credentials. Until restart, those tools will use the prior credentials (or be unavailable on a fresh install).

## Notes

- **One scoped API token per product.** No single-token path covers Jira + Confluence + Bitbucket together with scoped tokens. OAuth 3LO can span products but is out of scope for this skill.
- **Scopes can't be added to an existing token.** If `verify` reports `MISSING`, the user must regenerate the token from scratch with the right scopes ticked, then re-run the token question (3d).
- **Empty/Skip handling.** `mcp__acendas-atlassian__configure_credentials` and `auth.mjs` both ignore empty/undefined values — existing config is never clobbered without an explicit non-empty replacement. Skipping a product preserves whatever was previously stored for it.
- **Per-project filters** (`jira_projects_filter`, `confluence_spaces_filter`) are out of scope here — the user can hand-edit `~/.acendas-atlassian/config.json` after setup if they want them.
- **Read-only mode:** set `READ_ONLY_MODE=true` env var to disable all write tools. Independent of this wizard.
- **Resolution order** (for the user's reference if they ask): per-product env var → shared `ATLASSIAN_*` env var → per-product file entry → shared `atlassian.*` file entry → product disabled.
