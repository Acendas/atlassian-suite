// Unit tests for _anchors.ts — inline-comment preservation across a rewrite.
//
// Same dep-light runner convention as _storage.test.ts: no test framework,
// `run()` at the bottom, prints "N passed, M failed" for eval-run.py to read.
//
// The scenario driving most of these is the one a customer reported: a 27-page
// book published to Confluence, reviewed in place (Chris left an inline comment
// on the word "Adjustment"), then re-synced from markdown. A wholesale
// republish drops the marker and Chris's thread goes dangling.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  extractAnchors,
  stripAnchors,
  applyAnchors,
  findInText,
  textSpans,
} from "./_anchors.js";

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

const marker = (ref: string, text: string) =>
  `<ac:inline-comment-marker ac:ref="${ref}">${text}</ac:inline-comment-marker>`;

// ─── extraction ───

test("extractAnchors pulls ref and visible text", () => {
  const storage = `<p>The ${marker("abc-123", "Adjustment")} is applied monthly.</p>`;
  const anchors = extractAnchors(storage);
  assertEq(anchors.length, 1);
  assertEq(anchors[0].ref, "abc-123");
  assertEq(anchors[0].text, "Adjustment");
  assertEq(anchors[0].occurrence, 1);
});

test("extractAnchors tolerates a bare ref= attribute", () => {
  const storage = `<p><ac:inline-comment-marker ref="r1">Ledger</ac:inline-comment-marker></p>`;
  const anchors = extractAnchors(storage);
  assertEq(anchors.length, 1);
  assertEq(anchors[0].ref, "r1");
});

test("extractAnchors numbers repeated anchor text by occurrence", () => {
  const storage =
    `<p>${marker("r1", "Catalog")} then later ${marker("r2", "Catalog")}</p>`;
  const anchors = extractAnchors(storage);
  assertEq(anchors.map((a) => a.occurrence), [1, 2]);
  assertEq(anchors.map((a) => a.ref), ["r1", "r2"]);
});

test("extractAnchors captures surrounding context as plain text", () => {
  const storage = `<p>price <strong>after</strong> the ${marker("r1", "Adjustment")} step</p>`;
  const [a] = extractAnchors(storage);
  assert(a.before.includes("the"), `before should carry preceding text, got ${a.before}`);
  assert(a.after.includes("step"), `after should carry following text, got ${a.after}`);
});

test("extractAnchors finds nothing on a clean page", () => {
  assertEq(extractAnchors("<p>No comments here.</p>").length, 0);
});

// ─── stripping ───

test("stripAnchors removes markers but keeps the text", () => {
  const storage = `<p>The ${marker("r1", "Adjustment")} is applied.</p>`;
  assertEq(stripAnchors(storage), "<p>The Adjustment is applied.</p>");
});

test("stripAnchors then extract yields nothing", () => {
  const storage = `<p>${marker("r1", "A")} and ${marker("r2", "B")}</p>`;
  assertEq(extractAnchors(stripAnchors(storage)).length, 0);
});

// ─── text-span safety ───

test("textSpans excludes tags", () => {
  const storage = "<p>hello</p>";
  const spans = textSpans(storage);
  const texts = spans.map((s) => storage.slice(s.start, s.end));
  assertEq(texts, ["hello"]);
});

test("findInText ignores matches inside attribute values", () => {
  // "Adjustment" appears in an attribute AND in real text; only the text hit counts.
  const storage = `<p><ac:image ac:alt="Adjustment"/>The Adjustment applies.</p>`;
  const hits = findInText(storage, "Adjustment");
  assertEq(hits.length, 1);
  assert(
    storage.slice(hits[0].start, hits[0].start + hits[0].rawLength) === "Adjustment",
    "hit should land on the real text occurrence",
  );
  assert(hits[0].start > storage.indexOf("ac:alt"), "hit must be after the attribute");
});

