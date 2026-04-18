---
name: Jira Worklog
description: This skill should be used when the user asks to "log work on issue", "add worklog", "track time", "I spent 2h on PROJ-123", or runs `/atlassian-suite:jira-worklog`. Adds time entries to Jira issues and shows existing worklogs.
argument-hint: "<issue-key> [time-spent] [comment]"
allowed-tools: mcp__acendas-atlassian__jira_add_worklog, mcp__acendas-atlassian__jira_get_worklog
---

# Jira Worklog

## Inputs

`$1` = Issue key.
`$2` = Time spent — Jira format: `30m`, `2h`, `1d 4h`. If omitted, list existing worklogs.
`$3` = Optional comment (Markdown — converted to ADF).

## Steps

1. If only `$1` provided → `jira_get_worklog`. Render compact table: `{author} {timeSpent} {started} {comment}`.
2. If `$2` provided → confirm with the user (worklogs aren't trivially deletable), then `jira_add_worklog`.
3. Print the new worklog id and remaining estimate (if returned).

## Notes

- `started` defaults to now. Pass an ISO 8601 timestamp to backdate.
- Skill writes — always confirm.
