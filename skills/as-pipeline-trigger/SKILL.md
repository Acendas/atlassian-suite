---
name: as-pipeline-trigger
description: Trigger a Bitbucket Pipelines build.
argument-hint: "<repo-slug> <branch-or-commit> [pattern]"
allowed-tools: mcp__acendas-atlassian__trigger_pipeline, mcp__acendas-atlassian__list_branches, mcp__acendas-atlassian__list_pipeline_variables, mcp__acendas-atlassian__get_pipeline
---

# Trigger a Bitbucket Pipeline

## Inputs

`$1` = Repo slug.
`$2` = Target — branch name (default behavior), tag name, or commit SHA. Auto-detected: 7+ hex chars → commit; otherwise branch.
`$3` = Optional pipeline pattern (custom pipeline name from `bitbucket-pipelines.yml`).

## Steps

1. Detect target type. If branch, validate via `list_branches`.
2. Ask the user to confirm the target shape (branch/commit) and pattern.
3. If the user wants to pass variables, ask which (and which should be `secured`).
4. Confirm before calling — pipelines consume build minutes and can deploy.
5. Call `mcp__acendas-atlassian__trigger_pipeline`. Print the new pipeline UUID and URL.
6. Offer to poll `get_pipeline` until done (`/atlassian-suite:as-pipeline-status`).

## Notes

- Custom patterns appear under `pipelines.custom` in the YAML.
- Tag triggers use `ref_type=tag`.
- Skill writes — always confirm before triggering.