test("findInText ignores matches inside a CDATA code body", () => {
  const storage =
    `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[` +
    `const Adjustment = 1;]]></ac:plain-text-body></ac:structured-macro>` +
    `<p>The Adjustment applies.</p>`;
  const hits = findInText(storage, "Adjustment");
  assertEq(hits.length, 1, "code-block occurrence must not be anchorable");
});

// ─── round-trip preservation ───

test("applyAnchors round-trips an unchanged body", () => {
  const original = `<p>The ${marker("abc-123", "Adjustment")} is applied monthly.</p>`;
  const anchors = extractAnchors(original);
  const rendered = stripAnchors(original);
  const out = applyAnchors(rendered, anchors);
  assertEq(out.unmatched.length, 0);
  assertEq(out.preserved.length, 1);
  assertEq(out.storage, original);
});

test("anchor survives when its paragraph moved and prose around it changed", () => {
  // Chris's comment on "Adjustment"; the author rewrote the chapter around it.
  const anchors = extractAnchors(
    `<h2>Pricing</h2><p>The ${marker("chris-1", "Adjustment")} is applied monthly.</p>`,
  );
  const rerendered =
    `<h2>The Catalog</h2><p>New intro.</p>` +
    `<h2>Pricing</h2><p>Each cycle, the Adjustment runs before invoicing.</p>`;
  const out = applyAnchors(rerendered, anchors);
  assertEq(out.unmatched.length, 0);
  assertEq(out.preserved[0].ref, "chris-1");
  assert(
    out.storage.includes(`<ac:inline-comment-marker ac:ref="chris-1">Adjustment</ac:inline-comment-marker>`),
    "marker should re-wrap the same word in the rewritten prose",
  );
});

test("deleted anchor text is reported, never silently dropped", () => {
  const anchors = extractAnchors(`<p>The ${marker("mart-1", "Reconciliation")} step.</p>`);
  const rerendered = `<p>That section was cut.</p>`;
  const out = applyAnchors(rerendered, anchors);
  assertEq(out.preserved.length, 0);
  assertEq(out.unmatched.length, 1);
  assertEq(out.unmatched[0].ref, "mart-1");
  assertEq(out.storage, rerendered, "body must be left untouched when nothing matched");
});

test("every anchor is accounted for as preserved or unmatched", () => {
  const anchors = extractAnchors(
    `<p>${marker("keep", "Catalog")} and ${marker("lose", "Vanished")}</p>`,
  );
  const out = applyAnchors(`<p>The Catalog remains.</p>`, anchors);
  assertEq(out.preserved.length + out.unmatched.length, anchors.length);
  assertEq(out.preserved[0].ref, "keep");
  assertEq(out.unmatched[0].ref, "lose");
});

// ─── disambiguation ───

test("two anchors on the same repeated phrase do not collapse", () => {
  const original =
    `<p>${marker("r1", "Catalog")} ... </p><p>the ${marker("r2", "Catalog")} again</p>`;
  const anchors = extractAnchors(original);
  const out = applyAnchors(stripAnchors(original), anchors);
  assertEq(out.unmatched.length, 0);
  const refs = extractAnchors(out.storage).map((a) => a.ref);
  assertEq(refs, ["r1", "r2"], "both refs present, in order, on distinct occurrences");
});

test("occurrence 2 lands on the second occurrence, not the third", () => {
  const original = `<p>A x B ${marker("r2", "x")} C x D</p>`;
  const anchors = extractAnchors(original);
  assertEq(anchors[0].occurrence, 1, "only one marker, so it is occurrence 1 of its own text");
  // Rebuild with the marker positioned as the 2nd of three "x" occurrences.
  const forced = [{ ...anchors[0], occurrence: 2 }];
  const out = applyAnchors("<p>A x B x C x D</p>", forced);
  assertEq(out.unmatched.length, 0);
  const at = out.storage.indexOf("<ac:inline-comment-marker");
  const beforeText = out.storage.slice(0, at);
  assertEq((beforeText.match(/x/g) || []).length, 1, "one bare x precedes the marker");
});

