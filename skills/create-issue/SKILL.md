---
name: Create Jira Issue
description: This skill should be used when the user asks to "create a jira issue", "file a bug in jira", "create a story", "open a ticket from this", or runs `/atlassian-suite:create-issue`. Creates a Jira issue with smart defaults pulled from current context (project, type, summary, description, labels), then asks once for confirmation.
argument-hint: "[project-key] [summary]"
allowed-tools: mcp__acendas-atlassian__jira_get_all_projects, mcp__acendas-atlassian__jira_create_issue, mcp__acendas-atlassian__jira_batch_create_issues, mcp__acendas-atlassian__jira_get_user_profile, mcp__acendas-atlassian__getJiraProjectIssueTypesMetadata
---

# Create a Jira Issue

Create a Jira issue with sensible defaults derived from context.

## Inputs

`$1` = Optional project key (e.g. `PROJ`).
`$2` = Optional summary.

If both omitted, derive from the current conversation. If the conversation lacks enough signal, ask the user.

## Steps

1. **Resolve the project.**
   - If `$1` is provided, validate via `mcp__acendas-atlassian__jira_get_all_projects` (cached).
   - Else: ask the user, offering the 5 most recently-used projects from prior session memory if available.

2. **Pick the issue type.** Defaults by signal:
   - Bug language ("crashes", "broken", "regression", "doesn't work") → `Bug`
   - Question or how-to → `Task`
   - Otherwise → `Story` (or `Task` if Story not available).

   Validate the chosen type exists in the project via `mcp__acendas-atlassian__getJiraProjectIssueTypesMetadata`. If not, fall back to `Task`.

3. **Compose the summary.** If `$2` is provided, use it. Else generate a one-line summary from the conversation context. Cap at 120 chars.

4. **Compose the description.** Markdown with:
   - **Context** — 2–3 lines on what triggered this.
   - **Steps to reproduce** (Bug only) — bullet list.
   - **Expected** vs **Actual** (Bug only).
   - **Acceptance criteria** (Story/Task) — bullet list.
   - **References** — any URLs, file paths, PR links from the conversation.

   Pull from the conversation — don't fabricate steps you didn't see.

5. **Suggest fields.** Offer to add: `priority`, `labels`, `assignee` (default: unassigned), `epic link`. For each, propose a default and let the user accept/change in one prompt.

6. **Confirm before creating.** Show the user the assembled payload (project, type, summary, description preview, fields) in a single block. Wait for explicit yes.

7. **Create.** Call `mcp__acendas-atlassian__jira_create_issue`. Report the new key and URL.

## Notes

- Read-only mode (`READ_ONLY_MODE=true`) blocks creation — detect and tell the user instead of failing silently.
- Never fabricate reproduction steps. If a Bug doesn't have clear repro from context, ask the user.
- For multi-issue creation (epics with sub-tasks), use `mcp__acendas-atlassian__jira_batch_create_issues` after confirming the full set with the user.
