// Unit tests for adf.ts — mention rendering and ADF argument coercion.
//
// Same dep-light runner convention as the confluence tests: no framework,
// `run()` at the bottom, prints "N passed, M failed" for eval-run.py to read.
//
// The scenario driving these is a customer report: they tried to tag a
// colleague in a Jira comment and got plain text twice over. Markdown
// `[~accountid:…]` passed through literally, and `body_adf` with a proper
// mention node was rejected with "expected ADF object, got string" because the
// argument arrived at the server serialized. Both paths are covered here.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { markdownToAdf, coerceAdf, assertValidAdf, adfParam } from "./adf.js";

const __filename = fileURLToPath(import.meta.url);

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

const ACCT = "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077";

/** Collect every node of a given type from an ADF tree. */
const collect = (node: unknown, type: string, out: any[] = []): any[] => {
  if (!node || typeof node !== "object") return out;
  const n = node as any;
  if (n.type === type) out.push(n);
  if (Array.isArray(n.content)) for (const c of n.content) collect(c, type, out);
  return out;
};

const firstParagraph = (adf: unknown) => collect(adf, "paragraph")[0];

// ─── markdown mentions ───

test("bare [~accountid:…] becomes a mention node", () => {
  const adf = markdownToAdf(`[~accountid:${ACCT}]`);
  const mentions = collect(adf, "mention");
  assertEq(mentions.length, 1);
  assertEq(mentions[0].attrs.id, ACCT);
  assert(mentions[0].attrs.text === undefined, "no display text was given, so none should be set");
});

test("mention keeps the text on both sides of it", () => {
  const adf = markdownToAdf(`Hey [~accountid:${ACCT}] — this needs a decision.`);
  const para = firstParagraph(adf);
  assertEq(
    para.content.map((c: any) => c.type),
    ["text", "mention", "text"],
  );
  assertEq(para.content[0].text, "Hey ");
  assertEq(para.content[2].text, " — this needs a decision.");
});

test("pipe form supplies fallback display text with an @ prefix", () => {
  const adf = markdownToAdf(`[~accountid:${ACCT}|Eldon Wong] please review`);
  const m = collect(adf, "mention")[0];
  assertEq(m.attrs.id, ACCT);
  assertEq(m.attrs.text, "@Eldon Wong");
});

test("an @ already present in the display text is not doubled", () => {
  const adf = markdownToAdf(`[~accountid:${ACCT}|@Eldon Wong]`);
  assertEq(collect(adf, "mention")[0].attrs.text, "@Eldon Wong");
});

test("two mentions in one paragraph both convert", () => {
  const adf = markdownToAdf(`[~accountid:aaa] and [~accountid:bbb] should sync`);
  const mentions = collect(adf, "mention");
  assertEq(mentions.length, 2);
  assertEq(
    mentions.map((m) => m.attrs.id),
    ["aaa", "bbb"],
  );
});

test("marks on the surrounding text survive the split", () => {
  const adf = markdownToAdf(`**bold [~accountid:${ACCT}] tail**`);
  const para = firstParagraph(adf);
  const texts = para.content.filter((c: any) => c.type === "text");
  assert(texts.length > 0, "expected surviving text nodes");
  for (const t of texts) {
    assert(
      Array.isArray(t.marks) && t.marks.some((m: any) => m.type === "strong"),
      `text run "${t.text}" lost its strong mark`,
    );
  }
  assertEq(collect(adf, "mention").length, 1);
});

test("mentions in a mark are not applied to the mention node itself", () => {
  const adf = markdownToAdf(`**[~accountid:${ACCT}]**`);
  const m = collect(adf, "mention")[0];
  assert(m.marks === undefined, "mention node should not carry text marks");
});

// ─── mentions must stay literal where they are not mentions ───

test("inline code keeps the mention syntax literal", () => {
  const adf = markdownToAdf("use `[~accountid:xyz]` to tag someone");
  assertEq(collect(adf, "mention").length, 0);
  const codeRun = collect(adf, "text").find((t: any) =>
    (t.marks ?? []).some((m: any) => m.type === "code"),
  );
  assert(!!codeRun, "expected an inline code run");
  assert(codeRun.text.includes("[~accountid:xyz]"), "inline code text was rewritten");
});

test("a fenced code block keeps the mention syntax literal", () => {
  const adf = markdownToAdf("```\n[~accountid:xyz]\n```");
  assertEq(collect(adf, "mention").length, 0);
});

test("ordinary text with no mention syntax is untouched", () => {
  const adf = markdownToAdf("Just a normal comment with [a link](http://example.com).");
  assertEq(collect(adf, "mention").length, 0);
});

test("a malformed mention with an empty id stays literal", () => {
  const adf = markdownToAdf("[~accountid:] is not a tag");
  assertEq(collect(adf, "mention").length, 0);
});

// ─── coerceAdf ───

test("coerceAdf parses a JSON-string ADF document", () => {
  const doc = { type: "doc", version: 1, content: [] };
  assertEq(coerceAdf(JSON.stringify(doc)), doc);
});

test("coerceAdf tolerates surrounding whitespace", () => {
  assertEq(coerceAdf('  {"type":"doc","version":1,"content":[]}  '), {
    type: "doc",
    version: 1,
    content: [],
  });
});

test("coerceAdf passes a real object straight through", () => {
  const doc = { type: "doc", version: 1, content: [] };
  assert(coerceAdf(doc) === doc, "object should be returned by identity");
});

test("coerceAdf leaves a non-JSON string alone", () => {
  assertEq(coerceAdf("just prose"), "just prose");
});

test("coerceAdf leaves unparseable JSON-ish text alone", () => {
  assertEq(coerceAdf('{"type":"doc"'), '{"type":"doc"');
});

// ─── assertValidAdf ───

test("assertValidAdf accepts a stringified ADF document (the reported failure)", () => {
  const doc = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "mention", attrs: { id: ACCT, text: "@Eldon Wong" } }],
      },
    ],
  };
  assertEq(assertValidAdf(JSON.stringify(doc), "jira_add_comment.body"), doc);
});

test("assertValidAdf still rejects prose, and says what to do instead", () => {
  let msg = "";
  try {
    assertValidAdf("Eldon Wong — needs a decision", "jira_add_comment.body");
  } catch (err) {
    msg = (err as Error).message;
  }
  assert(msg.includes("expected ADF object"), `unexpected message: ${msg}`);
  assert(msg.includes("[~accountid:"), "error should point at the Markdown mention path");
});

test("assertValidAdf rejects a non-doc root", () => {
  let threw = false;
  try {
    assertValidAdf({ type: "paragraph", version: 1, content: [] }, "ctx");
  } catch {
    threw = true;
  }
  assert(threw, "a paragraph root should be rejected");
});

// ─── adfParam (the tool-boundary schema) ───

test("adfParam accepts an object", () => {
  const doc = { type: "doc", version: 1, content: [] };
  assertEq(adfParam.parse(doc), doc);
});

test("adfParam accepts a JSON string and yields an object", () => {
  const parsed = adfParam.parse('{"type":"doc","version":1,"content":[]}');
  assertEq(parsed, { type: "doc", version: 1, content: [] });
});

test("adfParam preserves unknown ADF node keys", () => {
  const doc = { type: "doc", version: 1, content: [], extra: "keep me" };
  assertEq((adfParam.parse(doc) as any).extra, "keep me");
});

test("adfParam rejects prose", () => {
  assert(!adfParam.safeParse("Eldon Wong — needs a decision").success, "prose should not validate");
});

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
