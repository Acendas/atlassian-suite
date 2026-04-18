---
name: PR Review Follow-up to Jira
description: This skill should be used when the user asks to "create jira issues from review findings", "spin out follow-ups from PR review", "convert review notes to tickets", "file the follow-up bucket", "create issues for the follow-ups", or runs `/atlassian-suite:pr-followup`. Converts the follow-up bucket from a PR review into Jira issues with batch confirmation.
argument-hint: "[pr-id-or-url] [project-key]"
allowed-tools: mcp__acendas-atlassian__jira_create_issue, mcp__acendas-atlassian__jira_batch_create_issues, mcp__acendas-atlassian__jira_create_remote_issue_link, mcp__acendas-atlassian__jira_get_all_projects, mcp__acendas-atlassian__getJiraProjectIssueTypesMetadata, mcp__acendas-atlassian__get_pull_request, AskUserQuestion
---

# PR Review Follow-up to Jira

Convert the **follow-up bucket** from a PR review into Jira issues. Use after running `/atlassian-suite:review-pr` produced a list of "worthwhile but broader" items that don't belong in the PR but shouldn't be lost.

## Inputs

`$1` = Optional PR identifier — used to add a remote link from each new issue back to the PR.
`$2` = Optional Jira project key — defaults to last-used or asks.

The skill expects the follow-up findings to be present in the conversation (from a recent `code-review-orchestrator` run). If they're not, ask the user to paste or re-run the review.

## Steps

1. **Collect the follow-ups.** Re-read the recent orchestrator output for the `━━━ FOLLOW-UP ━━━` block. Each item has: scanner, file:line, summary, suggested issue title.

2. **Resolve the project.** If `$2` provided, validate via `jira_get_all_projects`. Else ask the user (offer recently-used).

3. **Pick issue type per follow-up.** Default heuristics:
   - `[bugs]` / `[silent-failures]` / `[security]` → `Bug`
   - `[performance]` / `[database]` / `[observability]` / `[rollout]` → `Task` (Tech Debt label)
   - `[patterns]` / `[contracts]` → `Task` with `Refactor` label
   - `[tests]` → `Task` with `Test Debt` label
   - `[spec]` → `Story` (deferred AC)
   Override when the user specifies.

4. **Compose drafts.** For each follow-up, build:
   ```
   Project: <PROJ>
   Type: <Bug | Task | Story>
   Summary: <suggested title — under 120 chars>
   Description: |
     ### Source
     PR #<id> — <pr-url>
     File: <file>:<line>
     Scanner: <name> (confidence <C>)

     ### Finding
     <summary>

     ### Suggested fix
     <evidence / approach>
   Labels: <derived from scanner>
   ```

5. **Show the user the full batch table** with checkboxes:
   ```
   #  Type   Summary                                              Labels
   1  Task   Refactor audit query to remove N+1                   tech-debt, perf
   2  Bug    Empty except in legacy session validator             bug
   3  Task   Add metrics to billing.charge_card error path        observability
   ...
   ```
   Use `AskUserQuestion` to let the user pick which to create (multi-select), or accept `all`.

6. **Create.** For ≥3 confirmed, use `jira_batch_create_issues`; for 1–2 use `jira_create_issue` per item. Capture returned keys.

7. **Link back to the PR.** For each created issue, call `jira_create_remote_issue_link` with the PR URL, title `[<repo>] PR #<id>: <pr-title>`, relationship `relates`.

8. **Report.**
   ```
   Created N follow-up issues from PR #<id>:
   - PROJ-1234 — <summary> → <jira-url>
   - PROJ-1235 — ...
   ```

## Notes

- Read-only mode: if `READ_ONLY_MODE=true`, render the drafts but skip creation; tell the user.
- Hand off: if the user wants to also assign + prioritize + sprint-bucket the new issues, route to `triage-orchestrator` after creation.
- Keep summaries surgical — these are tracking issues, not full specs. The PR review report has the evidence already.
