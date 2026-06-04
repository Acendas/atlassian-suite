---
name: as-qmetry-search
description: Search QMetry test cases in a project.
argument-hint: "<project-id|jira-key> [search text]"
allowed-tools: mcp__acendas-atlassian__get_credentials_status, mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__qmetry_list_projects, mcp__acendas-atlassian__qmetry_search_test_cases
---

# Search QMetry Test Cases

## Preflight

Call `get_credentials_status`. If `effective.qmetry.configured` is `false`, stop and output:

> QMetry is not configured. Run `/atlassian-suite:init`, select the **QMetry** section, and paste your API key (Jira → QMetry → Configuration → Open API → Generate). Then retry.

## Key architectural fact

**Jira project ID = QMetry project ID.** They share the same numeric IDs — pass `fields.project.id` from any Jira issue directly to QMetry tools as `project_id`. No extra lookup needed.

## Inputs

`$1` = One of:
- A numeric project ID (e.g. `10001`) — use directly
- A Jira/QMetry project key (e.g. `PROJ`) → call `qmetry_list_projects`, find entry where `key == "PROJ"`, use its `id`
- A Jira issue key (e.g. `PROJ-123`) → call `jira_get_issue(fields: ["project"])`, use `fields.project.id`
- Omitted → call `qmetry_list_projects`, show the list, ask the user to pick

`$2` = Search text or exact test case key (optional).

## Steps

1. **Resolve project_id** from `$1` using the rules above.

2. **Search.** Call `qmetry_search_test_cases` with:
   - `project_id` = resolved ID
   - `search_text` = `$2` if it's free text
   - `key` = `$2` if it looks like a test case key (e.g. `PROJ-TC-5`)
   - `fields` = `summary,status,priority`
   - `max_results` = 25

3. **Render results table:**
   ```
   Key           | Status   | Priority | Summary
   --------------|----------|----------|---------------------------
   PROJ-TC-5     | To Do    | Medium   | Login flow smoke test
   PROJ-TC-6     | Done     | High     | Payment edge case
   ```
   Show total count. If `total > max_results`, offer to page.

4. **Follow-ups:**
   - "View a test case" → `/atlassian-suite:as-qmetry-testcase <key>`
   - "Filter by status" → re-run with `status` filter
   - "See test cycles for a Jira issue" → `/atlassian-suite:as-qmetry-coverage <jira-issue-key>`
