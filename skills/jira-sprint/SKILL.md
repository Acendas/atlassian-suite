---
name: Jira Sprint Operations
description: This skill should be used when the user asks to "manage sprint", "create a sprint", "add issues to sprint", "start/close sprint", "list sprints", or runs `/atlassian-suite:jira-sprint`. Handles sprint lifecycle on a Scrum board (list/create/start/close, add/remove issues).
argument-hint: "<board-id-or-name> <action: list|create|start|close|add|remove> [args...]"
allowed-tools: mcp__acendas-atlassian__jira_get_agile_boards, mcp__acendas-atlassian__jira_get_sprints_from_board, mcp__acendas-atlassian__jira_create_sprint, mcp__acendas-atlassian__jira_update_sprint, mcp__acendas-atlassian__jira_add_issues_to_sprint, mcp__acendas-atlassian__jira_get_sprint_issues
---

# Jira Sprint Operations

Run sprint lifecycle actions on a Scrum board.

## Inputs

`$1` = Board ID or name.
`$2` = Action (`list`, `create`, `start`, `close`, `add`, `remove`).
`$3+` = Action-specific args.

## Steps

1. **Resolve board** (numeric ID or fuzzy match via `mcp__acendas-atlassian__jira_get_agile_boards`).

2. **Branch on action:**

   - `list` → call `jira_get_sprints_from_board`. Render: `{id} {name} {state} {start→end}`.

   - `create` → ask for name, start date, end date, optional goal. Confirm, then `jira_create_sprint`.

   - `start` → require sprint id, start/end dates. `jira_update_sprint` with `state=active`.

   - `close` → require sprint id. `jira_update_sprint` with `state=closed`. Warn that incomplete issues will move to backlog.

   - `add` → require sprint id + issue keys (comma-separated). `jira_add_issues_to_sprint`.

   - `remove` → use `jira_add_issues_to_sprint` against the backlog sprint (sprint id 0 or the project's backlog), since Jira's API removes issues by re-assigning. If the API rejects this, explain the workaround (move via another sprint).

3. **Confirm before any write.** Sprint state changes are visible to the whole team — surface the impact before acting.
