---
name: Confluence Search Helper
description: This skill should be used when the user asks to "search confluence", "find confluence page about X", "help me write CQL", "look up our docs on Y", or runs `/atlassian-suite:confluence-search`. Translates natural-language queries to CQL, runs the search, summarizes results.
argument-hint: "<natural-language-query-or-cql> [space-key]"
allowed-tools: mcp__acendas-atlassian__confluence_search, mcp__acendas-atlassian__getConfluenceSpaces
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

4. **Run** via `mcp__acendas-atlassian__confluence_search` (limit 25). Render:
   ```
   {space}/{title}  ({lastModified} by {creator})
   {url}
   ```

5. **Offer follow-up:** "Want to read one? Use `/atlassian-suite:confluence-page <id-or-title>`."
