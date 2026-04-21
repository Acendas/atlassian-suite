---
name: Read / Edit a Confluence Page
description: This skill should be used when the user asks to "show confluence page X", "read this confluence page", "rewrite confluence page", "create a child page", or runs `/atlassian-suite:confluence-page`. Reads a page or performs a FULL-PAGE rewrite/create. For partial edits (sections, find/replace, append), prefer `/atlassian-suite:confluence-edit`.
argument-hint: "<page-id-or-title-or-url> [action: read|rewrite|create-child] [body-file-or-text]"
allowed-tools: mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_update_page, mcp__acendas-atlassian__confluence_create_page, mcp__acendas-atlassian__confluence_get_comments, mcp__acendas-atlassian__confluence_search, mcp__acendas-atlassian__getConfluenceSpaces, mcp__acendas-atlassian__confluence_get_space, mcp__acendas-atlassian__confluence_get_page_diff
---

# Read / Edit a Confluence Page

Operate on a single Confluence page — full-page reads, full-page rewrites, child page creation.

For surgical edits (replace one section, append, find/replace, insert after heading) **use `/atlassian-suite:confluence-edit` instead**. This skill replaces or creates entire pages.

## Inputs

`$1` = Page ID, title, or full URL.
`$2` = Action (`read`, `rewrite`, `create-child`); default `read`.
`$3` = Optional body (path to a file or inline text) for rewrite/create.

## Steps

1. **Resolve the page.**
   - Numeric → page ID, go directly to step 2.
   - URL → extract page id from `/pages/{id}/`.
   - Title → first prefer `confluence_get_page_by_title(space_id, title)` (one v2 call, no CQL). If you don't know the space id yet, ask the user which space, then use `getConfluenceSpaces` to map key → id, then call `confluence_get_page_by_title`. Fall back to `confluence_search` with a CQL query if the title is fuzzy.

2. **Branch on action:**

   - **`read`** → `confluence_get_page(page_id, body_format="atlas_doc_format")`. Renders a normalized `PageProjection` (`title`, `versionNumber`, `body`, `spaceId`, `parentId`). Show title + first 1500 chars of body + `versionNumber`.
     - If the user asks about images/charts/macros, call again with `body_format="storage"` so macros are visible.
     - Use `confluence_get_comments(page_id)` if the user asks about feedback/discussion on the page.

   - **`rewrite`** → fetch current page first to get the current `versionNumber`. **Choose the right body input:**
     - If new content has images, charts, info panels, or other Confluence macros → `body_storage` with raw XHTML
     - If user provided pre-built ADF JSON → `body_adf`
     - If pure prose with headings/lists/links → `body_markdown` (auto-converted; may strip custom macros)
     - Call `confluence_update_page(page_id, title, version_number=current+1, body_<format>=...)`.
     - Optionally call `confluence_get_page_diff(page_id, version_a=current, version_b=current+1)` after update so the user can review what changed.
     - **Warn the user explicitly** if the page contains macros and they're rewriting via `body_markdown` — those macros will be stripped.

   - **`create-child`** → ask for title and parent id (default = the resolved page). Need the numeric `space_id` — get via `getConfluenceSpaces` or `confluence_get_space`. Same body-format choice as rewrite. Call `confluence_create_page(space_id, title, parent_id, body_<format>=...)`.

3. **Always confirm writes.** Page version increments on update; surface the returned `versionNumber` in the confirmation prompt.

## Notes

- For ANY change smaller than "rewrite the whole thing", route to `/atlassian-suite:confluence-edit`. That skill preserves macros/images by working in storage format.
- v2 requires `space_id` (numeric) for page creation — not the space key. Skills that take a space key must translate via `getConfluenceSpaces` first.
- Cursor pagination: if you call `confluence_search` with `start` it still works (v1 endpoint). Tools that use v2 (`confluence_get_page_children`, `getConfluenceSpaces`, etc.) return a `nextCursor` field — pass it back as `cursor` to get the next page.
- This skill is the right tool for: brand-new pages, full reformats, restoring from backup, importing markdown docs.
