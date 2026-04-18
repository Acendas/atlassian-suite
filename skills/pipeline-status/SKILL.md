---
name: Bitbucket Pipeline Status
description: This skill should be used when the user asks for "pipeline status", "build status", "list pipelines", "is the build green", "show CI runs", or runs `/atlassian-suite:pipeline-status`. Lists recent Bitbucket Pipelines runs and summarizes pass/fail/in-progress.
argument-hint: "<repo-slug> [filter: latest|failed|inprogress]"
allowed-tools: mcp__acendas-atlassian__list_pipelines, mcp__acendas-atlassian__get_pipeline, mcp__acendas-atlassian__list_pipeline_steps, mcp__acendas-atlassian__get_pipeline_step_log
---

# Bitbucket Pipeline Status

## Inputs

`$1` = Repo slug.
`$2` = Filter: `latest` (default — last 10 runs), `failed`, `inprogress`.

## Steps

1. Call `mcp__acendas-atlassian__list_pipelines` with `sort=-created_on`, `pagelen=20`.
2. Filter:
   - `latest` → first 10
   - `failed` → `state.result.name = "FAILED"`
   - `inprogress` → `state.name = "IN_PROGRESS"`
3. Render compact table:
   ```
   #{build_number}  {state}  {target.ref_name}  {duration}  {created_on}  {trigger.name}
   ```
4. If a single failed run is highlighted, offer to drill in: list steps via `list_pipeline_steps` and fetch failing step logs via `get_pipeline_step_log`.
5. Cap at 30 rows.

## Notes

- Pipeline UUIDs are returned in `{curly braces}` — pass them through verbatim.
- Skill is read-only.
