---
name: Watch / Unwatch Confluence Page or Space
description: This skill should be used when the user asks to "watch this confluence page", "subscribe to confluence updates", "stop watching", "unwatch space", "follow this runbook", or runs `/atlassian-suite:confluence-watch`. Subscribes or unsubscribes the authenticated user from page/space change notifications. v1-backed — v2 has no watchers endpoint.
argument-hint: "<page-id-or-space-key> [action: watch|unwatch] [scope: page|space]"
allowed-tools: mcp__acendas-atlassian__confluence_watch_page, mcp__acendas-atlassian__confluence_unwatch_page, mcp__acendas-atlassian__confluence_watch_space, mcp__acendas-atlassian__confluence_unwatch_space, mcp__acendas-atlassian__confluence_get_page, mcp__acendas-atlassian__confluence_get_page_by_title
---

# Watch / Unwatch a Confluence Page or Space

Subscribe to notifications when the watched resource changes. Page-watching fires on each edit; space-watching fires on any page event in the space.

## Inputs

`$1` = Page id OR space key (auto-detected: numeric → page; otherwise → space key).
`$2` = Action: `watch` (default) or `unwatch`.
`$3` = Scope override: `page` or `space` (useful when a numeric id could also be a space id — rare).

## Steps

1. **Auto-detect scope** unless `$3` overrides:
   - Numeric `$1` → page.
   - Short uppercase string `$1` → space key.
   - Ambiguous → ask.

2. **Confirm** what's being watched/unwatched so the user sees the title (call `confluence_get_page($1)` for pages).

3. **Dispatch:**
   - Page + watch → `confluence_watch_page(page_id)`.
   - Page + unwatch → `confluence_unwatch_page(page_id)`.
   - Space + watch → `confluence_watch_space(space_key)`.
   - Space + unwatch → `confluence_unwatch_space(space_key)`.

4. Print confirmation.

## Notes

- Notifications follow the user's Confluence notification settings — the watch subscribes; whether they get emails or in-app pings is per-user preference.
- Watching is idempotent. Watching twice does nothing; unwatching something you don't watch returns silently.
- Requires classic `write:confluence-content` scope.
