// Markdown -> Confluence STORAGE format.
//
// Deliberately not the ADF path. `markdownToAdf` (common/adf.ts) exists for
// Jira and for pages that are plain prose, but ADF is a different document
// model: round-tripping a storage page through it drops <ac:structured-macro>
// bodies, rewrites <ac:image> into media nodes that point at nothing, and
// loses <ac:link> cross-references. Any page a human has laid out in
// Confluence — macros, attached diagrams, page links — comes back damaged.
// A publisher that renders documentation into an existing, reviewed page has
// to emit storage XML directly.
//
// markdown-it does the CommonMark parsing; the interesting part is the small
// set of renderer overrides that turn generic HTML constructs into Confluence
// storage equivalents:
//
//   fenced code       -> <ac:structured-macro ac:name="code">  (CDATA body)
//   ```mermaid        -> <ac:image> pointing at a PRE-RENDERED attachment
//   > [!NOTE] ...     -> <ac:structured-macro ac:name="info"> and friends
//   ![alt](file.svg)  -> <ac:image><ri:attachment .../></ac:image>
//   [text](other.md)  -> <ac:link><ri:page ri:content-title="..."/></ac:link>
//
// On mermaid: this module does NOT render diagrams. Shipping a mermaid
// renderer means shipping a headless browser inside an MCP server — large,
// fragile, and a genuine problem on Windows. Repos that publish diagrams
// already render them in their own toolchain. So the contract is: the caller
// renders SVGs and passes an assetMap; this module emits the macro that
// references them and REPORTS any diagram with no mapping, rather than
// silently emitting a broken image reference.
//
// html:false is deliberate. Raw HTML passed through into storage XML is the
// fastest way to produce a body Confluence rejects wholesale (or, worse,
// accepts and mangles). Inline HTML is escaped and shows as literal text —
// visible and obviously wrong, which beats a 400 on a 27-page publish.

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { escapeAttr, renderImageMacro } from "./_storage.js";

export interface RenderOptions {
  /** Markdown asset path (as written in the doc) -> Confluence attachment
   *  filename. Both `./img/x.svg` and `x.svg` forms are accepted as keys. */
  assetMap?: Record<string, string>;
  /** Markdown doc path or link target -> Confluence page title, for
   *  <ac:link> cross-references between published pages. */
  pageMap?: Record<string, string>;
  /** Base name for mermaid diagram attachments. The Nth mermaid fence in the
   *  document is expected at `<diagramPrefix>-<N>.svg`, zero-indexed —
   *  matching the `ch-04-the-catalog-0.svg` convention already in use. */
  diagramPrefix?: string;
}

export interface DiagramRef {
  /** Zero-based index of this mermaid fence within the document. */
  index: number;
  /** Attachment filename this diagram is expected to live at. */
  filename: string;
  /** The mermaid source, so a caller can render it. */
  source: string;
  /** True when `filename` was found in assetMap (or no map was supplied and
   *  the caller is expected to upload by convention). */
  mapped: boolean;
}

export interface RenderResult {
  storage: string;
  diagrams: DiagramRef[];
  /** Image references with no assetMap entry — these would render as broken
   *  attachments. Callers surface these before publishing. */
  missingAssets: string[];
  /** Document-relative links with no pageMap entry — emitted as plain text
   *  rather than a link to nowhere. */
  unresolvedLinks: string[];
}

const CALLOUT_MACROS: Record<string, string> = {
  NOTE: "info",
  TIP: "tip",
  IMPORTANT: "note",
  WARNING: "warning",
  CAUTION: "warning",
};

const CALLOUT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

/** Does this href point outside the document set? */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/** Normalize an asset/link key so `./img/x.svg`, `img/x.svg` and `x.svg` all
 *  resolve against the same map entry. */
