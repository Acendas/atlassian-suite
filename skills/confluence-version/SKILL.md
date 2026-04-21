---
name: Confluence Page Version History / Restore
description: This skill should be used when the user asks to "show version history of confluence page", "list previous versions", "revert confluence page", "restore old version", "roll back page", "undo recent edit on confluence", or runs `/atlassian-suite:confluence-version`. Lists page versions and restores a prior version. List uses v2; restore uses v1 (v2 has no restore endpoint).
argument-hint: "<page-id-or-title> <action: list|diff|restore> [version-number] [second-version-number]"
allowed-tools: mcp__acendas-atlassian__confluence_get_page_history, mcp__acendas-atlassian__confluence_get_page_diff, mcp__acendas-atlassian__confluence_restore_version, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title
---

# Confluence Page Versions

Inspect version history and restore prior versions. Useful for recovering from accidental edits, reviewing what changed when, or diffing across a specific pair of versions.

## Inputs

`$1` = Page id or title.
`$2` = Action: `list`, `diff`, or `restore`.
`$3` / `$4` = Version numbers (context-specific below).

## Steps

1. Resolve page id.

2. **Dispatch:**

   - **`list`** → `confluence_get_page_history(page_id)`. Returns cursor-paginated `VersionProjection[]` with `{number, authorId, createdAt, minorEdit, message}`. Render as a reverse-chronological table.

   - **`diff`** → `confluence_get_page_diff(page_id, version_a=$3, version_b=$4)`. Renders a unified-style diff between the two versions' ADF bodies (converted to Markdown for readability). If only one version argument is given, diff against the current version.

   - **`restore`** → This is destructive in that it writes a new version; confirm with the user. Call `confluence_restore_version(page_id, target_version=$3, message="...")`. The tool fetches the target version's body, writes it as current+1, and leaves the old versions in history (nothing is deleted). Always offer to include a restore `message` describing WHY (e.g. "reverting accidental paste").

3. Print the new `versionNumber` after restore, and suggest `confluence_get_page_diff` to review what changed.

## Notes

- `restore` is v1-backed (Atlassian v2 has no restore endpoint). Requires classic `write:confluence-content`.
- Very old versions may have no retrievable storage body — if so the tool returns a clear error. In that case, use `diff` to see what was in the old version at a metadata level.
- Restore increments the version counter — if you restored version 3 when the page was at version 10, the restored content becomes version 11. Versions 1-10 are still present in history.
