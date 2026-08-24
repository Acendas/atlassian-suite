---
name: as-jira-issue
description: View or act on a Jira issue.
argument-hint: "<issue-key> [action: show|comment|transition|worklog]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_issue, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_transitions, mcp__plugin_atlassian-suite_acendas-atlassian__jira_transition_issue, mcp__plugin_atlassian-suite_acendas-atlassian__jira_add_comment, mcp__plugin_atlassian-suite_acendas-atlassian__jira_add_worklog
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

## Mentioning someone in a comment

Writing `@Name` in a comment body produces plain text and notifies nobody. To
actually tag someone:

1. Resolve their account id — `jira_get_user_profile` with `query: "Eldon Wong"`
   (a display name or email) returns `accountId`.
2. Put `[~accountid:<accountId>]` in the Markdown `body`. Add a fallback name
   with `[~accountid:<accountId>|Eldon Wong]` if you want one.

```
[~accountid:557058:f58131cb-b67d-43c7-b30d-6b58d40bd077] this needs a decision
```

The server converts that to a real ADF mention node, which is what sends the
"you were mentioned" notification. Adding a watcher (`jira_add_watcher`) is a
different thing — it subscribes them to the issue but sends no mention ping.

If you also need panels, charts, or media, pass a full ADF document via
`body_adf` instead; a `mention` node there works the same way.
