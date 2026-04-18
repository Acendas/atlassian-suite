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

3. **Collect what's needed.** Ask the user for:
   - Atlassian site URL — base for both Jira and Confluence (e.g. `https://acme.atlassian.net`). Confluence URL is typically `<base>/wiki`.
   - Bitbucket workspace slug (visible in Bitbucket URLs as `bitbucket.org/<workspace>/...`)
   - Atlassian account email
   - Atlassian API token — direct them to https://id.atlassian.com/manage-profile/security/api-tokens

   For most users the same email + token works for all three products. Only ask for per-product overrides (`jira_username`, `bitbucket_username`, etc.) if the user explicitly says they use different identities per product.

4. **Persist.** Call `mcp__acendas-atlassian__configure_credentials` with only the fields you collected:
   - `atlassian_username` (the shared email)
   - `atlassian_api_token` (the shared token)
   - `jira_url`, `confluence_url`, `bitbucket_workspace`
   - Optionally: `jira_projects_filter`, `confluence_spaces_filter` to scope tools
   - Optionally: per-product overrides if needed

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

- Env vars are useful for CI / temporary overrides without touching the file.
- File path: `~/.acendas-atlassian/config.json`, mode 0600 (owner read/write only).
- Backup file: `~/.acendas-atlassian/config.json.bak` — refreshed on every `configure_credentials` call. Recover from a mistake with `mv config.json.bak config.json`.
- Backup tools (Time Machine, Dropbox, iCloud) may sync the file — warn the user if they use those.
- Per-project filters: store `jira_projects_filter` or `confluence_spaces_filter` in the file to scope all tools to specific projects/spaces.
- Read-only mode: set `READ_ONLY_MODE=true` env var to disable all write tools.
- `configure_credentials` NEVER clobbers existing values — empty/undefined inputs are ignored. Verify via the `changes.preserved` field in the response.
