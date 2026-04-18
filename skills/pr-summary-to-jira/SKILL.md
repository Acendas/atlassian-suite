---
name: Post PR Summary to Jira
description: This skill should be used when the user asks to "post pr summary to jira", "summarize this pr in jira", "comment pr status on jira issue", or runs `/atlassian-suite:pr-summary-to-jira`. Generates a concise PR status summary and posts it as a Jira comment on the linked issue, keeping non-technical stakeholders updated without leaving Jira.
argument-hint: "<pr-url-or-id> [issue-key]"
allowed-tools: mcp__acendas-atlassian__get_pull_request, mcp__acendas-atlassian__get_pull_request_diffstat, mcp__acendas-atlassian__get_pull_request_activity, mcp__acendas-atlassian__jira_add_comment, mcp__acendas-atlassian__jira_get_issue
---

# Summarize a PR in a Jira Comment

Generate a stakeholder-friendly PR status summary and post it as a Jira comment.

## Inputs

`$1` = PR identifier. `$2` = Optional Jira issue key (auto-detected from branch/title if omitted; see link-pr-to-issue skill for resolution rules).

## Steps

1. **Fetch PR data in parallel:**
   - `mcp__acendas-atlassian__get_pull_request` — title, state, author, reviewers, branches, merge status
   - `mcp__acendas-atlassian__get_pull_request_diffstat` — files changed + line counts
   - `mcp__acendas-atlassian__get_pull_request_activity` — approvals, change requests, comment count

2. **Compose the summary.** Use Atlassian wiki markup for Jira:

   ```
   *PR #{id}: {title}*
   Author: {author} | Reviewers: {reviewer-count} ({approved}/{requested-changes}/{pending})
   Branches: {source} → {destination}
   Diff: {files-changed} files (+{added} / -{deleted})
   Status: {state} {merge-status-suffix}
   {pr-url}
   ```

   - State examples: `OPEN — ready for review`, `OPEN — 2 changes requested`, `MERGED on YYYY-MM-DD`, `DECLINED`.
   - Keep total comment under 8 lines. No code blocks, no diffs inline.

3. **Post the comment.** Call `mcp__acendas-atlassian__jira_add_comment` against the resolved issue key.

4. **Report.** Print one line: `Posted PR summary to <ISSUE-KEY>: <jira-comment-url>`.

## Notes

- Avoid duplicate summaries. Before posting, fetch the issue with comments expanded (`jira_get_issue` returns recent comments) and check for an existing comment starting with `*PR #{id}:`. If found, ask the user whether to skip or post a fresh summary.
- If the PR is in `MERGED` state, also suggest a transition (e.g. "Mark issue as Done?") but do not transition without explicit user approval.
