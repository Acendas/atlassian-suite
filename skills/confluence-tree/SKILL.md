---
name: Browse Confluence Space Tree
description: This skill should be used when the user asks to "show confluence space structure", "list pages in space", "browse confluence tree", "what's under this confluence page", or runs `/atlassian-suite:confluence-tree`. Renders the page hierarchy of a Confluence space (or sub-tree under a page). Powered by v2 /descendants — one API call for the whole subtree, not N+1 recursion.
argument-hint: "<space-key-or-page-id> [depth]"
allowed-tools: mcp__acendas-atlassian__confluence_get_space_page_tree, mcp__acendas-atlassian__confluence_get_page_children, mcp__acendas-atlassian__getConfluenceSpaces, mcp__acendas-atlassian__confluence_get_space
---

# Browse a Confluence Space Tree

Render the page hierarchy from a root page down through its descendants.

## Inputs

`$1` = Space key (e.g. `ENG`), space id, or a page id to root the tree at.
`$2` = Optional depth (default 3).

## Steps

1. **Resolve the root page id.**
   - Numeric + already known to be a page id → use directly.
   - Space key (uppercase / short) → call `getConfluenceSpaces` to find `{id, key, homepageId}`. The `homepageId` is your root. If no homepage, ask the user to pick a starting page.
   - Ambiguous → `getConfluenceSpaces` and let the user pick.

2. **Fetch the tree.** Always prefer `confluence_get_space_page_tree(root_page_id, depth)`. It fetches ALL descendants in a single v2 call (cursor-following included) and rebuilds the tree client-side sorted by page `position` — far cheaper than recursion.

   Use `confluence_get_page_children(page_id, cursor)` ONLY when you want just the immediate children and expect to manually drill deeper.

3. **Render** as an indented tree:
   ```
   {Space Name}
   ├─ Onboarding
   │  ├─ Day 1 Setup
   │  └─ Tools and Access
   ├─ Engineering
   │  ├─ Architecture
   │  └─ Runbooks
   └─ Postmortems
   ```

4. **Cap output.** If nodes are hidden by the depth cutoff, say `... N more pages below depth {n}`. Offer to expand a specific subtree — re-run with a deeper `root_page_id` at the node of interest.

## Notes

- `confluence_get_space_page_tree` accepts `root_page_id` (NOT space key) — that's a v2-alignment. Use `getConfluenceSpaces` / `confluence_get_space` to get the `homepageId` for a space.
- Pagination is cursor-based everywhere in v2 — tools return `nextCursor`. The space-tree tool handles cursor-following internally; other list tools surface cursors for you to pass back.
