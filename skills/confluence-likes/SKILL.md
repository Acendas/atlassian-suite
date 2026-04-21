---
name: List Who Liked a Confluence Page
description: This skill should be used when the user asks to "show who liked the page", "list likers", "who liked this confluence page", or runs `/atlassian-suite:confluence-likes`. Lists users who have liked a Confluence page. READ-ONLY — Atlassian's v2 API exposes no write endpoint for liking/unliking, so this skill cannot add or remove likes.
argument-hint: "<page-id-or-title>"
allowed-tools: mcp__acendas-atlassian__confluence_get_page_likes, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title, mcp__acendas-atlassian__confluence_get_user
---

# List Who Liked a Confluence Page

## Inputs

`$1` = Page id or title.

## Steps

1. Resolve page id. Numeric → use directly; title → `confluence_get_page_by_title(space_id, title)` or `confluence_search`.

2. `confluence_get_page_likes(page_id)` → `{count, likers: [accountId...], nextCursor}`.

3. Optionally resolve accountIds to names via `confluence_get_user(account_id)` for each liker — useful when the user asks "who liked it" rather than just "how many".

4. If `nextCursor` is not null, tell the user "+N more — re-run with cursor to continue".

## Notes

- Requires granular `read:page:confluence`.
- Liking and unliking via the API are **not supported** by Atlassian on scoped tokens — every write endpoint path returns 404. Users who want to like a page need to do it in the Confluence UI.
