---
name: Confluence Page Attachments
description: This skill should be used when the user asks to "list confluence attachments", "show attachments on page", "delete confluence attachment", or runs `/atlassian-suite:confluence-attachment`. Lists or deletes attachments on a Confluence page.
argument-hint: "<page-id-or-title> [action: list|delete] [attachment-id]"
allowed-tools: mcp__acendas-atlassian__confluence_get_attachments, mcp__acendas-atlassian__confluence_delete_attachment, mcp__acendas-atlassian__confluence_search
---

# Confluence Page Attachments

## Inputs

`$1` = Page id or title.
`$2` = Action: `list` (default) or `delete`.
`$3` = Attachment id (required for `delete`).

## Steps

1. Resolve page id.
2. **list** → `confluence_get_attachments` (limit 50). Render: `{id} {title} {mediaType} {size} {creator} {created}`.
3. **delete** → confirm with the user, then `confluence_delete_attachment`.

## Notes

- Upload is not exposed (Bitbucket-style multipart not supported via the current MCP tool surface).
- Always confirm deletes.
