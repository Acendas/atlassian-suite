---
name: Confluence Page Attachments
description: This skill should be used when the user asks to "list confluence attachments", "show attachments on page", "upload attachment to confluence", "delete confluence attachment", or runs `/atlassian-suite:confluence-attachment`. Lists, uploads, reads, or deletes attachments on a Confluence page. Upload uses v1 (no v2 upload endpoint); list/delete use v2.
argument-hint: "<page-id-or-title> [action: list|get|upload|delete] [attachment-id-or-file-path]"
allowed-tools: mcp__acendas-atlassian__confluence_get_attachments, mcp__acendas-atlassian__confluence_get_attachment, mcp__acendas-atlassian__confluence_upload_attachment, mcp__acendas-atlassian__confluence_delete_attachment, mcp__acendas-atlassian__confluence_search, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_render_image_macro
---

# Confluence Page Attachments

## Inputs

`$1` = Page id or title.
`$2` = Action: `list` (default), `get`, `upload`, or `delete`.
`$3` = For `get` / `delete` → attachment id. For `upload` → absolute local file path.

## Steps

1. **Resolve page id.** Numeric → use directly; title → `confluence_get_page_by_title(space_id, title)` or `confluence_search`.

2. **list** → `confluence_get_attachments(page_id)` (cursor-paginated). Render each as `{id} {title} {mediaType} {fileSize} {downloadLink}`. If `nextCursor` is not null, say "+N more — re-run with cursor to continue".

3. **get** → `confluence_get_attachment(attachment_id)` for a single attachment's metadata including `downloadLink`.

4. **upload** → `confluence_upload_attachment(page_id, file_path, [filename, content_type, comment])`. Content type is guessed from the extension if not provided. Returns the attachment id.
   - To embed the uploaded file as an image inline: call `confluence_render_image_macro(filename)` and splice the resulting storage XML into the page via `/atlassian-suite:confluence-edit`.

5. **delete** → always confirm with the user first, then `confluence_delete_attachment(attachment_id)`. Defaults to trash (recoverable). Pass `purge: true` to permanently delete from trash.

## Notes

- **Upload requires the `write:confluence-file` OR `write:confluence-content` classic scope** — v2 has no upload endpoint. The wizard lists `write:confluence-file` as optional.
- Delete requires the granular `delete:attachment:confluence` scope.
- Always confirm destructive actions (delete, purge) with the user before firing the call.
