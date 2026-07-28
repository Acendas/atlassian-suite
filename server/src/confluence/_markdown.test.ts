// Unit tests for _markdown.ts — markdown -> Confluence storage format.
//
// Same dep-light runner as _storage.test.ts / _anchors.test.ts.
//
// These assert on emitted storage XML rather than on a snapshot, because the
// point of this module is that specific Confluence constructs come out the
// other side: code macros with CDATA bodies, <ac:image><ri:attachment>, and
// <ac:link><ri:page> — the three things an ADF round-trip destroys.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { markdownToStorage } from "./_markdown.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TestCase {
  name: string;
  fn: () => void;
}

const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

const assertEq = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg ? msg + ": " : ""}expected ${sb}, got ${sa}`);
};

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const has = (haystack: string, needle: string, msg?: string) =>
  assert(haystack.includes(needle), `${msg ?? "expected substring"}: ${needle}\n--- got ---\n${haystack}`);

// ─── basic block structure ───

test("headings and paragraphs render as plain XHTML", () => {
  const { storage } = markdownToStorage("# Title\n\nSome prose.\n");
  has(storage, "<h1>Title</h1>");
  has(storage, "<p>Some prose.</p>");
});

test("lists render as ul/ol", () => {
  const { storage } = markdownToStorage("- one\n- two\n\n1. first\n2. second\n");
  has(storage, "<ul>");
  has(storage, "<li>one</li>");
  has(storage, "<ol>");
});

test("tables render natively", () => {
  const { storage } = markdownToStorage("| A | B |\n| - | - |\n| 1 | 2 |\n");
  has(storage, "<table>");
  has(storage, "<th>A</th>");
  has(storage, "<td>1</td>");
});

test("void elements self-close so the body stays valid XML", () => {
  const { storage } = markdownToStorage("a\n\n---\n");
  has(storage, "<hr />");
});

// ─── code ───

test("fenced code becomes a code macro with the language parameter", () => {
  const { storage } = markdownToStorage("```python\nprint('hi')\n```\n");
  has(storage, '<ac:structured-macro ac:name="code">');
  has(storage, '<ac:parameter ac:name="language">python</ac:parameter>');
  has(storage, "<![CDATA[print('hi')");
});

test("code content is NOT html-escaped inside CDATA", () => {
  const { storage } = markdownToStorage("```html\n<div class=\"x\">&</div>\n```\n");
  has(storage, '<![CDATA[<div class="x">&</div>', "raw code must survive verbatim");
  assert(!storage.includes("&amp;lt;"), "code must not be double-escaped");
});

test("a CDATA terminator inside code is split safely", () => {
  // The escape is the standard split: `]]>` becomes `]]]]><![CDATA[>`, which
  // closes one section mid-token and opens another. Asserting on the escaped
  // spelling would just restate the implementation, so parse the CDATA
  // sections back out and check the payload survives byte-for-byte.
  const { storage } = markdownToStorage("```\nvar x = ']]>';\n```\n");
  const payload = [...storage.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)]
    .map((m) => m[1])
    .join("");
  assertEq(payload.trim(), "var x = ']]>';", "code must round-trip through the CDATA split");
});

test("language-less fence defaults to text", () => {
  const { storage } = markdownToStorage("```\nplain\n```\n");
  has(storage, '<ac:parameter ac:name="language">text</ac:parameter>');
});

test("indented code blocks become a code macro too", () => {
  const { storage } = markdownToStorage("    indented\n");
  has(storage, '<ac:structured-macro ac:name="code">');
  has(storage, "<![CDATA[indented");
});

// ─── callouts ───

test("> [!NOTE] becomes an info macro", () => {
  const { storage } = markdownToStorage("> [!NOTE]\n> Heads up.\n");
  has(storage, '<ac:structured-macro ac:name="info"><ac:rich-text-body>');
  has(storage, "Heads up.");
  has(storage, "</ac:rich-text-body></ac:structured-macro>");
  assert(!storage.includes("[!NOTE]"), "the marker itself must be stripped");
});

