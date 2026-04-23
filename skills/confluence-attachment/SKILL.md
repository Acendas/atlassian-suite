---
name: Confluence Page Attachments
description: This skill should be used when the user asks to "list confluence attachments", "show attachments on page", "download attachment from confluence", "save confluence attachment", "upload attachment to confluence", "delete confluence attachment", or runs `/atlassian-suite:confluence-attachment`. Lists, downloads, uploads, reads, or deletes attachments on a Confluence page. Upload uses v1 (no v2 upload endpoint); list/get/download/delete use v2.
argument-hint: "<page-id-or-title> [action: list|get|download|upload|delete] [attachment-id-or-file-path] [save-path]"
allowed-tools: mcp__acendas-atlassian__confluence_get_attachments, mcp__acendas-atlassian__confluence_get_attachment, mcp__acendas-atlassian__confluence_download_attachment, mcp__acendas-atlassian__confluence_upload_attachment, mcp__acendas-atlassian__confluence_delete_attachment, mcp__acendas-atlassian__confluence_search, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_render_image_macro
---

# Confluence Page Attachments

## Inputs

`$1` = Page id or title.
`$2` = Action: `list` (default), `get`, `download`, `upload`, or `delete`.
`$3` = For `get` / `delete` / `download` → attachment id. For `upload` → absolute local file path.
`$4` = For `download` → local path to save to (directory or full file path).

## Steps

1. **Resolve page id.** Numeric → use directly; title → `confluence_get_page_by_title(space_id, title)` or `confluence_search`.

2. **list** → `confluence_get_attachments(page_id)` (cursor-paginated). Render each as `{id} {title} {mediaType} {fileSize} {downloadLink}`. If `nextCursor` is not null, say "+N more — re-run with cursor to continue".

3. **get** → `confluence_get_attachment(attachment_id)` for a single attachment's metadata including `downloadLink` (absolute URL).

4. **download** → `confluence_download_attachment(attachment_id, save_path)`. Streams the file to disk; safe for large files. Ask the user for a `save_path` if not provided. Returns `{path, bytes_written, mediaType}`.

5. **upload** → `confluence_upload_attachment(page_id, file_path, [filename, content_type, comment])`. Content type is guessed from the extension if not provided. Returns the attachment id.
   - To embed the uploaded file as an image inline: call `confluence_render_image_macro(filename)` and splice the resulting storage XML into the page via `/atlassian-suite:confluence-edit`.

6. **delete** → always confirm with the user first, then `confluence_delete_attachment(attachment_id)`. Defaults to trash (recoverable). Pass `purge: true` to permanently delete from trash.

## Notes

- **`downloadLink` is now an absolute URL** — the API previously returned a relative path; the server now absolutizes it. You can fetch it yourself if needed, but `confluence_download_attachment` handles auth, redirects, and streaming automatically.
- **Upload requires the `write:confluence-file` OR `write:confluence-content` classic scope** — v2 has no upload endpoint. The wizard lists `write:confluence-file` as optional.
- Delete requires the granular `delete:attachment:confluence` scope.
- Always confirm destructive actions (delete, purge) with the user before firing the call.
