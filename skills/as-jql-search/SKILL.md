---
name: as-jql-search
description: Search Jira via natural-language to JQL.
argument-hint: "<natural-language-query-or-jql>"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__jira_search, mcp__plugin_atlassian-suite_acendas-atlassian__jira_search_fields
---

# JQL Search Helper

Translate a natural-language query into JQL, run it, summarize results.

## Inputs

`$1` = Natural-language query OR raw JQL (auto-detected: if `$1` contains `=`, `~`, `AND`, or `ORDER BY`, treat as JQL).

## Steps

1. **Detect mode.** Raw JQL → skip to step 4.

2. **Translate.** Build JQL from the natural language. Common patterns:
   - "my open issues" → `assignee = currentUser() AND statusCategory != Done`
   - "bugs in PROJ from last week" → `project = PROJ AND issuetype = Bug AND created >= -7d`
   - "high priority unassigned" → `priority in (High, Highest) AND assignee is EMPTY`
   - "issues I commented on" → `commentedBy = currentUser()`

3. **Show the JQL** to the user before running. If they object, refine.

4. **Run** via `mcp__plugin_atlassian-suite_acendas-atlassian__jira_search` (limit 50, expand only `summary,status,assignee,priority,issuetype`).

5. **Render** as a compact table:
   ```
   {KEY}  {issuetype}  {status}  {summary}  ({assignee})
   ```

6. **Offer follow-ups.** "Want to triage one? Use `/atlassian-suite:as-triage-issue {KEY}`."

## Notes

- For unknown custom fields, call `mcp__plugin_atlassian-suite_acendas-atlassian__jira_search_fields` to discover the cf id.
- Cap at 50 results; warn the user if `total` > 50.
