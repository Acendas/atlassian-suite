---
name: Comment on a Confluence Page
description: This skill should be used when the user asks to "comment on confluence page", "reply to confluence comment", "leave feedback on confluence", or runs `/atlassian-suite:confluence-comment`. Adds a FOOTER comment (page-level) or threaded reply to a Confluence page. Markdown body is auto-converted to ADF. For text-anchored comments on selections, use `/atlassian-suite:confluence-inline-comment`.
argument-hint: "<page-id-or-title> [parent-comment-id]"
allowed-tools: mcp__acendas-atlassian__confluence_add_comment, mcp__acendas-atlassian__confluence_reply_to_comment, mcp__acendas-atlassian__confluence_get_comments, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_search
---

# Comment on a Confluence Page (footer)

Add a page-level "footer" comment to a Confluence page, or reply into an existing footer thread. Footer comments are the bottom-of-page conversation area — distinct from inline comments, which anchor to specific highlighted text (see `/atlassian-suite:confluence-inline-comment`).

## Inputs

`$1` = Page id or title.
`$2` = Optional parent comment id — if set, posts as a threaded reply.

## Steps

1. **Resolve page id.**
   - Numeric → use directly.
   - Title → prefer `confluence_get_page_by_title(space_id, title)` if you know the space id; else `confluence_search` with CQL.
   - URL → parse the id from `/pages/{id}/`.

2. **Gather the comment body.** Markdown by default — auto-converted to ADF. To post storage XML or wiki markup verbatim, use `body_storage` / `body_wiki` on the tool call instead of `body_markdown`.

3. **Preview & confirm** before posting. For replies, also surface the parent comment's current content (via `confluence_get_comments` + filter by id) so the reply isn't out of context.

4. **Post:**
   - If `$2` set → `confluence_reply_to_comment(parent_comment_id=$2, body_markdown=...)`.
   - Otherwise → `confluence_add_comment(page_id, body_markdown=...)`.

5. Print the returned `CommentProjection` — `id`, `authorId`, `versionNumber` — so the user can quote the id in follow-ups.

## Notes

- Footer vs inline: **footer** is "overall feedback" at the page level; **inline** is "this specific sentence is unclear". Route to the other skill if the user describes a selection of text.
- `confluence_get_comments(page_id)` returns `{ comments: [...], nextCursor }` — cursor-paginated via v2. Iterate until `nextCursor` is null if you need all comments.
