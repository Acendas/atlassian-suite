---
name: Review PR with Multi-Scanner Pipeline
description: This skill should be used when the user asks to "review this PR", "review pull request", "deep review of PR X", "review with full pipeline", "thorough code review", "release-readiness review", or runs `/atlassian-suite:review-pr`. Runs the multi-agent code review pipeline (6 specialized scanners + investigator + critic) against a Bitbucket PR with Jira context. Auto-selects scope and stakes.
argument-hint: "<pr-url-or-id> [--high] [--quick]"
allowed-tools: mcp__acendas-atlassian__get_pull_request, mcp__acendas-atlassian__get_pull_request_diff, mcp__acendas-atlassian__get_pull_request_diffstat, mcp__acendas-atlassian__get_pull_request_commits, mcp__acendas-atlassian__get_pull_request_comments, mcp__acendas-atlassian__get_pull_request_activity, mcp__acendas-atlassian__get_file_contents, mcp__acendas-atlassian__add_inline_comment, mcp__acendas-atlassian__add_pull_request_comment, mcp__acendas-atlassian__jira_get_issue, Agent
---

# Review PR with Multi-Scanner Pipeline

Run a structured, multi-agent code review on a Bitbucket pull request with Jira context. Six specialized scanners in parallel → deep-dive investigator on borderline findings → critic on high-stakes PRs → consolidated verdict.

For one-shot single-PR work, this skill is the right entry point. For batch reviews across many PRs, the user should call `code-review-orchestrator` directly.

## Inputs

`$1` = PR identifier (full URL `https://bitbucket.org/<ws>/<repo>/pull-requests/<id>`, or `<repo>/<id>`).
Flags:
- `--high` — force high-stakes pipeline (runs critic regardless of auto-detection).
- `--quick` — skip the critic and investigators; scanner output only (faster, less thorough).

## Steps

1. **Resolve and confirm.** Parse `$1`. Fetch PR metadata (`get_pull_request`) and the diffstat (`get_pull_request_diffstat`). Print a one-line confirmation: `Reviewing <repo>/<id>: <title> (<files> files, +<a>/-<d>)`. If the PR is in `MERGED` or `DECLINED` state, ask the user whether to continue (post-merge review for learning is fine, but flag it).

2. **Resolve linked Jira issues.** Scan PR title + source branch + commits for `[A-Z][A-Z0-9]+-\d+`. If none found, ask the user — spec compliance can't be checked without a linked issue.

3. **Compute stakes** (or honor `--high`):
   - `high` if any of: diff > 500 LOC; files in `auth`/`payments`/`billing`/`crypto`/`session`/`token` paths; PR destination branch matches `release/*` or `main` from a long-lived feature branch; reviewers count > 3.
   - `standard` otherwise.

4. **Dispatch the orchestrator.** Use the Agent tool with `subagent_type: code-review-orchestrator`. Pass:
   ```
   Review pull request <workspace>/<repo>/pull-requests/<id>.
   Linked Jira: <KEYS>
   Stakes: <standard|high>
   Mode: <quick if --quick, otherwise full>
   ```
   The orchestrator runs Phases 1–6 (setup → 6 parallel scanners → aggregate → investigators → critic → render).

5. **Receive the verdict.** The orchestrator returns a structured report. Render it to the user verbatim — don't paraphrase.

6. **Action prompt.** After showing the verdict, ask the user one of three follow-ups:
   - **Post must-fix items as inline PR comments** (uses `add_inline_comment` per finding) — confirm the list, post one-by-one, report posted comment URLs.
   - **Post a single summary comment** (uses `add_pull_request_comment`) — render a Markdown digest, confirm, post.
   - **Just keep the report** (default — do nothing).

   Never post without explicit confirmation. Never approve/decline/request-changes — that's the user's call.

## Quick mode

When `--quick` is passed:
- Skip Wave 2 (investigator) — borderline findings (confidence 80–89) appear with a `[unverified]` tag in the report.
- Skip Wave 3 (critic).
- Output is the raw scanner aggregate.
- Useful for fast triage of a PR before deciding to do the full pipeline.

## Notes

- The orchestrator handles batching (≤8 files per scanner per round) and spillover automatically. For very large diffs (>50 files), expect a longer wait while rounds complete.
- Project rules: if the working directory has `.claude/rules/*.md` or `.claude/atlassian-suite-rules.md`, the patterns scanner reads them. Otherwise it infers conventions from sibling files in the diff.
- Severity rubric:
  - `must-fix` — block merge.
  - `should-fix` — fix before next sprint.
  - `consider` — code smell, log for future.
  - `needs-clarification` — investigator surfaced a question only the user can answer.
- Borderline findings (confidence 80–89) are sent to the opus investigator in the full pipeline — REFUTED ones are dropped from the report. This is the noise-control mechanism.
