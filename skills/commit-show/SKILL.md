---
name: Show Bitbucket Commit
description: This skill should be used when the user asks to "show commit", "what changed in commit X", "commit details", "show me commit Y", or runs `/atlassian-suite:commit-show`. Pulls a commit's metadata, diff, diffstat, and CI/build statuses.
argument-hint: "<repo-slug> <commit-sha>"
allowed-tools: mcp__acendas-atlassian__get_commit, mcp__acendas-atlassian__get_commit_diffstat, mcp__acendas-atlassian__get_commit_diff, mcp__acendas-atlassian__list_commit_statuses, mcp__acendas-atlassian__list_commit_comments
---

# Show a Bitbucket Commit

## Inputs

`$1` = Repo slug.
`$2` = Commit SHA (full or short).

## Steps

1. Fetch in parallel:
   - `get_commit` — author, date, message, parents
   - `get_commit_diffstat` — files changed + line counts
   - `list_commit_statuses` — CI build statuses
   - `list_commit_comments` — discussion (limit 10)

2. Render:
   ```
   commit {sha}
   {author} <{email}>  {date}

       {message}

   Files: {n} (+{added}/-{deleted})
   {file1}: +{a}/-{d}
   ...

   Build statuses:
   {state}  {key}  {name}  {url}
   ...
   ```

3. If user wants the full diff, call `get_commit_diff` — warn if large (>1000 lines) before printing.

## Notes

- Short SHAs work; the API resolves them.
- Skill is read-only.
