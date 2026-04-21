// Unit tests for _storage.ts — the regex-on-XML helpers that power
// surgical edits.
//
// Runner: this file is executed by a simple Node test driver (no framework
// dep added) that imports and runs `run()` at bottom. Keeps the CI path
// dep-light. If we ever add vitest/jest later, the assertions here are
// trivial to port.
//
// Fixtures in tests/fixtures/ are real Confluence responses — v1 captured
// from the ventek.atlassian.net tenant. A v2 fixture will be added once
// the scope list ships granular scopes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  findHeadings,
  locateSection,
  insertAfterHeading,
  replaceSection,
  removeSection,
  appendContent,
  prependContent,
  replaceText,
  renderImageMacro,
  escapeAttr,
  HeadingNotFoundError,
} from "./_storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, "../../tests/fixtures");

interface TestCase {
  name: string;
  fn: () => void;
}

const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

const assertEq = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    throw new Error(
      `${msg ? msg + ": " : ""}expected ${sb}, got ${sa}`,
    );
  }
};

const assertTrue = (v: unknown, msg: string) => {
  if (!v) throw new Error(`expected truthy: ${msg}`);
};

// Typed loosely — ctor args can vary per Error subclass; instanceof is what matters.
const assertThrows = (fn: () => unknown, ctor: Function) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ctor) return;
    throw new Error(`expected ${ctor.name}, got ${(err as Error).constructor.name}`);
  }
  throw new Error(`expected ${ctor.name} to be thrown, nothing thrown`);
};

// ---------------------------------------------------------------------------
// findHeadings

test("findHeadings: plain h1-h3", () => {
  const xml = "<h1>One</h1><p>a</p><h2>Two</h2><h3>Three</h3>";
  const got = findHeadings(xml);
  assertEq(got.length, 3);
  assertEq(got[0].level, 1);
  assertEq(got[0].text, "One");
  assertEq(got[1].text, "Two");
  assertEq(got[2].level, 3);
});

test("findHeadings: tolerates attributes in open tag", () => {
  const xml = `<h2 id="foo" class="bar">Heading</h2>`;
  const got = findHeadings(xml);
  assertEq(got.length, 1);
  assertEq(got[0].text, "Heading");
  assertEq(got[0].level, 2);
});

test("findHeadings: strips inline tags, decodes common entities", () => {
  const xml = `<h2>A &amp; B <strong>bold</strong> &nbsp; end</h2>`;
  const got = findHeadings(xml);
  assertEq(got.length, 1);
  assertEq(got[0].text, "A & B bold   end");
});

test("findHeadings: case-insensitive tag matching", () => {
  const xml = `<H2>Up</H2><h3>Down</h3>`;
  const got = findHeadings(xml);
  assertEq(got.length, 2);
  assertEq(got[0].level, 2);
  assertEq(got[1].level, 3);
});

test("findHeadings: ignores headings that look mismatched", () => {
  const xml = `<h1>Start</h2><h2>Real</h2>`;
  const got = findHeadings(xml);
  // The broken one (<h1>...</h2>) is NOT matched because we require
  // close tag to match open tag level.
  assertEq(got.length, 1);
  assertEq(got[0].text, "Real");
});

// ---------------------------------------------------------------------------
// locateSection

test("locateSection: matches exact substring, returns bounds", () => {
  const xml = `<h2>Intro</h2><p>Overview.</p><h2>Details</h2><p>More.</p>`;
  const loc = locateSection(xml, 2, "intro");
  assertTrue(loc !== null, "should find intro");
  assertEq(loc!.sectionEnd < xml.length, true, "section should end before EOF");
});

test("locateSection: nested subsection stays inside parent section", () => {
  const xml = `<h1>A</h1><p>a1</p><h2>A.1</h2><p>a1-1</p><h1>B</h1><p>b1</p>`;
  const loc = locateSection(xml, 1, "A");
  // Section A includes h2 A.1 because A.1 is DEEPER than A.
  // It ends at h1 B which is same level.
  assertTrue(loc !== null, "should find A");
  const section = xml.slice(loc!.headingStart, loc!.sectionEnd);
  assertTrue(section.includes("A.1"), "A section should include A.1");
  assertTrue(!section.includes("b1"), "A section should NOT include B's content");
});

test("locateSection: no match → null", () => {
  const xml = `<h2>Intro</h2>`;
  assertEq(locateSection(xml, 2, "nope"), null);
});

test("locateSection: wrong level → null (even if text matches)", () => {
  const xml = `<h2>Target</h2>`;
  assertEq(locateSection(xml, 3, "Target"), null);
});

test("locateSection: last heading with no boundary spans to EOF", () => {
  const xml = `<h1>Only</h1><p>body</p>`;
  const loc = locateSection(xml, 1, "only");
  assertEq(loc!.sectionEnd, xml.length);
});

// ---------------------------------------------------------------------------
// Section mutations

