---
name: as-qmetry-search
description: Search QMetry test cases in a project.
argument-hint: "[project-id] [search text]"
allowed-tools: mcp__acendas-atlassian__get_credentials_status, mcp__acendas-atlassian__qmetry_list_projects, mcp__acendas-atlassian__qmetry_search_test_cases
---

# Search QMetry Test Cases

## Preflight

Call `get_credentials_status`. If `effective.qmetry.configured` is `false`, stop and output:

> QMetry is not configured. Run `/atlassian-suite:init`, select the **QMetry** section, and paste your API key (Jira → QMetry → Configuration → Open API → Generate). Then retry this command.

## Inputs

`$1` = Numeric QMetry project ID (optional — if omitted, list projects and ask).
`$2` = Search text or filter (optional).

## Steps

1. **Resolve project.** If no project ID provided, call `qmetry_list_projects` and show the list (id | key | name). Ask the user to confirm which project ID to use.

2. **Search.** Call `qmetry_search_test_cases` with:
   - `project_id` = resolved project ID
   - `search_text` = `$2` if provided
   - `fields` = `summary,status,priority`
   - `max_results` = 25

3. **Render results table:**
   ```
   Key          | Status       | Priority | Summary
   -------------|--------------|----------|-----------------------------
   NYW-TC-209   | To Do        | Medium   | [AllClients] venVUE Status …
   ```
   Show total count. If `total > max_results`, note how many more exist and offer to page.

4. **Follow-ups.** Offer:
   - "View details of a test case" → run `/atlassian-suite:as-qmetry-testcase <key> <project_id>`
   - "Filter by status" → re-run with `status` filter
   - "Search in a different project" → restart from step 1
