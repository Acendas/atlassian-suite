---
name: Sprint Retrospective Brief
description: This skill should be used when the user asks for "sprint retro", "retrospective brief", "sprint review summary", "what went well/poorly this sprint", or runs `/atlassian-suite:sprint-retro`. Produces a retro-ready brief from completed/incomplete work, scope churn, cycle-time outliers, and recurring blockers in a closed sprint.
argument-hint: "[board-id-or-name] [sprint-id-or-name]"
allowed-tools: mcp__acendas-atlassian__jira_get_agile_boards, mcp__acendas-atlassian__jira_get_sprints_from_board, mcp__acendas-atlassian__jira_get_sprint_issues, mcp__acendas-atlassian__jira_search, mcp__acendas-atlassian__jira_batch_get_changelogs
---

# Sprint Retrospective Brief

Build a data-driven retro starter pack.

## Inputs

`$1` = Board, `$2` = Sprint (default: most recently closed sprint on the board).

## Steps

1. **Resolve board + sprint.** Same as sprint-status skill, but filter sprints by `state=closed` if `$2` is empty and pick the most recent one.

2. **Pull all sprint issues** via `mcp__acendas-atlassian__jira_get_sprint_issues`. Pull changelogs via `mcp__acendas-atlassian__jira_batch_get_changelogs` for cycle-time analysis.

3. **Compute the four sections:**

   **Completed.** Count + list issues where final status is in the `Done` category. Sum points if available. Highlight any issue whose summary contains a goal-marker (epic name, "spike", "demo").

   **Carryover.** Issues still in `In Progress` or `To Do` at sprint close. List with current status and assignee. These are the most important retro items.

   **Scope churn.** Compare `Sprint.startDate` to issue `created` dates. Count issues added mid-sprint and issues removed (look for `Sprint` field changes in changelogs). Report `+N added / -M removed`.

   **Cycle-time outliers.** From changelogs, compute time spent in `In Progress`. Flag issues that took >2x the sprint median. List the top 3.

4. **Recurring patterns.** Skim issue summaries + comments for repeated themes ("flaky test", "spec unclear", same component repeatedly mentioned). Report 1–3 candidate themes; do NOT speculate beyond what the data shows.

5. **Render the brief:**

   ```
   Retro Brief — {sprint_name}
   Closed: {endDate}  |  Duration: {n}d  |  Team: {assignee_count}

   ✅ Completed: {n} issues / {points} pts
   ↻ Carried over: {n} issues / {points} pts
   ± Scope churn: +{added} / -{removed}
   ⏱ Cycle-time outliers: top 3 listed below

   What went well (data-supported):
   - ...

   What to discuss:
   - Carryover: {ISSUE-KEY} — {summary} ({assignee})
   - Outlier: {ISSUE-KEY} — {summary} (took {n}d in In Progress)
   - Pattern: {theme} appeared in N issues
   ```

6. **Offer follow-ups.** Suggest creating retro action items via `/atlassian-suite:create-issue` if the user wants to track them.

## Notes

- Strictly read-only.
- Do not invent themes that aren't visible in titles/comments. Two mentions = candidate; one mention = ignore.
