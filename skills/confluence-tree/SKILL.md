---
name: Browse Confluence Space Tree
description: This skill should be used when the user asks to "show confluence space structure", "list pages in space", "browse confluence tree", "what's under this confluence page", or runs `/atlassian-suite:confluence-tree`. Renders the page hierarchy of a Confluence space (or sub-tree under a page).
argument-hint: "<space-key-or-page-id> [depth]"
allowed-tools: mcp__acendas-atlassian__confluence_get_space_page_tree, mcp__acendas-atlassian__confluence_get_page_children, mcp__acendas-atlassian__getConfluenceSpaces
---

# Browse a Confluence Space Tree

Render the page hierarchy.

## Inputs

`$1` = Space key (e.g. `ENG`) or a page ID to root the tree at.
`$2` = Optional depth (default 2).

## Steps

1. **Detect input type.**
   - All caps + short → space key.
   - Numeric → page ID.
   - Else: ask `mcp__acendas-atlassian__getConfluenceSpaces` and let user pick.

2. **Fetch tree.**
   - Space root → `confluence_get_space_page_tree` (if available) with depth.
   - Page subtree → `confluence_get_page_children` recursively up to depth, capping at 50 nodes total.

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

4. **Cap output.** If hidden by depth, say `... 12 more pages below depth {n}`. Offer to expand a specific subtree.
