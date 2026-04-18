# Acendas Atlassian Suite

Comprehensive Claude Code plugin for **Jira Cloud + Confluence Cloud + Bitbucket Cloud**, built on a single Node MCP server (`@acendas/atlassian-mcp`) with 29 workflow skills and an orchestrator agent.

## What's in the box

| Component | Count |
|-----------|-------|
| MCP server (Node, FastMCP) | 1 |
| MCP tools | **179** |
| Skills | **29** |
| Agents | **7** (1 router + 6 specialists) |

### MCP tool coverage

| Product | Tools | Coverage |
|---------|-------|----------|
| Bitbucket Cloud | **122** | PRs, branches, branch restrictions, repos, file contents, forks, commits, comments, tags, pipelines, schedules, pipeline variables (repo/workspace/project), deployments, environments, env variables, code insights (reports + annotations + build statuses), native issues, snippets, webhooks, projects, code search, deploy keys, SSH keys, users, workspace metadata + members + permissions |
| Jira Cloud | **38** | Issues (CRUD + batch), transitions, comments, worklogs, watchers, links, remote links, changelogs, fields, custom fields, projects, components, versions, users, agile boards, sprints, JQL search |
| Confluence Cloud | **19** | Pages (CRUD), search (CQL), space tree, version history, version diff, comments + replies, labels, attachments, spaces, user search |

### Skills (29)

**Cross-product (11):** `init`, `link-pr-to-issue`, `pr-summary-to-jira`, `sprint-status`, `standup-notes`, `sprint-retro`, `release-notes`, `publish-release-notes`, `review-pr`, `create-issue`, `triage-issue`

**Bitbucket (8):** `pr-list`, `pr-create`, `pipeline-status`, `pipeline-trigger`, `deployments`, `code-search`, `commit-show`, `branch-protection`

**Jira (5):** `jql-search`, `jira-issue`, `jira-sprint`, `jira-link`, `jira-worklog`

**Confluence (6):** `confluence-search`, `confluence-page`, `confluence-edit`, `confluence-tree`, `confluence-comment`, `confluence-attachment`

All user-invokable as `/atlassian-suite:<skill-name>`.

### Agents (7)

Each agent has a focused tool surface + specialized system prompt for autonomous, multi-step work.

| Agent | Owns | Color |
|---|---|---|
| `atlassian-orchestrator` | Router — dispatches to specialists or coordinates multi-specialist flows | blue |
| `code-review-orchestrator` | Bitbucket PRs — review, comments, approve/decline, reviewers, with Jira context | cyan |
| `sprint-orchestrator` | Jira Agile — boards, sprints, planning, retros, standup, active-sprint health | green |
| `release-orchestrator` | Bitbucket merged PRs + Jira fixVersion + tags + Confluence publish | orange |
| `devops-orchestrator` | Pipelines, deployments, environments, branch protection, code insights, schedules, variables | red |
| `triage-orchestrator` | Jira issue lifecycle — bulk triage, create, link, watchers, batch transitions | yellow |
| `knowledge-orchestrator` | Confluence read/write/edit — pages, spaces, comments, attachments, version diff | purple |

For most tasks, dispatch the specialist directly. Use `atlassian-orchestrator` only when intent is unclear or the work spans 3+ specialists end-to-end.

### PR review pipeline (8 agents)

`code-review-orchestrator` runs a multi-scanner pipeline modeled on Shipyard's pattern. All scanners write strict YAML output with confidence ≥ 80 and a `TRUNCATED` protocol for large diffs.

```
Wave 1 — 6 parallel scanners (sonnet, ≤8 files per round, single-responsibility):
  • pr-review-bugs            — logic errors, null handling, races, leaks
  • pr-review-security        — injection, auth bypass, secrets, crypto
  • pr-review-silent-failures — empty catches, swallowed errors, masked failures
  • pr-review-patterns        — project rules, naming, anti-patterns, duplication
  • pr-review-tests           — coverage, weak assertions, missing edge cases
  • pr-review-spec            — Jira AC compliance, under/over-building
       ↓
Wave 2 — pr-investigator (opus): deep-dives on borderline findings (conf 80–89, must-fix on auth/payments)
       ↓
Wave 3 — pr-critic (opus, high-stakes only): anti-sycophancy adversarial pass with assumptions + pre-mortem + structured criteria
       ↓
Consolidated verdict + optional inline-comment posting
```

