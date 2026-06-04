---
name: as-qmetry-testcase
description: View or update a QMetry test case.
argument-hint: "<test-case-key> [project-id|jira-key] [action: show|update-execution]"
allowed-tools: mcp__acendas-atlassian__get_credentials_status, mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__qmetry_list_projects, mcp__acendas-atlassian__qmetry_get_test_case, mcp__acendas-atlassian__qmetry_search_executions, mcp__acendas-atlassian__qmetry_update_execution
---

# View / Update a QMetry Test Case

## Preflight

Call `get_credentials_status`. If `effective.qmetry.configured` is `false`, stop and output:

> QMetry is not configured. Run `/atlassian-suite:init`, select the **QMetry** section, and paste your API key (Jira → QMetry → Configuration → Open API → Generate). Then retry.

## Key architectural fact

**Jira project ID = QMetry project ID.** The test case key prefix encodes the project: `PROJ-TC-5` → prefix `PROJ` → find in `qmetry_list_projects` where `key == "PROJ"` → use that `id`. If a Jira issue key or numeric project ID is provided, use `fields.project.id` directly.

## Inputs

`$1` = Test case key, e.g. `PROJ-TC-5`.
`$2` = Project ID source (optional) — one of:
  - Numeric project ID (e.g. `10001`) — use directly
  - Jira/QMetry project key (e.g. `PROJ`) → match in `qmetry_list_projects` by `key`
  - Jira issue key (e.g. `PROJ-123`) → call `jira_get_issue(fields: ["project"])`, use `fields.project.id`
  - Omitted → extract prefix from `$1` and resolve via `qmetry_list_projects`
`$3` = Action (default `show`): `show` | `update-execution`

## Steps

### 1. Resolve project_id

If `$2` not provided: extract the prefix from `$1` (e.g. `PROJ` from `PROJ-TC-5`). Call `qmetry_list_projects` and find the entry where `key == "<prefix>"`. Use its `id`.

If `$2` is a Jira issue key: call `jira_get_issue(issue_key: $2, fields: ["project"])` → `fields.project.id`.

If `$2` is a Jira/QMetry project key: call `qmetry_list_projects`, match by `key`, use `id`.

If `$2` is a numeric ID: use it directly.

### 2. Load the test case

Call `qmetry_get_test_case(project_id: <resolved>, key: $1)`.

### 3. Render

```
PROJ-TC-5  To Do  Medium
Login flow — verify credentials are validated

Description: {first 5 lines}

Steps:
  1. {action} → {expected result}
  2. …

Labels: {labels}
```

### 4. Branch on action

- `show` → done.
- `update-execution` → call `qmetry_search_executions(project_id: <id>, test_case_key: $1)`. Show latest cycle + current status. Ask for new status (PASS / FAIL / BLOCKED / NOT RUN / IN PROGRESS) and optional comment. Confirm before writing. Call `qmetry_update_execution`.

Confirm before any write.
