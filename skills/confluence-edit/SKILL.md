---
name: Confluence Granular Edits
description: This skill should be used when the user asks to "edit a section of a confluence page", "append to confluence page", "replace text on confluence", "update one paragraph on confluence", "fix typo on confluence page", "insert section after heading", "remove section from page", or runs `/atlassian-suite:confluence-edit`. Performs SURGICAL edits that preserve all other content (images, macros, charts). Always preferred over full-page rewrites unless replacing the entire page.
argument-hint: "<page-id-or-title> <op: append|prepend|replace-section|insert-after|replace-text|remove-section> [args...]"
allowed-tools: mcp__acendas-atlassian__confluence_append_to_page, mcp__acendas-atlassian__confluence_prepend_to_page, mcp__acendas-atlassian__confluence_replace_section, mcp__acendas-atlassian__confluence_insert_after_heading, mcp__acendas-atlassian__confluence_replace_text, mcp__acendas-atlassian__confluence_remove_section, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_search, mcp__acendas-atlassian__confluence_upload_attachment, mcp__acendas-atlassian__confluence_render_image_macro
---

# Confluence Granular Edits

Surgical Confluence page edits that preserve everything not touched — images, macros, charts, mentions, structured macros all survive.

## Why this skill exists

`confluence_update_page` requires the full body. Round-tripping that body through Markdown silently drops macros, breaks `<ac:image>` references, and mangles charts. This skill uses storage-format mutation tools that work on the live page text and only change what's targeted.

## Inputs

`$1` = Page id or title.
`$2` = Operation: `append` | `prepend` | `replace-section` | `insert-after` | `replace-text` | `remove-section`.
`$3+` = Operation-specific args.

## Steps

1. **Resolve the page id.** Numeric → use directly; title → `confluence_search` with the page title (ask for space if needed). For URLs, parse out the id.

2. **For any op that targets a heading**, peek at the current page (`confluence_get_page` with `representation=storage`, just enough to confirm the heading exists at the level the user thinks). This avoids the "heading not found" error after the user has already typed content.

3. **Compose content.** Confluence storage format is XHTML-ish. Common building blocks:
   - Paragraph: `<p>Text</p>`
   - Heading: `<h2>Section Title</h2>`
   - List: `<ul><li>item</li></ul>` or `<ol>...</ol>`
   - Code block: `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter><ac:plain-text-body><![CDATA[print("hi")]]></ac:plain-text-body></ac:structured-macro>`
   - Info panel: `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>`
   - Image (after uploading attachment): use `confluence_render_image_macro` to get the XML.

4. **Confirm** — show the user the content snippet and the location. For `replace-text`, show the regex and a sample of what it will hit. For `remove-section`, name the section explicitly.

5. **Apply** the targeted op:
   - **append** → `confluence_append_to_page` with `content_storage`.
   - **prepend** → `confluence_prepend_to_page` with `content_storage`.
   - **replace-section** → `confluence_replace_section` with `heading_level`, `heading_text`, `new_content_storage`. The heading line is preserved; only the body under it (until next same-or-higher heading) is replaced.
   - **insert-after** → `confluence_insert_after_heading` with `heading_level`, `heading_text`, `content_storage`.
   - **replace-text** → `confluence_replace_text` with `pattern`, `flags`, `replacement`. Always set `max_replacements` (default 10) as a safety guard. Errors out cleanly if zero matches.
   - **remove-section** → `confluence_remove_section` with `heading_level`, `heading_text`. Heading + body until next same-or-higher heading are deleted.

6. **Embed an image inline** (composite flow):
   - Ask the user for the local file path.
   - `confluence_upload_attachment` with `page_id` + `file_path`.
   - `confluence_render_image_macro` with `filename` (and optional width/align).
   - Use the returned `storage_xml` as the `content_storage` for `confluence_insert_after_heading` or `confluence_append_to_page`.

## Notes

- All ops increment the page version. Multiple edits = multiple versions. For coordinated multi-step edits, batch them into one storage-format payload and use `replace-section` once instead of multiple appends.
- Heading match is case-insensitive substring. If the user says "Update the 'Setup' section" and there's also "Setup notes", the first match wins — confirm the exact heading before applying.
- `replace-text` operates on raw storage XML — careful with regex that crosses tag boundaries. Patterns that assume specific attribute ordering can be brittle across pages (Confluence rewrites attribute order on some edits); prefer `replace-section` when possible.
- Both read and write of storage format go through v2 endpoints (`/api/v2/pages/{id}?body-format=storage` for read, `PUT /pages/{id}` for write). Never mix v1 + v2 for these tools — the storage XML serialization differs subtly between versions and mixed round-trips can corrupt macro-ids.
- For full page rewrite, route to `/atlassian-suite:confluence-page` action `rewrite`.
