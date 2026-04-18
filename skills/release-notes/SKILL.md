---
name: Generate Release Notes
description: This skill should be used when the user asks to "generate release notes", "draft release notes", "what changed in this release", "changelog from PRs and Jira", or runs `/atlassian-suite:release-notes`. Builds release notes by intersecting merged Bitbucket PRs in a date or commit range with their linked Jira issues, grouped by issue type.
argument-hint: "<repo-slug> <since-ref-or-date> [until-ref-or-date]"
allowed-tools: mcp__acendas-atlassian__list_pull_requests, mcp__acendas-atlassian__get_pull_request, mcp__acendas-atlassian__get_pull_request_commits, mcp__acendas-atlassian__jira_get_issue, mcp__acendas-atlassian__jira_search
---

# Generate Release Notes

Produce release notes from merged PRs + linked Jira issues.

## Inputs

`$1` = Bitbucket repo slug.
`$2` = Range start — date (`YYYY-MM-DD`), git ref, or `last-release`.
`$3` = Optional range end (defaults to `now`).

## Steps

1. **Resolve the range.** If `$2` is `last-release`, ask the user for the previous release tag/date. Otherwise treat `$2` and `$3` as dates if they parse, else as git refs.

2. **Fetch merged PRs.** Call `mcp__acendas-atlassian__list_pull_requests` with `state=MERGED`, then filter client-side to PRs whose `merged_on` falls in the range.

3. **Extract Jira keys per PR.** For each PR:
   - Scan PR title, description, source branch, and commit messages (`mcp__acendas-atlassian__get_pull_request_commits`) for `[A-Z][A-Z0-9]+-\d+`.
   - De-duplicate keys per PR.

4. **Fetch issues.** Call `mcp__acendas-atlassian__jira_get_issue` for each unique issue key (parallelize, cap at 50). Capture: summary, issuetype (Bug/Story/Task/Epic), labels, fixVersion.

5. **Group by category:**

   ```
   ## 🚀 Features
   - {summary} ({ISSUE-KEY}) — PR #{id}

   ## 🐛 Bug Fixes
   - {summary} ({ISSUE-KEY}) — PR #{id}

   ## 🔧 Improvements / Tasks
   - {summary} ({ISSUE-KEY}) — PR #{id}

   ## 📝 Other (PRs without linked Jira issues)
   - {pr-title} — PR #{id}
   ```

   Map issue types: Bug → Bug Fixes; Story/Epic/New Feature → Features; Task/Sub-task/Improvement → Improvements/Tasks. Anything else falls under Improvements/Tasks.

6. **Render output.** Markdown by default. Offer Confluence wiki markup as an alternate format if the user mentions Confluence (and offer to call `/atlassian-suite:publish-release-notes` to push it).

7. **Report counts.** End with: `Range: {start} → {end} | {pr_count} PRs | {issue_count} unique issues | {features}/{fixes}/{tasks} by category`.

## Notes

- If `JIRA_PROJECTS_FILTER` is set, issue keys outside the filter return 404 — list those PRs in the "Other" section.
- Do not invent changelog entries from PR titles alone; if a PR is unclear, list it under "Other" verbatim.
- For very large ranges (>100 PRs), warn the user and offer to chunk by week.
