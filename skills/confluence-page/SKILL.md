---
name: Read / Edit a Confluence Page
description: This skill should be used when the user asks to "show confluence page X", "read this confluence page", "rewrite confluence page", "create a child page", or runs `/atlassian-suite:confluence-page`. Reads a page or performs a FULL-PAGE rewrite/create. For partial edits (sections, find/replace, append), prefer `/atlassian-suite:confluence-edit`.
argument-hint: "<page-id-or-title-or-url> [action: read|rewrite|create-child] [body-file-or-text]"
allowed-tools: mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_update_page, mcp__acendas-atlassian__confluence_create_page, mcp__acendas-atlassian__confluence_get_comments, mcp__acendas-atlassian__confluence_search
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
   - Numeric → page ID.
   - URL → extract page id from `/pages/{id}/` or use `confluence_search` with title.
   - Title → ask for space if not in context, then `confluence_search` with `space = X AND title = "Y"`. If multiple match, ask the user.

2. **Branch on action:**

   - **`read`** → `confluence_get_page` with `representation=atlas_doc_format`. Render title + first 1500 chars + comment count.
     - If the user asks about images/charts/macros, fetch with `representation=storage` instead so macros are visible.

   - **`rewrite`** → fetch current page first to get version number. **Choose the right body input:**
     - If new content has images, charts, info panels, or other Confluence macros → `body_storage` with raw XHTML
     - If user provided pre-built ADF JSON → `body_adf`
     - If pure prose with headings/lists/links → `body_markdown` (auto-converted; heading levels reconciled)
     - Show diff preview (call `confluence_get_page_diff` after the update if the user wants to inspect)
     - Confirm, then `confluence_update_page` with `version_number = current + 1`.
     - **Warn the user explicitly** if the existing page contains macros and they're rewriting via `body_markdown` — those macros will be stripped.

   - **`create-child`** → ask for title and parent (default = the resolved page). Same body-format choice as rewrite. Call `confluence_create_page` with `parent_id`.

3. **Always confirm writes.** Page version increments on update; surface this in the confirmation prompt.

## Notes

- For ANY change smaller than "rewrite the whole thing", route the user to `/atlassian-suite:confluence-edit`. That skill preserves macros/images by working in storage format.
- This skill is the right tool for: brand-new pages, full reformats, restoring from backup, importing markdown docs.
