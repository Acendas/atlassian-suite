---
name: List Pull Requests
description: This skill should be used when the user asks to "list PRs", "list pull requests", "show open PRs", "PRs needing my review", "my PRs", or runs `/atlassian-suite:pr-list`. Lists Bitbucket pull requests with smart filters (mine, needs-review, stale).
argument-hint: "[repo-slug] [filter: open|mine|review|stale|merged]"
allowed-tools: mcp__acendas-atlassian__list_pull_requests, mcp__acendas-atlassian__list_repositories, mcp__acendas-atlassian__get_pull_request
---

# List Pull Requests

Show Bitbucket PRs with smart filters.

## Inputs

`$1` = Optional repo slug. If empty, list across recent repos.
`$2` = Filter (default `open`):
- `open` — all OPEN PRs
- `mine` — OPEN PRs authored by the current user
- `review` — OPEN PRs where current user is in `reviewers` list and hasn't approved
- `stale` — OPEN PRs with no activity in 7+ days
- `merged` — recently merged (last 14 days)

## Steps

1. **Resolve scope.** If no repo, call `mcp__acendas-atlassian__list_repositories` and use the 5 most recently-updated repos.

2. **Fetch PRs** for each repo via `mcp__acendas-atlassian__list_pull_requests` with the appropriate state.

3. **Apply filter** client-side for `mine` / `review` / `stale`.

4. **Render** as a compact table:

   ```
   {repo}/{id}  {state}  {title} ({author})
                {reviewer-status}  updated {age}
   ```

5. **Cap output** at 30 rows. If more match, append `... and N more`.
