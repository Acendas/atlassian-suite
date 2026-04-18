---
name: Sprint Status Report
description: This skill should be used when the user asks for "sprint status", "current sprint progress", "where are we in the sprint", "sprint health check", or runs `/atlassian-suite:sprint-status`. Produces a concise sprint progress report with completed/in-progress/blocked breakdown, scope changes, and burndown signal.
argument-hint: "[board-id-or-name] [sprint-id-or-name]"
allowed-tools: mcp__acendas-atlassian__jira_get_agile_boards, mcp__acendas-atlassian__jira_get_sprints_from_board, mcp__acendas-atlassian__jira_get_sprint_issues, mcp__acendas-atlassian__jira_search
---

# Sprint Status Report

Produce a one-screen sprint health report.

## Inputs

`$1` = Board ID, board name, or empty (interactive). `$2` = Sprint ID/name, or empty (defaults to active sprint).

## Steps

1. **Resolve the board.**
   - If `$1` is numeric → use as board ID.
   - If `$1` is a string → call `mcp__acendas-atlassian__jira_get_agile_boards` and fuzzy-match.
   - If empty → list available boards and ask the user to pick.

2. **Resolve the sprint.** Call `mcp__acendas-atlassian__jira_get_sprints_from_board` filtered by `state=active` (or by name match if `$2` is provided). If multiple active sprints exist, ask the user.

3. **Pull sprint issues.** Call `mcp__acendas-atlassian__jira_get_sprint_issues` for the sprint. Group by status category: `Done`, `In Progress`, `To Do`, plus a separate `Blocked` group if any issue has the `flagged` field set.

4. **Compute deltas.** Compare current scope vs initial commitment (look for issues added after sprint start using `created > sprintStartDate` heuristic via `mcp__acendas-atlassian__jira_search`). Count story points if the field is populated.

5. **Render the report** in this exact shape:

   ```
   Sprint: {name}  ({startDate} → {endDate}, {days_remaining}d left)
   Board:  {board_name}

   Done         {n} issues | {points} pts
   In Progress  {n} issues | {points} pts ({assignees_summary})
   To Do        {n} issues | {points} pts
   Blocked      {n} issues | {points} pts ⚠ if > 0

   Scope changes: +{added} / -{removed} since sprint start
   Velocity signal: {percent_done}% complete with {percent_time_elapsed}% of time elapsed
   ```

6. **Highlight risks.** Append a `Risks` section listing any blocked issues by key + summary, plus issues with no assignee or no recent activity (>3 days).

## Notes

- Read-only skill. Never transition or update issues.
- If a project filter is configured (`JIRA_PROJECTS_FILTER`), the active sprint may not be visible — fall back to asking the user for the sprint name.
- Limit to 50 issues per query; warn the user if the sprint has more.