test("callout variants map to the right macros", () => {
  const cases: Array<[string, string]> = [
    ["NOTE", "info"],
    ["TIP", "tip"],
    ["IMPORTANT", "note"],
    ["WARNING", "warning"],
    ["CAUTION", "warning"],
  ];
  for (const [tag, macro] of cases) {
    const { storage } = markdownToStorage(`> [!${tag}]\n> body\n`);
    has(storage, `ac:name="${macro}"`, `${tag} should map to ${macro}`);
  }
});

test("a plain blockquote stays a blockquote", () => {
  const { storage } = markdownToStorage("> just a quote\n");
  has(storage, "<blockquote>");
  assert(!storage.includes("ac:structured-macro"), "no macro for a non-callout quote");
});

test("rich content inside a callout still renders", () => {
  const { storage } = markdownToStorage("> [!WARNING]\n> Use `code` and **bold**.\n");
  has(storage, "<code>code</code>");
  has(storage, "<strong>bold</strong>");
});

// ─── images and attachments ───

test("a mapped image becomes an attachment macro", () => {
  const { storage, missingAssets } = markdownToStorage("![Flow](./img/flow.svg)\n", {
    assetMap: { "img/flow.svg": "ch-04-flow.svg" },
  });
  has(storage, '<ri:attachment ri:filename="ch-04-flow.svg" />');
  has(storage, 'ac:alt="Flow"');
  assertEq(missingAssets, []);
});

test("asset lookup tolerates ./, path and basename forms", () => {
  for (const key of ["./img/flow.svg", "img/flow.svg", "flow.svg"]) {
    const { storage } = markdownToStorage("![](./img/flow.svg)\n", {
      assetMap: { [key]: "mapped.svg" },
    });
    has(storage, 'ri:filename="mapped.svg"', `key form ${key} should resolve`);
  }
});

test("an unmapped image is reported and falls back to its basename", () => {
  const { storage, missingAssets } = markdownToStorage("![x](./img/missing.svg)\n");
  assertEq(missingAssets, ["./img/missing.svg"]);
  has(storage, 'ri:filename="missing.svg"', "emit a recoverable reference, not nothing");
});

test("an external image URL uses ri:url, not an attachment", () => {
  const { storage } = markdownToStorage("![x](https://example.com/a.png)\n");
  has(storage, '<ri:url ri:value="https://example.com/a.png" />');
});

// ─── mermaid ───

test("a mermaid fence emits an attachment reference, not code", () => {
  const { storage, diagrams } = markdownToStorage("```mermaid\ngraph TD;\nA-->B;\n```\n", {
    diagramPrefix: "ch-04-the-catalog",
  });
  has(storage, '<ri:attachment ri:filename="ch-04-the-catalog-0.svg" />');
  assert(!storage.includes("graph TD"), "mermaid source must not render as visible code");
  assertEq(diagrams.length, 1);
  assertEq(diagrams[0].filename, "ch-04-the-catalog-0.svg");
  assertEq(diagrams[0].index, 0);
  assert(diagrams[0].source.includes("graph TD"), "source is reported so callers can render it");
});

test("mermaid diagrams are numbered from zero in document order", () => {
  const md = "```mermaid\nA\n```\n\ntext\n\n```mermaid\nB\n```\n";
  const { diagrams } = markdownToStorage(md, { diagramPrefix: "ch-04-the-catalog" });
  assertEq(
    diagrams.map((d) => d.filename),
    ["ch-04-the-catalog-0.svg", "ch-04-the-catalog-1.svg"],
  );
});

test("a diagram absent from assetMap is flagged as unmapped", () => {
  const { diagrams } = markdownToStorage("```mermaid\nA\n```\n", {
    diagramPrefix: "ch-04",
    assetMap: {},
  });
  assertEq(diagrams[0].mapped, false, "caller must be told the SVG has not been rendered yet");
});

test("a diagram present in assetMap is flagged mapped", () => {
  const { diagrams } = markdownToStorage("```mermaid\nA\n```\n", {
    diagramPrefix: "ch-04",
    assetMap: { "ch-04-0.svg": "ch-04-0.svg" },
  });
  assertEq(diagrams[0].mapped, true);
});

