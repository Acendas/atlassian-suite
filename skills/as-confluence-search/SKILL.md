---
name: as-confluence-search
description: Search Confluence via natural-language to CQL.
argument-hint: "<natural-language-query-or-cql> [space-key]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__confluence_search, mcp__plugin_atlassian-suite_acendas-atlassian__getConfluenceSpaces
---

# Confluence Search Helper

Translate intent → CQL, run the search, summarize.

## Inputs

`$1` = Natural-language query or raw CQL.
`$2` = Optional space key to scope the search.

## Steps

1. **Detect mode.** If `$1` contains `space =`, `text ~`, or other CQL operators, treat as CQL.

2. **Translate.** Common patterns:
   - "runbooks for service X" → `text ~ "X" AND label = "runbook"`
   - "recent docs in ENG" → `space = ENG AND created >= now("-14d")`
   - "by @alice" → `creator = "alice"`

3. **Apply space filter** if `$2` provided: `AND space = "{$2}"`.

4. **Run** via `mcp__plugin_atlassian-suite_acendas-atlassian__confluence_search` (limit 25). Render:
   ```
   {space}/{title}  ({lastModified} by {creator})
   {url}
   ```

5. **Offer follow-up:** "Want to read one? Use `/atlassian-suite:as-confluence-page <id-or-title>`."

## Notes

- CQL runs via the v1 `/rest/api/search` endpoint — Confluence Cloud has no v2 CQL equivalent, so this tool stays on v1 and requires the classic `search:confluence` scope.
- If you already know the exact page title and space, skip CQL — call `confluence_get_page_by_title(space_id, title)` directly (one v2 call, cheaper).
