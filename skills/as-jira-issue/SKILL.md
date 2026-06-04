---
name: as-jira-issue
description: View or act on a Jira issue.
argument-hint: "<issue-key> [action: show|comment|transition|worklog]"
allowed-tools: mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_get_transitions, mcp__acendas-atlassian__jira_transition_issue, mcp__acendas-atlassian__jira_add_comment, mcp__acendas-atlassian__jira_add_worklog
---

# View / Work on a Jira Issue

Pull a Jira issue and offer common follow-ups. QMetry test cycle data is included automatically in the response when QMetry is configured — no extra tool calls needed.

## Inputs

`$1` = Issue key.
`$2` = Action (default `show`).

## Steps

### 1. Load the issue

Call `jira_get_issue(issue_key: $1, expand: ["renderedFields", "transitions"])`.

The response includes a `qmetry` field when QMetry is configured:
- `qmetry.test_cycles` — list of test cycles in this project
- `qmetry.linked_cycle_count` — number of cycles directly linked to this issue
- `qmetry: null` — QMetry not configured (skip the section silently)

### 2. Render the Jira summary

```
{KEY}  {type}  {status}  {priority}
{summary}
Assignee: {assignee}  Reporter: {reporter}
Sprint: {sprint}  Epic: {epic-link}

Description: {first 5 lines, …}

Linked issues: {key — summary — status, one per line}

Recent activity: {latest 3 comments/transitions, one line each}
```

### 3. Render QMetry test coverage (if present)

If `qmetry` is non-null:

```
QMetry Test Coverage  ({linked_cycle_count} cycle(s) directly linked)
  Key           Status    Summary
  PROJ-TR-n     Active    {cycle name}
```

If `qmetry` is null, omit the section entirely.

### 4. Branch on action

- `show` → done.
- `comment` → ask for body, post via `jira_add_comment`.
- `transition` → list available transitions (`jira_get_transitions`), let user pick, call `jira_transition_issue`.
- `worklog` → ask for time spent (`30m`, `2h`) and optional comment, call `jira_add_worklog`.

Confirm before any write.
