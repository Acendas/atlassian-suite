---
name: as-deployments
description: Inspect Bitbucket deployments and environments.
argument-hint: "<repo-slug> [action: list|environments|variables] [environment-uuid]"
allowed-tools: mcp__acendas-atlassian__list_deployments, mcp__acendas-atlassian__get_deployment, mcp__acendas-atlassian__list_environments, mcp__acendas-atlassian__get_environment, mcp__acendas-atlassian__list_environment_variables
---

# Bitbucket Deployments

## Inputs

`$1` = Repo slug.
`$2` = Action: `list` (default — recent deploys), `environments`, `variables`.
`$3` = Environment UUID (required for `variables`).

## Steps

1. **list** → `list_deployments` with `sort=-created_on`. Render:
   ```
   {state}  {environment}  {release}  {commit}  {created_on}
   ```
2. **environments** → `list_environments`. Render id, name, type, rank.
3. **variables** → `list_environment_variables` for the given env. **Mark secured variables with `(secured)` and never print their values** (the API returns them masked).

## Notes

- For deployment promotion, use the Bitbucket UI — there's no first-class promote endpoint; the typical flow is to trigger a pipeline that targets the next environment.
- Skill is read-only.
