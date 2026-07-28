---
name: as-qmetry-testcase
description: View or update a QMetry test case.
argument-hint: "<test-case-key> [project-id|jira-key] [action: show|update-execution]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__get_credentials_status, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_issue, mcp__plugin_atlassian-suite_acendas-atlassian__jira_get_user_profile, mcp__plugin_atlassian-suite_acendas-atlassian__jira_search, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_list_projects, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_get_test_case, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_get_test_case_requirements, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_search_test_cycles, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_search_executions, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_get_execution, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_update_execution, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_list_execution_attachments, mcp__plugin_atlassian-suite_acendas-atlassian__qmetry_upload_execution_attachment
---

# View / Update a QMetry Test Case

## Preflight

Call `get_credentials_status`. If `effective.qmetry.configured` is `false`, stop and output:

> QMetry is not configured. Run `/atlassian-suite:init`, select the **QMetry** section, and paste your API key (Jira → QMetry → Configuration → Open API → Generate). Then retry.

## Key architectural fact

**Jira project ID = QMetry project ID.** The test case key prefix encodes the project: `PROJ-TC-5` → prefix `PROJ` → find in `qmetry_list_projects` where `key == "PROJ"` → use that `id`. If a Jira issue key or numeric project ID is provided, use `fields.project.id` directly.

## Inputs

`$1` = Test case key, e.g. `PROJ-TC-5`.
`$2` = Project ID source (optional):
  - Numeric project ID — use directly
  - Jira/QMetry project key (e.g. `PROJ`) → match in `qmetry_list_projects` by `key`
  - Jira issue key (e.g. `PROJ-123`) → call `jira_get_issue(fields: ["project"])`, use `fields.project.id`
  - Omitted → extract prefix from `$1` and resolve via `qmetry_list_projects`
`$3` = Action (default `show`): `show` | `update-execution`

## Steps

### 1. Resolve project_id

If `$2` not provided: extract prefix from `$1` (e.g. `PROJ` from `PROJ-TC-5`). Call `qmetry_list_projects`, match by `key`, use `id`.

If `$2` is a Jira issue key: call `jira_get_issue(issue_key: $2, fields: ["project"], include_qmetry: false)` → `fields.project.id`.

If `$2` is a project key or numeric ID: match in `qmetry_list_projects` or use directly.

### 2. Load the test case

Call `qmetry_get_test_case(project_id: <resolved>, key: $1)`.

The response includes a `jira` field automatically:
- `jira.project_key`, `jira.project_name` — Jira project context for this test case

### 3. Render

```
PROJ-TC-5  To Do  Medium
{summary}

Jira project: {jira.project_name} ({jira.project_key})

Description: {first 5 lines}

Steps:
  1. {action} → {expected result}
  2. …

Labels: {labels}
```

### 4. Show linked Jira requirements

If the response includes a `jira` field, show the project context. Then call `qmetry_get_test_case_requirements(test_case_id: <tc.id>)` to list the Jira issues this test case covers:

```
Covers: PROJ-123, PROJ-456
```

If no requirements are linked, note "No Jira issues linked for traceability."

### 5. Branch on action

- `show` → done.
- `update-execution` → follow the **execution-update flow** below.

## Execution-update flow

A test case has no execution on its own — executions live inside a **test cycle**. Updating one is a four-id chase: project → cycle → `testCycleTestCaseMapId` → `testCaseExecutionId`. Do not shortcut it; `qmetry_update_execution` needs the `execution_id` (`testCaseExecutionId`), which only `qmetry_get_execution` returns.

### A. Find the test cycle

`qmetry_search_executions` takes a **`test_cycle_id`** (not a project_id), so you need the cycle first.

- If the user named a cycle (e.g. `PROJ-TR-180`) or you already have its internal id, use it.
- Otherwise call `qmetry_search_test_cycles(project_id: <resolved>)` and show the cycles; if more than one could apply, ask which cycle. Use the cycle's internal `id` (opaque string) as `test_cycle_id` — **not** the `PROJ-TR-n` key.

### B. Resolve the execution id

1. `qmetry_search_executions(test_cycle_id: <id>, test_case_key: $1)` → read `testCycleTestCaseMapId` for this test case in the cycle.
2. `qmetry_get_execution(test_cycle_id: <id>, test_cycle_map_id: <testCycleTestCaseMapId>)` → read the **`testCaseExecutionId`** (this is the `execution_id`), plus the current `executionResult`, `assignee`, `comment`, and `hasAttachment`.

Show the current state (cycle, status, assignee, comment, attachment count) before changing anything.

### C. Gather the change

Ask for any of: new status (PASS / FAIL / BLOCKED / NOT RUN / IN PROGRESS), comment, assignee, evidence file.

- **Assignee** is an **Atlassian account id** (e.g. `712020:45a4…`), not a display name. Resolve it with `jira_get_user_profile` (by email/username) or `jira_search`, and pass it as `assignee_account_id`. The QMetry account is the same Atlassian identity, so the assignee must be a member of the QMetry project for it to stick.

### D. Write, then read back to confirm

Confirm with the user before any write. Then:

1. `qmetry_update_execution(test_cycle_id, execution_id, status_name + project_id, comment, assignee_account_id)` — pass only the fields being changed. `status_name` requires `project_id` (used to map the name to the project's `executionResultId`).
2. To attach evidence: `qmetry_upload_execution_attachment(test_cycle_id, execution_id, project_id, local_file_path)` — the file links to *this execution* (not just the cycle file store).
3. **Verify — a 2xx is not proof.** QMetry silently ignores some malformed writes and still returns success. Re-call `qmetry_get_execution` and confirm the new status / `assignee` / `comment` actually changed; for an attachment, call `qmetry_list_execution_attachments(test_cycle_id, execution_id)` and confirm the file is listed. Report what the read-back actually shows, not just that the write call returned OK.

Confirm before any write.
