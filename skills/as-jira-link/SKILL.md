---
name: as-jira-link
description: Create or remove typed Jira issue links.
argument-hint: "<inward-key> <link-type> <outward-key>"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__jira_create_issue_link, mcp__plugin_atlassian-suite_acendas-atlassian__jira_remove_issue_link, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_link_types, mcp__plugin_atlassian-suite_acendas-atlassian__jira_link_to_epic
---

# Link Jira Issues

## Inputs

`$1` = Inward issue key (the issue with the relationship — e.g. the blocker).
`$2` = Link type name. Common: `Blocks`, `Relates`, `Duplicates`, `Causes`. If unknown, list with `jira_get_link_types`.
`$3` = Outward issue key.

## Steps

1. Validate `$2` — if not in the canonical list, call `jira_get_link_types` and ask the user to pick.
2. For epic links specifically, prefer `jira_link_to_epic` (sets `parent`).
3. Confirm direction with the user (Jira link types are directional — "blocks" vs "is blocked by" matters).
4. Call `jira_create_issue_link` with `{inwardIssue: $1, outwardIssue: $3, type.name: $2}`.
5. Print the new link id (if returned) and confirm both sides.

## Notes

- To remove a link, ask for the link id (visible on the issue's links panel).
- Skill writes — always confirm direction + type before creating.
