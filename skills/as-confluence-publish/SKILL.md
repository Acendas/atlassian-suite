---
name: as-confluence-publish
description: Publish markdown docs to Confluence without losing comments.
argument-hint: "<markdown-file-or-dir> <page-id-or-title> [--dry-run]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__confluence_publish_preflight, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_publish_page, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_markdown_to_storage, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_render_mermaid, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_sync_attachments, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_get_page, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_get_page_by_title, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_get_inline_comments, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_restore_version, mcp__plugin_atlassian-suite_acendas-atlassian__confluence_search, Read, Glob, Bash
---

# Publish docs to Confluence

Sync markdown from a repo into existing Confluence pages without destroying what the pages have accumulated since they were last published — inline comment threads, attached diagrams, macro banners, cross-page links.

## Why this skill exists

`confluence_update_page` replaces the whole body. On a page nobody has touched, that's fine. On a page a reviewer has commented on, it silently orphans every comment: Confluence binds inline comments to `<ac:inline-comment-marker>` elements **in the body**, so a republish without those elements leaves the threads `dangling` and invisible. Diagrams referenced by `<ac:image>` disappear the same way.

The publish tools carry markers across the rewrite, refuse to write when they can't, and verify against Confluence's own answer afterwards.

**Never** route a docs sync through `confluence_update_page` or `body_markdown`. `body_markdown` renders via ADF, which is a different document model — it drops macro bodies and breaks image references even when nothing else goes wrong.

## Inputs

`$1` = Markdown file, or a directory of them.
`$2` = Target page id or title (per file, if a directory).
`$3` = `--dry-run` to stop after preflight.

## Steps

1. **Resolve targets.** Numeric `$2` → use directly. Title → `confluence_get_page_by_title` / `confluence_search`. For a directory, build the file→page mapping first and **render it as a table in chat** before touching anything — the user confirms the mapping before any write.

2. **Check staleness and scope.** Report how far ahead the repo is (`git log` since the last publish date from `confluence_get_page`). A sync that silently spans dozens of commits is the case where surprises hide.

3. **Build the maps.**
   - `page_map`: relative doc path → Confluence page title, so `[text](./ch-05.md)` becomes a real `<ac:link>` instead of degrading to plain text.
   - `asset_map`: image path → attachment filename.
   - `diagram_prefix`: mermaid diagrams are expected at `<prefix>-<n>.svg`, zero-indexed (e.g. `ch-04-the-catalog-0.svg`).

4. **Diagrams render automatically.** ` ```mermaid ` fences are rendered to SVG and attached under the exact filename the page body references — `confluence_publish_page` does it inline (`render_diagrams` defaults on). No manual step.

   - **Requires a renderer on the machine.** A local mermaid CLI (`mmdc`, from `npm i -g @mermaid-js/mermaid-cli`) is used first; otherwise a Kroki-compatible endpoint named by `MERMAID_RENDER_URL`. The plugin does **not** bundle one — that would mean every install downloads Chromium — and it will **never** send diagram sources to a third-party service you haven't named. Diagram sources are internal architecture.
   - **Check first** with `confluence_render_mermaid` and no `page_id`: a dry run reporting which backend is available and what filenames it would produce. Do this once at the start of a batch, not per page.
   - **Publish refuses** if a document has diagrams and no renderer is reachable, or if a diagram fails to render — shipping a page with broken images is worse than not shipping. Override deliberately with `accept_diagram_failure: true`.
   - **Re-renders are skipped** when a diagram's source is unchanged (hash stored in the attachment's version comment). Chromium startup dominates publish time, so this is the difference between seconds and minutes on a re-sync.
   - **Already have rendered SVGs?** Set `render_diagrams: false` and supply `asset_map` + `confluence_sync_attachments` instead. Both workflows are supported.

5. **Preflight every page** — `confluence_publish_preflight(page_id, markdown, ...)`. Read-only. **Render the result in chat before asking anything**: per-anchor survive/at-risk verdicts with the anchored text and commenter-visible context, attachments about to lose their reference, page links about to break, and `missing_assets`. A summary count is not enough — the user needs the actual anchored phrases to judge whether losing one matters.

6. **Stop at any at-risk anchor.** `at_risk` means a reviewer's comment anchors to text the new markdown no longer contains. Options, in preference order:
   - Adjust the markdown to keep the anchored wording.
   - Ask the commenter to resolve the thread, then re-run.
   - Accept the loss deliberately — `accept_anchor_loss: true`, and only after the user has seen exactly which comments die.

7. **Publish** — `confluence_publish_page`. It re-checks the gate itself and refuses rather than trusting the preflight; that's intentional, since content can change between the two calls.

8. **Read the verification block.** `verification.ok: false` means comments went dangling despite the gate. Report it immediately and offer the rollback it hands you: `confluence_restore_version(page_id, version_number)`. Don't proceed to the next page with an unexplained regression behind you.

9. **Batch discipline.** Across many pages, publish one, verify, then continue. Stop the run on the first failed verification. Report a running tally.

## Notes

- Set `version_message` to the source commit sha — it puts an audit trail in the page history tying each version to what produced it.
- `unresolved_links` means a relative link had no `page_map` entry; the label survives as plain text rather than becoming a link to nowhere. On a multi-page sync, publishing every page once and then re-running fixes forward references.
- Raw HTML in markdown is escaped, not passed through, so it shows as literal text. That's deliberate: raw HTML in storage XML is the fastest way to get a body Confluence rejects outright.
- These tools edit one page's body. For surgical edits to a single section, `/atlassian-suite:as-confluence-edit` is the lighter tool.
- **Quiet by default** between gates: one-line progress per page, no running commentary. Render in full at the preflight gate and at any failure.