function keyCandidates(raw: string): string[] {
  const clean = raw.replace(/^\.\//, "").split("#")[0].split("?")[0];
  const base = clean.split("/").pop() ?? clean;
  return Array.from(new Set([raw, clean, base]));
}

function lookup(map: Record<string, string> | undefined, raw: string): string | undefined {
  if (!map) return undefined;
  for (const k of keyCandidates(raw)) {
    if (map[k] !== undefined) return map[k];
  }
  return undefined;
}

/** Wrap text for a CDATA section, escaping any embedded terminator. */
function cdata(body: string): string {
  return `<![CDATA[${body.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

export function markdownToStorage(markdown: string, opts: RenderOptions = {}): RenderResult {
  const diagrams: DiagramRef[] = [];
  const missingAssets: string[] = [];
  const unresolvedLinks: string[] = [];

  const md = new MarkdownIt({
    html: false,
    xhtmlOut: true, // void elements self-close — storage format is XML, not HTML
    linkify: false,
    typographer: false,
  });

  // ─── callouts: > [!NOTE] ... becomes an info/note/tip/warning macro ───
  //
  // Implemented as a core rule so the blockquote's children still render
  // through the normal pipeline (lists, code and links inside a callout all
  // keep working); only the wrapper changes.
  md.core.ruler.push("confluence_callouts", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      const inline = tokens.slice(i, i + 4).find((t) => t.type === "inline");
      if (!inline) continue;
      const m = CALLOUT_RE.exec(inline.content);
      if (!m) continue;

      const macro = CALLOUT_MACROS[m[1]];
      inline.content = inline.content.replace(CALLOUT_RE, "");
      if (inline.children && inline.children.length > 0) {
        const first = inline.children[0];
        if (first.type === "text") first.content = first.content.replace(CALLOUT_RE, "");
      }
      tokens[i].meta = { ...(tokens[i].meta ?? {}), confluenceMacro: macro };

      // Tag the matching close token at the same nesting depth.
      let depth = 0;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_open") depth++;
        else if (tokens[j].type === "blockquote_close") {
          depth--;
          if (depth === 0) {
            tokens[j].meta = { ...(tokens[j].meta ?? {}), confluenceMacro: macro };
            break;
          }
        }
      }
    }
    return true;
  });

  const macroOf = (t: Token): string | undefined =>
    (t.meta as { confluenceMacro?: string } | undefined)?.confluenceMacro;

  md.renderer.rules.blockquote_open = (tokens, idx) => {
    const macro = macroOf(tokens[idx]);
    return macro
      ? `<ac:structured-macro ac:name="${macro}"><ac:rich-text-body>`
      : "<blockquote>";
  };
  md.renderer.rules.blockquote_close = (tokens, idx) =>
    macroOf(tokens[idx]) ? "</ac:rich-text-body></ac:structured-macro>" : "</blockquote>";

  // ─── fenced code, and mermaid as a special case ───
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || "").trim().split(/\s+/)[0].toLowerCase();

    if (info === "mermaid") {
      const index = diagrams.length;
      const prefix = opts.diagramPrefix ?? "diagram";
      const byMap = lookup(opts.assetMap, `${prefix}-${index}.svg`);
      const filename = byMap ?? `${prefix}-${index}.svg`;
      diagrams.push({ index, filename, source: token.content, mapped: byMap !== undefined });
      return renderImageMacro({ filename, alt: `Diagram ${index + 1}` });
    }

    const lang = info || "text";
    return (
      `<ac:structured-macro ac:name="code">` +
      `<ac:parameter ac:name="language">${escapeAttr(lang)}</ac:parameter>` +
      `<ac:plain-text-body>${cdata(token.content)}</ac:plain-text-body>` +
      `</ac:structured-macro>`
    );
  };

  // Indented code blocks have no language.
  md.renderer.rules.code_block = (tokens, idx) =>
    `<ac:structured-macro ac:name="code">` +
    `<ac:plain-text-body>${cdata(tokens[idx].content)}</ac:plain-text-body>` +
    `</ac:structured-macro>`;

  // ─── images -> attachment macro ───
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    const alt = token.content || undefined;
    if (isExternal(src)) {
      return `<ac:image${alt ? ` ac:alt="${escapeAttr(alt)}"` : ""}>` +
        `<ri:url ri:value="${escapeAttr(src)}" /></ac:image>`;
    }
    const mapped = lookup(opts.assetMap, src);
    if (mapped === undefined) {
      missingAssets.push(src);
      // Emit the reference anyway, by basename — a page that shows a broken
      // image is recoverable by uploading the attachment; silently dropping
      // the image loses the author's intent with nothing to point at.
      const fallback = keyCandidates(src).pop() ?? src;
      return renderImageMacro({ filename: fallback, alt });
    }
    return renderImageMacro({ filename: mapped, alt });
  };

  // ─── links: internal cross-references become <ac:link> ───
  //
  // markdown-it emits link_open / children / link_close. An <ac:link> wraps
  // its label differently from <a>, so the open rule stashes state the close
  // rule reads back.
  const linkStack: Array<{ kind: "page" | "url" | "plain"; title?: string }> = [];

  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const href = tokens[idx].attrGet("href") ?? "";
    if (isExternal(href) || href.startsWith("#")) {
      linkStack.push({ kind: "url" });
      return self.renderToken(tokens, idx, options);
    }
    const title = lookup(opts.pageMap, href);
    if (title === undefined) {
      unresolvedLinks.push(href);
      linkStack.push({ kind: "plain" });
      return "";
    }
    linkStack.push({ kind: "page", title });
    return `<ac:link><ri:page ri:content-title="${escapeAttr(title)}" /><ac:link-body>`;
  };

  md.renderer.rules.link_close = (tokens, idx, options, _env, self) => {
    const frame = linkStack.pop();
    if (!frame || frame.kind === "url") return self.renderToken(tokens, idx, options);
    if (frame.kind === "plain") return "";
    return `</ac:link-body></ac:link>`;
  };

  const storage = md.render(markdown).trim();
  return { storage, diagrams, missingAssets, unresolvedLinks };
}