test("multiple anchors splice without corrupting each other's offsets", () => {
  const original =
    `<p>${marker("a", "alpha")} ${marker("b", "beta")} ${marker("c", "gamma")}</p>`;
  const anchors = extractAnchors(original);
  const out = applyAnchors(stripAnchors(original), anchors);
  assertEq(out.unmatched.length, 0);
  assertEq(out.storage, original);
});

// ─── entity-bearing anchors (regression: v0.9.0 could not re-match these) ───
//
// Anchor text is compared decoded while the body is encoded. v0.9.0 searched
// decoded text against raw storage, so ANY anchor containing " & < > found
// zero hits and came back unmatched — a live comment thread reported as
// unsaveable. Plain-text anchors were unaffected, which is what made it easy
// to miss: it only showed up on the one anchor in a page that had quotes in it.

test("an anchor containing &quot; entities re-matches", () => {
  // The exact shape a customer hit: quotes around a term inside prose.
  const live =
    `<p>operational kill switches (<ac:inline-comment-marker ac:ref="mart-1">` +
    `&quot;maintenance mode&quot;</ac:inline-comment-marker>) with a UI for ops</p>`;
  const anchors = extractAnchors(live);
  assertEq(anchors[0].text, '"maintenance mode"', "text is stored decoded");

  const rerendered = `<p>operational kill switches (&quot;maintenance mode&quot;) with a UI for ops</p>`;
  const out = applyAnchors(rerendered, anchors);
  assertEq(out.unmatched.length, 0, "entity-bearing anchor must re-match");
  assertEq(out.preserved[0].ref, "mart-1");
});

test("the re-applied marker preserves the original entity encoding", () => {
  const anchors = extractAnchors(
    `<p><ac:inline-comment-marker ac:ref="r1">&quot;maintenance mode&quot;</ac:inline-comment-marker></p>`,
  );
  const out = applyAnchors(`<p>the &quot;maintenance mode&quot; flag</p>`, anchors);
  assert(
    out.storage.includes(
      `<ac:inline-comment-marker ac:ref="r1">&quot;maintenance mode&quot;</ac:inline-comment-marker>`,
    ),
    `entities must not be normalised to raw characters on write-back — got ${out.storage}`,
  );
  assert(!out.storage.includes('">"maintenance'), "must not emit a bare quote into the XML");
});

test("anchors containing & < > all re-match", () => {
  for (const [entity, plain] of [
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&apos;", "'"],
  ] as Array<[string, string]>) {
    const anchors = extractAnchors(
      `<p><ac:inline-comment-marker ac:ref="r1">Tom ${entity} Jerry</ac:inline-comment-marker></p>`,
    );
    assertEq(anchors[0].text, `Tom ${plain} Jerry`, `${entity} should decode`);
    const out = applyAnchors(`<p>see Tom ${entity} Jerry today</p>`, anchors);
    assertEq(out.unmatched.length, 0, `${entity} anchor should re-match`);
  }
});

test("numeric entity forms match their named equivalents", () => {
  // Confluence is not consistent about &quot; vs &#34; across editors.
  const anchors = extractAnchors(
    `<p><ac:inline-comment-marker ac:ref="r1">&#34;mode&#34;</ac:inline-comment-marker></p>`,
  );
  assertEq(anchors[0].text, '"mode"', "numeric entity decodes");
  const out = applyAnchors(`<p>the &quot;mode&quot; flag</p>`, anchors);
  assertEq(out.unmatched.length, 0, "numeric-form anchor matches a named-form body");
});

test("hex entity forms decode too", () => {
  const anchors = extractAnchors(
    `<p><ac:inline-comment-marker ac:ref="r1">&#x22;mode&#x22;</ac:inline-comment-marker></p>`,
  );
  assertEq(anchors[0].text, '"mode"');
});

