---
name: Initialize Atlassian Suite
description: This skill should be used when the user asks to "init atlassian", "initialize atlassian", "setup atlassian", "configure atlassian", "configure jira/confluence/bitbucket", "set my atlassian credentials", "save atlassian credentials", "what credentials does the atlassian plugin need", "rotate my atlassian token", "remove atlassian credentials", or runs `/atlassian-suite:init`. Walks the user through configuring credentials for the Acendas Atlassian Suite — file-based by default, env-var fallback for CI.
argument-hint: ""
allowed-tools: Bash, Read, Write, Edit, mcp__acendas-atlassian__configure_credentials, mcp__acendas-atlassian__get_credentials_status, mcp__acendas-atlassian__clear_credentials, mcp__acendas-atlassian__setup_bitbucket
---

# Initialize the Atlassian Suite

Configure credentials for the unified Acendas Atlassian Suite MCP server (Jira Cloud + Confluence Cloud + Bitbucket Cloud). Default storage is `~/.acendas-atlassian/config.json` (mode 0600, owner-only, atomic-write with rolling backup). Env vars override the file when set.

## What to do

1. **Check current state.** Call `mcp__acendas-atlassian__get_credentials_status`. Report:
   - Whether the file exists, its path, and its permissions
   - What's stored on file (token values masked: `ATAT...xyz9 (192 chars)`)
   - What's currently effective per product (Jira / Confluence / Bitbucket)
   - For each value, the resolution source (`env:JIRA_USERNAME`, `env:ATLASSIAN_USERNAME`, or `file`)

2. **Decide the path:**
   - **First-time init** (no file, no env vars) → go to step 3.
   - **Adding a missing product** (e.g. file has Jira+Confluence, missing Bitbucket) → go to step 3, only ask for the missing fields.
   - **Token rotation** → ask for the new token only, call `configure_credentials` with just `atlassian_api_token` (or per-product if they use different tokens). Existing fields are preserved.
   - **Clearing credentials** → confirm, then `clear_credentials` with `confirm: true`. Tell user env vars are unaffected.
   - **Already fully configured** → skip to step 5 (verification).

3. **Collect what's needed — IMPORTANT: Jira/Confluence and Bitbucket use SEPARATE credentials.**

   Explain this to the user upfront:
   > Atlassian API tokens (from https://id.atlassian.com/manage-profile/security/api-tokens) authorize Jira + Confluence on a given Atlassian site. Bitbucket Cloud uses separate credentials — typically an app password, a Repository/Project/Workspace Access Token, or an Atlassian API token tied to a Bitbucket-enabled account. The two are usually scoped to different accounts and must be set separately.

   Ask per product. Skip a section if the user isn't configuring it this run.

   **For Jira + Confluence** (shared — same Atlassian site + same account + same token):
   - Atlassian site URL — e.g. `https://ventek.atlassian.net`. Confluence URL is typically `<base>/wiki`.
   - Atlassian account email on that site.
   - Atlassian API token for that account (https://id.atlassian.com/manage-profile/security/api-tokens — must be generated while logged in as that account).

   **For Bitbucket** (always separate):
   - Bitbucket workspace slug (visible in URLs as `bitbucket.org/<workspace>/...`).
   - Account email tied to Bitbucket (may differ from Jira/Confluence email).
   - Bitbucket credential — one of:
     - Atlassian API token from an account that has Bitbucket access (works for Basic Auth), OR
     - Bitbucket app password (legacy but still works), OR
     - Repository / Project / Workspace Access Token (recommended by Atlassian for programmatic access).

4. **Persist.** Call `mcp__acendas-atlassian__configure_credentials` with fields scoped to the product they belong to:

   For Jira + Confluence — use the shared `atlassian.*` fields (they fan out):
   - `atlassian_username` (the Atlassian-site email)
   - `atlassian_api_token` (the Atlassian API token)
   - `jira_url`, `confluence_url`

   For Bitbucket — use per-product `bitbucket.*` fields (so it doesn't accidentally get used for Jira/Confluence):
   - `bitbucket_workspace`
   - `bitbucket_username`
   - `bitbucket_api_token`

   Optionally: `jira_projects_filter`, `confluence_spaces_filter` to scope tools.

   **Do NOT put the Bitbucket token in `atlassian_api_token`** unless the user explicitly confirms that ONE token works for all three products (rare — typically only when one Atlassian account has access to Jira + Confluence + a Bitbucket-linked workspace).

   The tool merges into the existing config: values you don't pass are preserved. A backup of the prior file is kept at `~/.acendas-atlassian/config.json.bak`. The tool's response includes a `changes` block showing exactly which fields were `added`, `updated`, or `preserved` — read this back to the user as confirmation.

5. **Restart Claude Code.** The MCP server only reads credentials at startup. Tell the user to restart Claude Code (or just the MCP server) for new credentials to take effect.

6. **Verify.** After restart, call `mcp__acendas-atlassian__get_credentials_status` again to confirm everything resolves. Run a sanity probe per configured product:
   - Jira: `mcp__acendas-atlassian__jira_search` with JQL `assignee = currentUser()` (limit 1)
   - Confluence: `mcp__acendas-atlassian__getConfluenceSpaces` (limit 5)
   - Bitbucket: `mcp__acendas-atlassian__list_repositories` (pagelen 5) — or use `setup_bitbucket` for an explicit credential ping

   If any probe returns 401, walk through token rotation (back to step 4 with just `atlassian_api_token`).

## Resolution order (so the skill can explain to the user)

For every credential value:
1. Per-product env var (`JIRA_USERNAME`)
2. Shared env var (`ATLASSIAN_USERNAME`)
3. Per-product file entry (`jira.username` in config.json)
4. Shared file entry (`atlassian.username`)
5. Not configured → product disabled

## Notes

- **Bitbucket credentials are separate from Jira/Confluence.** Always set `bitbucket_username` + `bitbucket_api_token` explicitly. Don't rely on `atlassian.*` fallback for Bitbucket unless the user confirms one identity works for all three.
- Env vars are useful for CI / temporary overrides without touching the file.
- File path: `~/.acendas-atlassian/config.json`, mode 0600 (owner read/write only).
- Backup file: `~/.acendas-atlassian/config.json.bak` — refreshed on every `configure_credentials` call. Recover from a mistake with `mv config.json.bak config.json`.
- Backup tools (Time Machine, Dropbox, iCloud) may sync the file — warn the user if they use those.
- Per-project filters: store `jira_projects_filter` or `confluence_spaces_filter` in the file to scope all tools to specific projects/spaces.
- Read-only mode: set `READ_ONLY_MODE=true` env var to disable all write tools.
- `configure_credentials` NEVER clobbers existing values — empty/undefined inputs are ignored. Verify via the `changes.preserved` field in the response.
