---
name: Confluence Page Labels
description: This skill should be used when the user asks to "tag a confluence page", "add label to confluence", "remove label from page", "list confluence labels", "label this as runbook", or runs `/atlassian-suite:confluence-labels`. Lists, adds, and removes labels on a Confluence page. List uses v2; add/remove use v1 (v2 labels API is read-only).
argument-hint: "<page-id-or-title> <action: list|add|remove> [label-names...]"
allowed-tools: mcp__acendas-atlassian__confluence_get_labels, mcp__acendas-atlassian__confluence_add_label, mcp__acendas-atlassian__confluence_remove_label, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title
---

# Confluence Page Labels

Labels (tags) help organize and filter pages. They're the primary way to group related docs across spaces.

## Inputs

`$1` = Page id or title.
`$2` = Action: `list` (default), `add`, or `remove`.
`$3+` = For `add`/`remove` → one or more label names (no `#` prefix).

## Steps

1. **Resolve page id.**

2. **Dispatch:**

   - **`list`** → `confluence_get_labels(page_id)`. Cursor-paginated. Render `{name} (prefix)`.
   - **`add`** → `confluence_add_label(page_id, labels=[...], prefix="global")`. Bulk — pass multiple names in one call. Uses v1 (v2 labels are read-only). Requires classic `write:confluence-content`.
   - **`remove`** → `confluence_remove_label(page_id, name, prefix="global")`. v1 endpoint removes ONE label per call; loop if the user provides several.

3. **Confirm** label operations before applying (especially `remove` — removing a label that filters a dashboard elsewhere can be surprising).

## Notes

- Default `prefix` is `global` — the normal label type. `my` (personal) and `team` exist but are rarely used.
- Adding a label that's already on the page is a no-op. Removing a label that isn't on the page returns 404; the tool surfaces this cleanly.
- v2's `/pages/{id}/labels` is READ-ONLY. Atlassian hasn't shipped granular write endpoints for labels, so add/remove stay on classic v1 indefinitely.
