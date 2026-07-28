---
name: as-pr-create
description: Create a Bitbucket pull request.
argument-hint: "<repo-slug> <source-branch> [destination-branch] [title]"
allowed-tools: Bash, mcp__plugin_atlassian-suite_acendas-atlassian__create_pull_request, mcp__plugin_atlassian-suite_acendas-atlassian__get_default_reviewers, mcp__plugin_atlassian-suite_acendas-atlassian__list_branches, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_issue
---

# Create a Pull Request

Open a Bitbucket PR with sensible defaults.

## Inputs

`$1` = Repo slug.
`$2` = Source branch.
`$3` = Optional destination (default `main`).
`$4` = Optional title (else derive from branch / latest commit).

## Steps

1. **Validate branches** via `mcp__plugin_atlassian-suite_acendas-atlassian__list_branches`. If source is missing, report and stop.

2. **Derive title** if not provided:
   - If branch contains a Jira key (e.g. `feature/PROJ-123-foo-bar`), pull the issue summary via `mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_issue` and use `[PROJ-123] {summary}`.
   - Else use the latest commit subject via `git log -1 --pretty=%s` (Bash).

3. **Compose description.**
   - If a Jira key is present, prepend `Jira: {KEY}` and a one-line summary.
   - Add a `## Changes` section with bullet points from `git log {dest}..{source} --pretty="- %s"` (Bash, capped at 20 lines).
   - Add a `## Test plan` placeholder for the user to fill in.

4. **Confirm the payload** with the user before creating (title, description preview, dest branch).

5. **Create** via `mcp__plugin_atlassian-suite_acendas-atlassian__create_pull_request` with `use_default_reviewers=true`. Report the new PR URL.

## Notes

- Never push branches — assume the source branch is already pushed. If the PR creation fails because the branch isn't on origin, tell the user to `git push -u origin {branch}`.
- For draft PRs, append `[DRAFT]` to the title (Bitbucket Cloud doesn't have a native draft state).