Use via `/atlassian-suite:review-pr <pr-id> [--high] [--quick]` or by dispatching `code-review-orchestrator` directly for batch reviews.

## Prerequisites

- **Node 20+** (`node --version`)
- **pnpm** (`npm install -g pnpm`)
- Atlassian Cloud account with API access
- Bitbucket Cloud workspace

## Installation

1. Clone or copy this repo into your Claude Code plugins directory.
2. Build the MCP server:

   ```bash
   cd server
   pnpm install
   pnpm build
   ```

3. Configure credentials. **Two options** — pick one:

   **Option A — File (recommended).** Run `/atlassian-suite:init` after first launch. The skill walks you through it and persists to `~/.acendas-atlassian/config.json` (mode 0600, owner-only, atomic write with rolling backup). One source of truth, easy rotation, no shell-profile clutter.

   **Option B — Env vars.** Set in `~/.zshrc` / `~/.bashrc` / project `.env`:

   ```bash
   export JIRA_URL="https://acme.atlassian.net"
   export CONFLUENCE_URL="https://acme.atlassian.net/wiki"
   export BITBUCKET_WORKSPACE="acme"
   export ATLASSIAN_USERNAME="you@example.com"
   export ATLASSIAN_API_TOKEN="ATATT3xFfGF0..."
   ```

   Env vars take precedence over the file when set. Use them for CI or per-session overrides.

4. Restart Claude Code. The MCP server starts automatically on first use and reads credentials at startup.

## Credential resolution order

For every value (URL, username, token, filter):

1. Per-product env var (`JIRA_USERNAME`)
2. Shared env var (`ATLASSIAN_USERNAME`)
3. Per-product file entry (`jira.username` in `config.json`)
4. Shared file entry (`atlassian.username`)
5. Not configured → product disabled

Three credential management tools are always available:
- `configure_credentials` — write/update the file (token values not echoed in plaintext)
- `get_credentials_status` — inspect current state, with resolution source per value
- `clear_credentials` — delete the file (env vars unaffected)

## Stack

- **Server framework:** [`fastmcp`](https://github.com/punkpeye/fastmcp) (Node TypeScript port)
- **Jira client:** [`jira.js`](https://github.com/MrRefactoring/jira.js) — typed Cloud REST + Agile
- **Confluence client:** [`confluence.js`](https://github.com/MrRefactoring/confluence.js) — typed Cloud REST v1+v2
- **Markdown → ADF:** `@atlaskit/editor-json-transformer` + `@atlaskit/editor-markdown-transformer` (heavy/accurate)
- **ADF → Markdown:** `adf-to-md` (mature standalone)
- **Bitbucket:** raw `fetch` against the v2 REST API (no mature typed client; not needed)

All API calls verified against the published .d.ts files of jira.js / confluence.js and Atlassian's official Bitbucket Cloud REST API docs.

## Auth

- **Cloud only.** API Token + Basic Auth across all three products.
- **Read-only mode:** `READ_ONLY_MODE=true` blocks writes.
- **Filters:** `JIRA_PROJECTS_FILTER`, `CONFLUENCE_SPACES_FILTER` (comma-separated keys).

## Development

```bash
cd server
pnpm install
pnpm dev          # tsx — runs server.ts directly
pnpm typecheck    # type-check without emitting
pnpm build        # produce dist/ for production use
pnpm clean        # remove dist/
```

## Plugin layout

```
atlassian-plugin/
├── .claude-plugin/plugin.json
├── .mcp.json                  # node ${CLAUDE_PLUGIN_ROOT}/server/dist/server.js
├── agents/atlassian-orchestrator.md
├── skills/                    # 29 user-invoked workflows
└── server/                    # Node MCP server
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── server.ts          # FastMCP entrypoint
        ├── common/            # config, http, ADF, jira/confluence clients
        ├── jira/              # 38 tools across search/issues/projects/agile
        ├── confluence/        # 19 tools across pages/comments/spaces/labels/diff
        └── bitbucket/         # 122 tools across 21 modules
```
