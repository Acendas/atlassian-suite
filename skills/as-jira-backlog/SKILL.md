---
name: as-jira-backlog
description: View and reorder a Jira board's backlog.
argument-hint: "<board-id-or-name> [action: show|move|top|bottom|to-backlog] [args...]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_agile_boards, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_backlog_issues, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_board_configuration, mcp__plugin_atlassian-suite_acendas-atlassian__jira_rank_issues, mcp__plugin_atlassian-suite_acendas-atlassian__jira_move_issues_to_backlog
---

# Jira Backlog Ordering

Show a board's backlog in the order the PO set, and change that order. In Jira the order lives in the hidden **Rank** field. Rank can only be changed through `jira_rank_issues`; `jira_update_issue` and the Priority field do not move anything.

## Inputs

`$1` = Board ID or name.
`$2` = Action (default `show`):
- `show` — the backlog, top first.
- `move <KEYS> before|after <ANCHOR>` — e.g. `move ABC-12,ABC-13 before ABC-7`.
- `top <KEYS>` / `bottom <KEYS>` — to the top or bottom of the backlog.
- `to-backlog <KEYS>` — take issues out of their sprint and back to the backlog.

## Steps

1. **Resolve board** (numeric ID, or fuzzy match via `jira_get_agile_boards`; ask if several match).

2. **Read the backlog** with `jira_get_backlog_issues`. It returns issues in rank order and adds the board's story-points field (reported as `estimation_field`). Page with `start_at` while `startAt + maxResults < total`, so the list you show or anchor against is complete.

3. **Branch on action:**

   - `show` → render one row per issue: `{#} {key} {type} {points} {status} {fixVersions} {summary}`. Use the `estimation_field` value for points; show `–` when it is empty. Always show the total count, and say so clearly if you stopped paging early.

   - `move` → `jira_rank_issues(issue_keys, rank_before_issue | rank_after_issue)`. The keys keep the order you list them in.

   - `top` → anchor `rank_before_issue` on the current first backlog issue that is not in the list. `bottom` → `rank_after_issue` on the current last one.

   - `to-backlog` → `jira_move_issues_to_backlog(issue_keys)`.

4. **Batch at 50.** Jira ranks at most 50 issues per call. For more, rank the first 50 against the anchor, then rank each next batch `rank_after_issue` = the last key of the previous batch.

5. **Confirm before any write.** Show a before/after of the affected rows. The backlog order is shared by the whole team.

6. **Check the result.** `jira_rank_issues` returns `ranked` and `failed`. Report every `failed` entry with its error; never say an issue moved unless it is in `ranked`. Re-read the backlog and show the new positions.

## Notes

- Priority is not order. If the user asks to "prioritize", reorder by rank. Only change the Priority field if they ask for it by name.
- The anchor issue must be on the same board and cannot be one of the issues being moved.
