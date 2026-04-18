---
name: Bitbucket Branch Protection
description: This skill should be used when the user asks to "audit branch protection", "show branch restrictions", "protect main branch", "require approvals", "branch policy", or runs `/atlassian-suite:branch-protection`. Lists branch restrictions on a repo and helps add/remove protection rules.
argument-hint: "<repo-slug> [action: list|add|remove] [args...]"
allowed-tools: mcp__acendas-atlassian__list_branch_restrictions, mcp__acendas-atlassian__create_branch_restriction, mcp__acendas-atlassian__update_branch_restriction, mcp__acendas-atlassian__delete_branch_restriction, mcp__acendas-atlassian__get_branching_model_settings, mcp__acendas-atlassian__update_branching_model_settings
---

# Bitbucket Branch Protection

## Inputs

`$1` = Repo slug.
`$2` = Action: `list` (default), `add`, `remove`.
`$3+` = Action-specific args.

## Steps

1. **list** → `list_branch_restrictions`. Render by pattern → kind → value, plus bypass users/groups. Highlight common gaps:
   - `main`/`master` without `require_approvals_to_merge` ≥ 1
   - `main`/`master` without `require_passing_builds_to_merge`
   - No `force` block on `main`

2. **add** → ask for pattern + kind + value (and optional bypass users), confirm, call `create_branch_restriction`.

3. **remove** → require `restriction_id`, confirm, call `delete_branch_restriction`.

4. Optionally surface the branching model: `get_branching_model_settings` shows development/production/branch type config.

## Notes

- Branch protection changes are visible to the team. Always confirm before writing.
- Glob patterns supported: `release/*`, `feature/**`.