test("non-breaking spaces fold to plain spaces on both sides", () => {
  const anchors = extractAnchors(
    `<p><ac:inline-comment-marker ac:ref="r1">maintenance&nbsp;mode</ac:inline-comment-marker></p>`,
  );
  assertEq(anchors[0].text, "maintenance mode", "nbsp folds to a plain space");
  const out = applyAnchors(`<p>the maintenance mode flag</p>`, anchors);
  assertEq(out.unmatched.length, 0, "should match prose written with a normal space");
});

test("findInText reports the RAW width of an entity-bearing match", () => {
  const storage = `<p>a &quot;b&quot; c</p>`;
  const hits = findInText(storage, '"b"');
  assertEq(hits.length, 1);
  const slice = storage.slice(hits[0].start, hits[0].start + hits[0].rawLength);
  assertEq(slice, "&quot;b&quot;", "raw length must cover the encoded form, not the decoded one");
});

test("an entity-bearing anchor does not truncate the text around it", () => {
  // A wrong rawLength would eat neighbouring characters or leave a stray tail.
  const anchors = extractAnchors(
    `<p><ac:inline-comment-marker ac:ref="r1">&quot;x&quot;</ac:inline-comment-marker></p>`,
  );
  const out = applyAnchors(`<p>before &quot;x&quot; after</p>`, anchors);
  assertEq(
    out.storage,
    `<p>before <ac:inline-comment-marker ac:ref="r1">&quot;x&quot;</ac:inline-comment-marker> after</p>`,
    "surrounding text must be intact",
  );
});

test("entity anchors round-trip through strip and re-apply", () => {
  const original =
    `<p>ops use <ac:inline-comment-marker ac:ref="r1">&quot;maintenance mode&quot;</ac:inline-comment-marker> ` +
    `and <ac:inline-comment-marker ac:ref="r2">Tom &amp; Jerry</ac:inline-comment-marker></p>`;
  const anchors = extractAnchors(original);
  const out = applyAnchors(stripAnchors(original), anchors);
  assertEq(out.unmatched.length, 0);
  assertEq(out.storage, original, "byte-for-byte round trip");
});

test("a stray ampersand that is not an entity is still matchable", () => {
  // Confluence should always escape this, but a hand-edited body might not.
  const anchors = extractAnchors(
    `<p><ac:inline-comment-marker ac:ref="r1">R&D team</ac:inline-comment-marker></p>`,
  );
  assertEq(anchors[0].text, "R&D team", "a bare & is left alone, not swallowed");
  const out = applyAnchors(`<p>the R&D team ships</p>`, anchors);
  assertEq(out.unmatched.length, 0);
});

// ─── honest failure ───

test("anchor spanning markup is reported unmatched rather than half-applied", () => {
  // The old body had the anchor across an element boundary; the rendered text
  // exists but not as one contiguous text node.
  const anchors = extractAnchors(
    `<p>${marker("r1", "Adjustment")}</p>`,
  );
  const rerendered = `<p><strong>Adjust</strong>ment</p>`;
  const out = applyAnchors(rerendered, anchors);
  assertEq(out.unmatched.length, 1, "must not attempt a split marker");
  assertEq(out.storage, rerendered);
});

test("anchor text that only survives inside a code block is unmatched", () => {
  const anchors = extractAnchors(`<p>${marker("r1", "Adjustment")}</p>`);
  const rerendered =
    `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[Adjustment]]>` +
    `</ac:plain-text-body></ac:structured-macro>`;
  const out = applyAnchors(rerendered, anchors);
  assertEq(out.unmatched.length, 1, "code bodies are not anchorable");
});

test("ref is attribute-escaped on write-back", () => {
  const out = applyAnchors("<p>word</p>", [
    { ref: 'a"b', innerRaw: "word", text: "word", occurrence: 1, before: "", after: "" },
  ]);
  assert(out.storage.includes('ac:ref="a&quot;b"'), "quote in ref must be escaped");
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
