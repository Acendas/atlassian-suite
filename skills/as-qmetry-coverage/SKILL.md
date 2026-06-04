---
name: as-qmetry-coverage
description: Show QMetry test coverage for a Jira issue.
argument-hint: "<jira-issue-key>"
allowed-tools: mcp__acendas-atlassian__get_credentials_status, mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_get_issue_property_keys, mcp__acendas-atlassian__jira_get_issue_property, mcp__acendas-atlassian__qmetry_search_test_cycles, mcp__acendas-atlassian__qmetry_get_test_cycle, mcp__acendas-atlassian__qmetry_get_test_cycle_test_cases, mcp__acendas-atlassian__qmetry_search_requirements, mcp__acendas-atlassian__qmetry_search_test_cases
---

# QMetry Test Coverage for a Jira Issue

## Preflight

Call `get_credentials_status`. If `effective.qmetry.configured` is `false`, stop and output:

> QMetry is not configured. Run `/atlassian-suite:init`, select the **QMetry** section, and paste your API key (Jira → QMetry → Configuration → Open API → Generate). Then retry.

## Key architectural fact

**Jira project ID = QMetry project ID.** QMetry is a Connect app that uses the same numeric IDs as Jira. `jira_get_issue` returns `fields.project.id` — pass it directly to every QMetry tool as `project_id`. No lookup or translation needed.

## Inputs

`$1` = Jira issue key, e.g. `PROJ-123`.

## Steps

### 1. Load the Jira issue

Call `jira_get_issue(issue_key: $1, fields: ["summary", "status", "project"])`.

Extract:
- `fields.project.id` → **QMetry project_id** (use this for all QMetry calls below)
- `fields.project.key` → project label for display
- `fields.summary` → issue title
- `fields.status.name` → current status

### 2. Check if QMetry test cycles are linked

Call `jira_get_issue_property_keys(issue_key: $1)`.

Look for a key containing `testcycle-execution-panel` in its name. If found, call `jira_get_issue_property` with that full key. The value is an array — its length is the number of linked test cycles. If the array is empty or the key is absent, note "No test cycles linked to this issue in QMetry."

### 3. Search for test cycles in the project

Call `qmetry_search_test_cycles(project_id: <from step 1>, max_results: 20)`.

### 4. Render

```
PROJ-123  In Progress
Summary: <issue summary>

QMetry Test Cycles — <project key> (id: <project_id>)
──────────────────────────────────────────────────────
Key           Status    Summary
PROJ-TR-12    Active    v1.3 Regression Test
```

If linked count from step 2 is known, note "X cycle(s) directly linked to this story."

### 5. Offer drill-downs

- "View test cases in a cycle" → call `qmetry_get_test_cycle_test_cases(test_cycle_id: <id>)` — shows each test case's execution status within the cycle
- "Show traceability — which Jira stories have test coverage" → call `qmetry_search_requirements(project_id: <id>, jira_issue_key: $1)` to find coverage for the specific issue
- "Search test cases in this project" → call `qmetry_search_test_cases(project_id: <id>)`
- "View a specific test case" → `/atlassian-suite:as-qmetry-testcase <TC-key>`
