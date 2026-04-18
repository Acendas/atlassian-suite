---
name: Triage Jira Issue
description: This skill should be used when the user asks to "triage this issue", "triage the bug", "categorize this jira ticket", "find related docs and prs for this issue", or runs `/atlassian-suite:triage-issue`. Pulls related Confluence docs and Bitbucket PRs/commits for a Jira issue, suggests labels/priority/component, and proposes a transition.
argument-hint: "<issue-key>"
allowed-tools: mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_get_transitions, mcp__acendas-atlassian__jira_transition_issue, mcp__acendas-atlassian__jira_update_issue, mcp__acendas-atlassian__jira_search, mcp__acendas-atlassian__confluence_search, mcp__acendas-atlassian__list_pull_requests
---

# Triage a Jira Issue

Enrich a Jira issue with related context and propose a triage action.

## Inputs

`$1` = Jira issue key (e.g. `PROJ-456`).

## Steps

1. **Load the issue.** Call `mcp__acendas-atlassian__jira_get_issue`. Capture summary, description, current status, type, priority, labels, components, assignee.

2. **Find related context in parallel:**
   - **Similar issues:** `mcp__acendas-atlassian__jira_search` with JQL `project = {project} AND text ~ "{key-terms-from-summary}" AND key != {issue-key}` (limit 5). Key terms = top 3 nouns from summary.
   - **Confluence docs:** `mcp__acendas-atlassian__confluence_search` with CQL `text ~ "{key-terms}"` (limit 5).
   - **Related PRs:** `mcp__acendas-atlassian__list_pull_requests` searching by query `{issue-key}` if the API supports it; otherwise list recent PRs and grep their titles/descriptions for `{issue-key}`.
   - **Available transitions:** `mcp__acendas-atlassian__jira_get_transitions`.

3. **Analyze:**
   - **Duplicates?** If a similar issue has near-identical summary AND is open, flag it.
   - **Component/label suggestions:** From the related issues + Confluence docs, identify common labels/components. Propose them.
   - **Priority suggestion:** If the description contains keywords like `prod down`, `customer impact`, `data loss`, suggest `Highest` or `Critical`. If `nice to have`, `cleanup`, suggest `Low`. Otherwise leave as-is.
   - **Next transition:** If status is `Open`/`To Do` and a related PR exists in `OPEN` state → suggest `In Progress`. If status is `In Review` and a related PR is `MERGED` → suggest `Done`.

4. **Render the brief:**

   ```
   {ISSUE-KEY} — {summary}
   Status: {current} → suggested: {proposed}
   Type: {type}  Priority: {current} → suggested: {proposed}
   Labels: {current} → suggested: +{add} -{remove}
   Component: {current} → suggested: {proposed}

   Related issues:
   - {KEY}: {summary} ({status})

   Related Confluence:
   - {title} — {url}

   Related PRs:
   - PR #{id}: {title} ({state})

   Possible duplicates:
   - {KEY} — {similarity reason}

   Suggested next action:
   - Transition to {status}
   - Add labels: {labels}
   - Assign to: {user (if obvious from PR author)}
   ```

5. **Offer to apply.** Ask the user to confirm any subset of the proposed changes. Only apply on explicit yes (use `jira_update_issue` and `jira_transition_issue`). Default action: report only.

## Notes

- Read-only by default — never apply changes without explicit confirmation.
- Cap each related-context section at 5 results.
- If no related context is found, report `No related context found` for that section.
