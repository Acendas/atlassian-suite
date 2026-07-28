---
name: as-publish-release-notes
description: Publish release notes to Confluence.
argument-hint: "<space-key> [parent-page-id-or-title] [page-title]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__confluence_create_page, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_update_page, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_search, mcp__plugin_atlassian-suite_acendas-atlassian__getConfluenceSpaces
---

# Publish Release Notes to Confluence

Push prepared release notes to Confluence. Pairs with the `release-notes` skill.

## Inputs

`$1` = Confluence space key (e.g. `ENG`, `PROD`).
`$2` = Optional parent page ID or title (page goes under it).
`$3` = Optional page title (defaults to `Release Notes — {today}`).

## Preconditions

The user should have just generated release notes content (via `/atlassian-suite:as-release-notes` or pasted into context). If no release notes are in context, ask the user to provide them or to run release-notes first.

## Steps

1. **Validate the space.** If `$1` is missing or unknown, call `mcp__plugin_atlassian-suite_acendas-atlassian__getConfluenceSpaces` and ask the user to pick.

2. **Resolve parent page.**
   - If `$2` is numeric → use as page ID.
   - If `$2` is a string → call `mcp__plugin_atlassian-suite_acendas-atlassian__confluence_search` with CQL `space = "{key}" AND title = "{$2}"`.
   - If empty → no parent (top-level in space).

3. **Determine title.** Default `Release Notes — {today YYYY-MM-DD}`. If the user provided a release version (e.g. `v1.4.0`), use `Release Notes — {version} — {today}`.

4. **Check for existing page.** Search by exact title in the space. If found, ASK the user whether to:
   - Update the existing page (call `mcp__plugin_atlassian-suite_acendas-atlassian__confluence_update_page`)
   - Create a new dated page alongside it
   - Cancel

5. **Convert markdown to Confluence format.** The MCP server accepts markdown for both `confluence_create_page` and `confluence_update_page` (it converts internally). Pass the release notes body as-is.

6. **Create or update.** Call the appropriate tool with `space_key`, `title`, `parent_id` (if any), and `content`.

7. **Report.** Print the page URL and a one-line summary: `Published to {space}/{title}: {url}`.

## Notes

- Never overwrite a page without explicit user confirmation — confluence_update_page increments the version, but the previous version is recoverable; surface this in the confirmation prompt.
- If publishing fails with permission error, suggest the user check their space permissions or use a different space.
