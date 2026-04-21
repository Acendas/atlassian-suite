---
name: Copy Confluence Page or Hierarchy
description: This skill should be used when the user asks to "copy a confluence page", "duplicate this page", "copy page tree to another space", "clone this runbook as a template", "copy page hierarchy", or runs `/atlassian-suite:confluence-copy`. Copies a single page (synchronous) or an entire subtree (asynchronous long-task). v1-backed — v2 has no copy endpoint.
argument-hint: "<source-page-id> <destination-parent-page-id> [mode: page|hierarchy] [new-title]"
allowed-tools: mcp__acendas-atlassian__confluence_copy_page, mcp__acendas-atlassian__confluence_copy_page_hierarchy_start, mcp__acendas-atlassian__confluence_copy_page_hierarchy_status, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title
---

# Copy a Confluence Page (or Whole Subtree)

Two modes:

- **Single page** (default, synchronous) — copies one page, returns the new page id immediately.
- **Hierarchy** — copies the page AND all its descendants, asynchronously. Returns a task id; poll status until complete.

## Inputs

`$1` = Source page id to copy FROM.
`$2` = Destination parent page id (copy will be placed under this page).
`$3` = Mode: `page` (default) or `hierarchy`.
`$4` = Optional new title override (single-page mode only).

## Steps

### Single-page copy

1. Confirm source and destination pages with the user (fetch titles via `confluence_get_page` for both).
2. Call `confluence_copy_page(source_page_id, destination_parent_id, new_title?, destination_space_key?)`.
3. Print the new page id + URL.

### Hierarchy copy

1. Confirm — hierarchy copies can be expensive (one operation per descendant).
2. Kick off: `confluence_copy_page_hierarchy_start(source_page_id, destination_parent_id, title_options_prefix?)`. Returns an Atlassian long-task id.
3. Poll: `confluence_copy_page_hierarchy_status(task_id)` every ~10s until `successful: true`. Show `percentageComplete` progress each tick.
4. On completion, report the count of pages copied and the root new-page id.
5. If `successful: false` and `errors` is present, surface the errors.

## Options

- `copy_attachments` (default true) — duplicate attachments with the copies
- `copy_permissions` (default false) — usually you want the copy to inherit default permissions
- `copy_labels` (default true) — preserves tags
- `copy_properties` (default false) — structured metadata (page properties); often out of date post-copy, so default off
- `title_options_prefix` — hierarchy-copy only; prepends a string to every copied page's title (e.g. "DRAFT - ")
- `destination_space_key` — single-page only; move the copy to a different space

## Notes

- Hierarchy copy is split into `_start` and `_status` tools on purpose — the MCP server doesn't block while polling, and the caller (agent) decides when to check progress.
- Requires classic `write:confluence-content` scope.
- Single-page copy is safe to interrupt; hierarchy copy leaves partial results if aborted — you can re-run at a different destination to avoid name collisions.
