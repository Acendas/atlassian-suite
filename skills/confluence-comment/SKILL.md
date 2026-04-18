---
name: Comment on a Confluence Page
description: This skill should be used when the user asks to "comment on confluence page", "reply to confluence comment", "leave feedback on confluence", or runs `/atlassian-suite:confluence-comment`. Adds a footer comment or threaded reply to a Confluence page (Markdown body, converted to ADF).
argument-hint: "<page-id-or-title> [parent-comment-id]"
allowed-tools: mcp__acendas-atlassian__confluence_add_comment, mcp__acendas-atlassian__confluence_reply_to_comment, mcp__acendas-atlassian__confluence_get_comments, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_search
---

# Comment on a Confluence Page

## Inputs

`$1` = Page id or title (resolved via `confluence_search` if title).
`$2` = Optional parent comment id — if set, posts as a reply.

## Steps

1. Resolve page id (numeric → use directly; title → search).
2. Ask the user for the comment body (Markdown supported — converted to ADF automatically).
3. Show preview, confirm.
4. If `$2` provided → `confluence_reply_to_comment`. Else → `confluence_add_comment`.
5. Print the new comment id and a link.

## Notes

- Body is Markdown by default. To pass raw storage/wiki format, set `representation` accordingly.
- Always confirm before posting.
