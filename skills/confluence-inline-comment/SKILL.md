---
name: Inline Comment on a Confluence Page
description: This skill should be used when the user asks to "comment on a specific sentence in confluence", "add inline comment", "highlight a paragraph and leave a note", "flag this line on confluence", "resolve inline comment", or runs `/atlassian-suite:confluence-inline-comment`. Adds, replies to, lists, or resolves INLINE (text-anchored) comments on a Confluence page. Distinct from footer comments — inline is for "this specific sentence is unclear" while footer is "overall feedback".
argument-hint: "<page-id-or-title> <action: list|add|reply|resolve> [selection-text-or-comment-id] [body]"
allowed-tools: mcp__acendas-atlassian__confluence_get_inline_comments, mcp__acendas-atlassian__confluence_add_inline_comment, mcp__acendas-atlassian__confluence_reply_to_inline_comment, mcp__acendas-atlassian__confluence_resolve_inline_comment, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_search
---

# Inline Comments on a Confluence Page

Inline comments anchor to specific text in the page body (the Confluence UI shows them as highlighted text with a sidebar thread). Use them for reviews, annotations, or targeted questions.

For page-level "overall feedback" comments, use `/atlassian-suite:confluence-comment` instead.

## Inputs

`$1` = Page id or title.
`$2` = Action: `list`, `add`, `reply`, or `resolve`.
`$3` = For `add` → the exact text to anchor to. For `reply` / `resolve` → the inline comment id.
`$4` = For `add` / `reply` → the comment body (Markdown).

## Steps

1. **Resolve page id** (numeric direct; title via `confluence_get_page_by_title` or `confluence_search`).

2. **Dispatch:**

   - **`list`** → `confluence_get_inline_comments(page_id, resolution_status?)`. Optionally filter by `resolution_status` (open / resolved / reopened / dangling). Render each comment with its `textSelection` prefix so the user can see what text each one anchors to. Cursor-paginated.

   - **`add`** → Validate the selection text exists in the page body first: call `confluence_get_page(page_id, body_format="storage")` and grep the storage for `$3`. If the text doesn't appear, warn the user BEFORE firing. Then call `confluence_add_inline_comment(page_id, selection_text=$3, selection_match_count=1, body_markdown=$4)`. If the text appears multiple times, ask which occurrence and set `selection_match_count` accordingly (1-based).

   - **`reply`** → `confluence_reply_to_inline_comment(parent_comment_id=$3, body_markdown=$4)`.

   - **`resolve`** → confirm with the user, then `confluence_resolve_inline_comment(comment_id=$3, resolved=true)`. Pass `resolved: false` to reopen a resolved comment.

3. **Confirm writes** — show a preview of the body and the anchor text before posting. For resolves, surface the comment's current body so the user isn't resolving something they'd want to argue with.

## Notes

- Inline comments require `write:comment:confluence` (granular scope). Resolving also uses this scope.
- Malformed `selection_text` that doesn't appear in the page returns 400 `"text selection not found"` — pre-validate with a storage-format read to avoid the round-trip.
- `textSelectionMatchCount` is 1-based. The default is 1 (first occurrence) — the parameter exists for cases where the same phrase appears multiple times.