// ─── links ───

test("an internal doc link becomes an ac:link to the mapped page", () => {
  const { storage, unresolvedLinks } = markdownToStorage("See [the catalog](./ch-04.md).\n", {
    pageMap: { "ch-04.md": "Chapter 4 — The Catalog" },
  });
  has(storage, '<ac:link><ri:page ri:content-title="Chapter 4 — The Catalog" />');
  has(storage, "<ac:link-body>the catalog</ac:link-body>");
  assertEq(unresolvedLinks, []);
});

test("an external link stays an anchor", () => {
  const { storage } = markdownToStorage("[site](https://example.com)\n");
  has(storage, '<a href="https://example.com">site</a>');
});

test("an unresolved internal link is reported and degrades to plain text", () => {
  const { storage, unresolvedLinks } = markdownToStorage("See [nowhere](./gone.md).\n");
  assertEq(unresolvedLinks, ["./gone.md"]);
  has(storage, "nowhere", "label text is kept");
  assert(!storage.includes("<ac:link>"), "no link to a page that does not exist");
  assert(!storage.includes("gone.md"), "no dangling href");
});

test("page-title attribute is escaped", () => {
  const { storage } = markdownToStorage("[x](./a.md)\n", {
    pageMap: { "a.md": 'Quote " & Ampersand' },
  });
  has(storage, 'ri:content-title="Quote &quot; &amp; Ampersand"');
});

// ─── safety ───

test("raw HTML is escaped rather than passed through", () => {
  const { storage } = markdownToStorage("<script>alert(1)</script>\n");
  assert(!storage.includes("<script>"), "raw HTML must not reach the storage body");
  has(storage, "&lt;script&gt;");
});

test("ampersands in prose are escaped", () => {
  const { storage } = markdownToStorage("Tom & Jerry\n");
  has(storage, "Tom &amp; Jerry");
});

// ─── the customer's shape, end to end ───

test("a chapter with prose, callout, diagram, code and cross-link renders whole", () => {
  const md = [
    "# The Catalog",
    "",
    "> [!NOTE]",
    "> This chapter is generated.",
    "",
    "The **Adjustment** is applied monthly.",
    "",
    "```mermaid",
    "graph TD; A-->B;",
    "```",
    "",
    "```sql",
    "SELECT 1;",
    "```",
    "",
    "See [pricing](./ch-05.md).",
    "",
  ].join("\n");

  const { storage, diagrams, missingAssets, unresolvedLinks } = markdownToStorage(md, {
    diagramPrefix: "ch-04-the-catalog",
    pageMap: { "ch-05.md": "Chapter 5 — Pricing" },
  });

  has(storage, "<h1>The Catalog</h1>");
  has(storage, 'ac:name="info"');
  has(storage, "<strong>Adjustment</strong>");
  has(storage, 'ri:filename="ch-04-the-catalog-0.svg"');
  has(storage, '<ac:parameter ac:name="language">sql</ac:parameter>');
  has(storage, 'ri:content-title="Chapter 5 — Pricing"');
  assertEq(diagrams.length, 1);
  assertEq(missingAssets, []);
  assertEq(unresolvedLinks, []);
});

test("the anchored word survives rendering as contiguous text", () => {
  // applyAnchors can only re-wrap text that lands in one text node. A bare
  // word in prose must not be split by markup, or Chris's comment on
  // "Adjustment" would come back unmatched.
  const { storage } = markdownToStorage("The Adjustment is applied monthly.\n");
  has(storage, "The Adjustment is applied monthly.");
});

// ─── runner ───

export function run(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  for (const t of tests) {
    try {
      t.fn();
      passed++;
    } catch (err) {
      failures.push(`${t.name} — ${(err as Error).message}`);
    }
  }
  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(__filename);
if (isMain) {
  const { passed, failed, failures } = run();
  console.log(`${passed} passed, ${failed} failed`);
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(failed === 0 ? 0 : 1);
}
