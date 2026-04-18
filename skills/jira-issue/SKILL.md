---
name: View / Work on a Jira Issue
description: This skill should be used when the user asks to "show jira issue X", "open PROJ-123", "what's the status of {issue}", "transition this issue", "comment on issue", or runs `/atlassian-suite:jira-issue`. Loads a Jira issue, displays a compact summary, and offers next actions (comment, transition, log work).
argument-hint: "<issue-key> [action: show|comment|transition|worklog]"
allowed-tools: mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_get_transitions, mcp__acendas-atlassian__jira_transition_issue, mcp__acendas-atlassian__jira_add_comment, mcp__acendas-atlassian__jira_add_worklog
---

# View / Work on a Jira Issue

Pull a Jira issue and offer common follow-ups.

## Inputs

`$1` = Issue key.
`$2` = Action (default `show`).

## Steps

1. **Load** via `mcp__acendas-atlassian__jira_get_issue` with `expand=renderedFields,transitions`.

2. **Render the summary:**
   ```
   {KEY}  {type}  {status}  {priority}
   {summary}
   Assignee: {assignee}  Reporter: {reporter}
   Sprint: {sprint}  Epic: {epic-link}

   Description: {first 5 lines, ...}

   Recent activity: {latest 3 comments/transitions, one line each}
   ```

3. **Branch on action:**
   - `show` → done.
   - `comment` → ask for body, post via `jira_add_comment`.
   - `transition` → list available transitions (`jira_get_transitions`), let user pick, call `jira_transition_issue`.
   - `worklog` → ask for time spent (`30m`, `2h`) and optional comment, call `jira_add_worklog`.

4. **Confirm before any write.** Read-only by default unless action is explicitly `comment`/`transition`/`worklog`.
