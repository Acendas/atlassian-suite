---
name: Daily Standup Notes
description: This skill should be used when the user asks for "standup notes", "what did I do yesterday", "daily standup", "yesterday/today/blockers", or runs `/atlassian-suite:standup-notes`. Generates a personalized daily standup brief from the user's Jira activity, in-flight Bitbucket PRs, and any blockers in the active sprint.
argument-hint: "[user-account-id-or-email]"
allowed-tools: mcp__acendas-atlassian__jira_get_user_profile, mcp__acendas-atlassian__jira_search, mcp__acendas-atlassian__list_pull_requests, mcp__acendas-atlassian__get_pull_request
---

# Daily Standup Notes

Generate a "yesterday / today / blockers" brief.

## Inputs

`$1` = Optional user identifier (email or accountId). Defaults to the authenticated user (`currentUser()`).

## Steps

1. **Resolve the user.** If `$1` is empty, use JQL `currentUser()`. Otherwise call `mcp__acendas-atlassian__jira_get_user_profile` to get the accountId.

2. **Fetch yesterday's activity in parallel:**
   - JQL: `assignee = {user} AND status changed during (-1d, now())` — issues moved by the user.
   - JQL: `assignee = {user} AND updated >= -1d` — any touched issues.
   - Bitbucket: `mcp__acendas-atlassian__list_pull_requests` filtered by author = the user, state = `MERGED`, updated within last 24h.
   - Bitbucket: `mcp__acendas-atlassian__list_pull_requests` filtered by author = the user, state = `OPEN`.

3. **Fetch today's plan:**
   - JQL: `assignee = {user} AND status = "In Progress"` — currently active work.
   - JQL: `assignee = {user} AND sprint in openSprints() AND status = "To Do"` — next-up.

4. **Fetch blockers:**
   - JQL: `assignee = {user} AND (flagged is not empty OR status = Blocked)` — explicit blockers.
   - Open PRs by the user that have `CHANGES_REQUESTED` from a reviewer — implicit blockers.

5. **Render the notes** in this shape:

   ```
   *Yesterday*
   - {ISSUE-KEY}: {summary} — moved {fromStatus} → {toStatus}
   - PR #{id}: {title} — merged
   ...

   *Today*
   - {ISSUE-KEY}: {summary} ({status})
   - PR #{id}: {title} — open, awaiting review

   *Blockers*
   - {ISSUE-KEY}: {summary} — {flag-reason or "blocked"}
   - PR #{id}: {title} — changes requested by {reviewer}

   (none) if a section is empty.
   ```

6. **Offer to copy.** Format also as a Slack-friendly version (replace `*bold*` with `*bold*`, drop blank lines if requested).

## Notes

- Read-only.
- Cap each section at 8 items; if more, append `... and N more` and offer to expand.
- Time window default is 24h; for a Monday standup, ask whether to expand to "since Friday".
