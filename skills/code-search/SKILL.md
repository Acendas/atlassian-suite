---
name: Search Code Across Bitbucket
description: This skill should be used when the user asks to "search code", "find usages of X across repos", "where is function Y defined", "grep across bitbucket", or runs `/atlassian-suite:code-search`. Runs a Bitbucket workspace-wide code search with optional language/path/repo filters.
argument-hint: "<query> [repo-slug] [lang]"
allowed-tools: mcp__acendas-atlassian__search_code
---

# Search Code Across Bitbucket

## Inputs

`$1` = Search query.
`$2` = Optional repo slug to scope the search (`repo:`).
`$3` = Optional language filter (`lang:`).

## Steps

1. Compose the query. Bitbucket search supports filters:
   - `repo:my-repo` — scope to a single repo
   - `lang:python` — restrict by language
   - `path:src/` — restrict by path prefix
   - `ext:tsx` — restrict by extension

2. Add filters from `$2`/`$3` if provided.
3. Call `mcp__acendas-atlassian__search_code` with `pagelen=25`.
4. Render results with file path, repo, line range, and a short snippet.
5. Cap at 25; if more, show `... and N more` and offer narrowing tips.

## Notes

- Workspace-wide search requires the Bitbucket plan that includes code search.
- Skill is read-only.
