---
name: Link PR to Jira Issue
description: This skill should be used when the user asks to "link this PR to a jira issue", "link pr to jira", "associate PR with ticket", "add Jira link to PR", or runs `/atlassian-suite:link-pr-to-issue`. Establishes a bidirectional link between a Bitbucket pull request and a Jira issue (issue gets a remote link to the PR; PR description and branch reference the issue key).
argument-hint: "<pr-url-or-id> [issue-key]"
allowed-tools: mcp__acendas-atlassian__get_pull_request, mcp__acendas-atlassian__update_pull_request, mcp__acendas-atlassian__add_pull_request_comment, mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_create_remote_issue_link, mcp__acendas-atlassian__jira_add_comment
---

# Link a Bitbucket PR to a Jira Issue

Create a bidirectional link between a pull request and a Jira issue.

## Inputs

`$1` = PR identifier (full URL like `https://bitbucket.org/<ws>/<repo>/pull-requests/123`, or `<repo>/123`).
`$2` = Optional Jira issue key (e.g. `PROJ-456`). If omitted, infer from the PR branch name or title.

## Steps

1. **Resolve the PR.** Parse `$1` into `(workspace, repo_slug, pr_id)`. Call `mcp__acendas-atlassian__get_pull_request` to fetch title, source branch, description, author, and current state.

2. **Resolve the Jira issue.**
   - If `$2` is provided, call `mcp__acendas-atlassian__jira_get_issue` to validate.
   - Otherwise, parse the PR source branch name (e.g. `feature/PROJ-456-something`) and PR title for an issue key matching `[A-Z][A-Z0-9]+-\d+`.
   - If multiple candidates appear, ask the user which one is correct.
   - If none are found, ask the user for the issue key.

3. **Update the Jira side.** Add a remote link via `mcp__acendas-atlassian__jira_create_remote_issue_link` with:
   - `url` = PR HTML URL
   - `title` = `[<repo>] PR #<id>: <PR title>`
   - `icon_url` = Bitbucket favicon (or omit)
   - `relationship` = `"implements"` or `"fixes"` based on user intent (default: `implements`).

   Optionally add a comment via `mcp__acendas-atlassian__jira_add_comment` summarizing the PR (1 line: title + author + source→destination branches).

4. **Update the PR side.** If the PR description does not already contain the issue key, call `mcp__acendas-atlassian__update_pull_request` to prepend `Jira: <ISSUE-KEY>` to the description. If the PR is read-only or update fails, fall back to posting a comment via `mcp__acendas-atlassian__add_pull_request_comment` containing the issue link.

5. **Report.** Summarize what changed in 2 short lines: which Jira link was created, which PR field was updated.

## Notes

- Never overwrite existing PR descriptions. Prepend, don't replace.
- For multi-issue PRs, repeat steps 3–4 per issue key.
- If the user has read-only mode enabled (`READ_ONLY_MODE=true`), skip writes and report what would have changed.
