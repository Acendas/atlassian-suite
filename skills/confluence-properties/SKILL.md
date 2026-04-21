---
name: Confluence Page Properties (Structured Metadata)
description: This skill should be used when the user asks to "set a property on a confluence page", "add metadata to confluence page", "tag this runbook as reviewed", "record linked jira epic on the doc", "get property from page", "delete page property", or runs `/atlassian-suite:confluence-properties`. Reads, writes, and deletes structured key/value metadata on a Confluence page. Useful for machine-readable fields that shouldn't live in the page body — "last-reviewed-by", "linked-jira-epic", "source-sha", etc.
argument-hint: "<page-id-or-title> <action: list|get|set|delete> [key] [value]"
allowed-tools: mcp__acendas-atlassian__confluence_get_page_properties, mcp__acendas-atlassian__confluence_get_page_property, mcp__acendas-atlassian__confluence_set_page_property, mcp__acendas-atlassian__confluence_delete_page_property, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title
---

# Confluence Page Properties

Page properties are structured metadata attached to a Confluence page — key/value pairs where values can be any JSON. They're invisible in the page body and survive rewrites.

Examples of useful properties:
- `last-reviewed-by` → `{"accountId": "...", "date": "2026-04-20"}`
- `linked-jira-epic` → `"ENG-1234"`
- `runbook-owner` → `"@alice"`
- `source-of-truth-sha` → `"abc123def"`
- `review-cadence-days` → `90`

## Inputs

`$1` = Page id or title.
`$2` = Action: `list`, `get`, `set`, or `delete`.
`$3` = Property key (required for `get` / `set` / `delete`).
`$4` = Value (for `set` — JSON or literal).

## Steps

1. **Resolve page id.** Numeric → direct; title → `confluence_get_page_by_title` or `confluence_search`.

2. **Dispatch:**

   - **`list`** → `confluence_get_page_properties(page_id)`. Renders each entry `{key, value, version.number}`. Cursor-paginated.

   - **`get`** → `confluence_get_page_property(page_id, key)`. Returns the single key's record or null.

   - **`set`** → Two sub-cases:
     - **Create (new key)** → `confluence_set_page_property(page_id, key, value)` — omit `version_number`.
     - **Update (existing key)** → first `confluence_get_page_property(page_id, key)` to read `version.number`, then `confluence_set_page_property(page_id, key, value, version_number=N+1)`.
     - If `$4` parses as JSON, pass the parsed object/array/primitive. Otherwise pass as string.

   - **`delete`** → confirm with the user; `confluence_delete_page_property(page_id, key)`.

3. **Confirm writes** — surface old value (if any) and new value before committing.

## Notes

- Keys are ≤255 chars. Values are any JSON — objects, arrays, strings, numbers, booleans, nulls.
- Properties are versioned. Updating requires the NEXT version number (current + 1), same pattern as page updates.
- Require the granular `read:page:confluence` / `write:page:confluence` scopes.
- Use this instead of stuffing metadata into page body HTML comments — properties are queryable and don't pollute content.