test("insertAfterHeading: inserts immediately after heading close tag", () => {
  const xml = `<h2>X</h2><p>old</p>`;
  const out = insertAfterHeading(xml, 2, "x", "<p>NEW</p>");
  assertEq(out, `<h2>X</h2><p>NEW</p><p>old</p>`);
});

test("insertAfterHeading: throws on missing heading", () => {
  assertThrows(() => insertAfterHeading("<p>nothing</p>", 2, "x", "<p>!</p>"), HeadingNotFoundError);
});

test("replaceSection: replaces body, keeps heading", () => {
  const xml = `<h2>Sec</h2><p>old body</p><h2>Next</h2><p>kept</p>`;
  const out = replaceSection(xml, 2, "sec", "<p>new body</p>");
  assertEq(out, `<h2>Sec</h2><p>new body</p><h2>Next</h2><p>kept</p>`);
});

test("removeSection: removes heading + body, keeps siblings", () => {
  const xml = `<h2>Keep</h2><p>a</p><h2>Drop</h2><p>b</p><h2>AlsoKeep</h2><p>c</p>`;
  const out = removeSection(xml, 2, "drop");
  assertEq(out, `<h2>Keep</h2><p>a</p><h2>AlsoKeep</h2><p>c</p>`);
});

test("append/prepend: trivial composition", () => {
  assertEq(appendContent("<p>a</p>", "<p>b</p>"), "<p>a</p><p>b</p>");
  assertEq(prependContent("<p>b</p>", "<p>a</p>"), "<p>a</p><p>b</p>");
});

// ---------------------------------------------------------------------------
// replaceText

test("replaceText: basic global replace with count", () => {
  const { next, count } = replaceText("<p>foo foo foo</p>", "foo", "g", "bar");
  assertEq(next, "<p>bar bar bar</p>");
  assertEq(count, 3);
});

test("replaceText: honors maxReplacements limit", () => {
  const { next, count } = replaceText("<p>foo foo foo</p>", "foo", "g", "bar", 2);
  assertEq(next, "<p>bar bar foo</p>");
  assertEq(count, 2);
});

test("replaceText: zero matches → count 0, body unchanged", () => {
  const { next, count } = replaceText("<p>foo</p>", "zzz", "g", "bar");
  assertEq(next, "<p>foo</p>");
  assertEq(count, 0);
});

// ---------------------------------------------------------------------------
// renderImageMacro + escapeAttr

test("renderImageMacro: plain", () => {
  assertEq(
    renderImageMacro({ filename: "diagram.png" }),
    `<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>`,
  );
});

test("renderImageMacro: with attributes", () => {
  const out = renderImageMacro({
    filename: "d.png",
    width: 200,
    height: 100,
    align: "center",
    alt: 'has "quotes" & amp',
  });
  assertTrue(out.startsWith(`<ac:image ac:width="200" ac:height="100" ac:align="center"`), "prefix");
  assertTrue(out.includes(`ac:alt="has &quot;quotes&quot; &amp; amp"`), "escaped alt");
  assertTrue(out.endsWith(`<ri:attachment ri:filename="d.png" /></ac:image>`), "suffix");
});

test("escapeAttr: all entity classes", () => {
  assertEq(escapeAttr(`a"b&c<d>e`), `a&quot;b&amp;c&lt;d&gt;e`);
});

// ---------------------------------------------------------------------------
// Real-fixture regression tests — v1

test("v1 fixture: findHeadings on real page (no headings → empty)", () => {
  const xml = readFileSync(resolve(fixturesDir, "v1-page-storage-sample.xml"), "utf8");
  // This specific fixture is a page with only paragraphs + macros, no headings.
  // Verifies findHeadings doesn't trip on macro XML (<ac:structured-macro>).
  const got = findHeadings(xml);
  assertEq(got.length, 0);
});

test("v1 fixture: structured-macro preserved through append round-trip", () => {
  const xml = readFileSync(resolve(fixturesDir, "v1-page-storage-sample.xml"), "utf8");
  const out = appendContent(xml, "<p>APPENDED</p>");
  // Round-trip: ac:macro-id attribute presence must survive (it's verbatim)
  assertTrue(out.includes("ac:macro-id=\"f90f29db-e3f8-4e13-9088-2c54b65ba614\""), "macro-id preserved");
  assertTrue(out.endsWith("<p>APPENDED</p>"), "appended at end");
});

test("v1 fixture: replaceText on macro parameter value", () => {
  const xml = readFileSync(resolve(fixturesDir, "v1-page-storage-sample.xml"), "utf8");
  const { next, count } = replaceText(
    xml,
    "https://drive.google.com/file/d/[^<]+",
    "g",
    "https://drive.google.com/file/d/REDACTED",
  );
  assertEq(count, 1);
  assertTrue(next.includes("REDACTED"), "replacement applied");
  assertTrue(next.includes("ac:macro-id="), "macro-id not disturbed");
});

// ---------------------------------------------------------------------------
// Runner

export function run(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
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

// Allow running with `node --import tsx/esm src/confluence/_storage.test.ts`
// or via a standalone test runner script.
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
