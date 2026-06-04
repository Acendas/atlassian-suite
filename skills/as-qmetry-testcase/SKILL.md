---
name: as-qmetry-testcase
description: View or update a QMetry test case.
argument-hint: "<test-case-key> <project-id> [action: show|update-execution]"
allowed-tools: mcp__acendas-atlassian__get_credentials_status, mcp__acendas-atlassian__qmetry_get_test_case, mcp__acendas-atlassian__qmetry_search_executions, mcp__acendas-atlassian__qmetry_update_execution
---

# View / Update a QMetry Test Case

## Preflight

Call `get_credentials_status`. If `effective.qmetry.configured` is `false`, stop and output:

> QMetry is not configured. Run `/atlassian-suite:init`, select the **QMetry** section, and paste your API key (Jira → QMetry → Configuration → Open API → Generate). Then retry this command.

## Inputs

`$1` = Test case key, e.g. `NYW-TC-209`.
`$2` = Numeric QMetry project ID.
`$3` = Action (default `show`).

## Steps

1. **Load** via `qmetry_get_test_case` with the key and project ID.

2. **Render summary:**
   ```
   {KEY}  {status}  {priority}
   {summary}

   Description: {description, first 5 lines}

   Steps:
     1. {action} → {expected result}
     2. …

   Labels: {labels}
   ```

3. **Branch on action:**
   - `show` → done.
   - `update-execution` → load recent executions with `qmetry_search_executions` (filter by test case key). Show the latest cycle and current status. Ask for the new status (PASS / FAIL / BLOCKED / NOT RUN / IN PROGRESS) and optional comment. Confirm before writing. Call `qmetry_update_execution`.

4. **Confirm before any write.** Read the status and confirm explicitly with the user before calling `qmetry_update_execution`.
