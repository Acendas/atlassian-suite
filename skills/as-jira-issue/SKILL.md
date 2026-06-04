---
name: as-jira-issue
description: View or act on a Jira issue.
argument-hint: "<issue-key> [action: show|comment|transition|worklog]"
allowed-tools: mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_get_transitions, mcp__acendas-atlassian__jira_transition_issue, mcp__acendas-atlassian__jira_add_comment, mcp__acendas-atlassian__jira_add_worklog, mcp__acendas-atlassian__jira_get_issue_property_keys, mcp__acendas-atlassian__jira_get_issue_property, mcp__acendas-atlassian__qmetry_search_test_cycles, mcp__acendas-atlassian__get_credentials_status
---

# View / Work on a Jira Issue

Pull a Jira issue and offer common follow-ups. Always includes QMetry test coverage if QMetry is configured.

## Inputs

`$1` = Issue key.
`$2` = Action (default `show`).

## Steps

### 1. Load the issue and check QMetry in parallel

Call `jira_get_issue(issue_key: $1, expand: ["renderedFields", "transitions"])`.

At the same time, call `get_credentials_status` — you need `effective.qmetry.configured` for step 3.

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

### 3. Append QMetry test coverage (if QMetry is configured)

If `effective.qmetry.configured` is `true`:

a. Call `jira_get_issue_property_keys(issue_key: $1)`. Look for a key whose name contains `testcycle-execution-panel`.

b. If found, call `jira_get_issue_property` with that full key. The value is an array — note its length as the linked cycle count.

c. Call `qmetry_search_test_cycles(project_id: <fields.project.id>)`. Note: **Jira project ID = QMetry project ID** — pass `fields.project.id` from the issue directly; no lookup needed.

d. Append to the summary:

```
QMetry Test Coverage
  Linked cycles: {count from step b, or "unknown"}
  Key           Status    Summary
  PROJ-TR-n     Active    {cycle name}
```

If the property key is absent or the array is empty, append: `QMetry Test Coverage — no test cycles linked to this issue.`

If `effective.qmetry.configured` is `false`, skip QMetry entirely (no note, no error).

### 4. Branch on action

- `show` → done.
- `comment` → ask for body, post via `jira_add_comment`.
- `transition` → list available transitions (`jira_get_transitions`), let user pick, call `jira_transition_issue`.
- `worklog` → ask for time spent (`30m`, `2h`) and optional comment, call `jira_add_worklog`.

Confirm before any write.
