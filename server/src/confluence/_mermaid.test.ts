// Unit tests for _mermaid.ts — mermaid -> SVG rendering.
//
// Two halves:
//   * Pure logic (hashing, SVG extraction, backend selection) always runs.
//   * A live render through the local CLI runs ONLY when one is installed,
//     and is skipped-not-failed otherwise. CI machines without mermaid
//     shouldn't fail the suite for a dependency this plugin deliberately does
//     not bundle — but on a dev box that has it, the real render is the only
//     assertion that proves the flags and stdin/stdout wiring actually work.
//
// The privacy assertion here is load-bearing: no third-party endpoint may be
// contacted unless the operator explicitly named one. Diagram sources are
// internal architecture.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  diagramHash,
  extractSvg,
  detectBackend,
  detectCli,
  renderMermaidToSvg,
  MermaidRenderError,
  NO_BACKEND_HINT,
} from "./_mermaid.js";

const __filename = fileURLToPath(import.meta.url);

interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}
const tests: TestCase[] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push({ name, fn });

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const assertEq = (a: unknown, b: unknown, msg?: string) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg ? msg + ": " : ""}expected ${sb}, got ${sa}`);
};

const FLOW = "graph TD;\n  A[Catalog]-->B[Pricing];\n";

// ─── hashing ───

test("diagramHash is stable for identical source", () => {
  assertEq(diagramHash(FLOW), diagramHash(FLOW));
});

test("diagramHash ignores surrounding whitespace", () => {
  assertEq(diagramHash(FLOW), diagramHash(`\n\n${FLOW}\n  `));
});

test("diagramHash changes when the source changes", () => {
  assert(diagramHash(FLOW) !== diagramHash("graph TD;\n  A-->C;\n"), "different source, different hash");
});

test("diagramHash changes when a pixel-affecting option changes", () => {
  // Otherwise switching theme would leave every diagram stale on the page,
  // because the skip-if-unchanged check would still match.
  assert(
    diagramHash(FLOW, { theme: "dark" }) !== diagramHash(FLOW, { theme: "forest" }),
    "theme must participate in the hash",
  );
  assert(
    diagramHash(FLOW, { backgroundColor: "white" }) !== diagramHash(FLOW, { backgroundColor: "transparent" }),
    "background must participate in the hash",
  );
  assert(diagramHash(FLOW, { scale: 1 }) !== diagramHash(FLOW, { scale: 2 }), "scale must participate");
});

// ─── SVG extraction ───

test("extractSvg strips CLI chatter around the document", () => {
  const out = extractSvg("Generating single mermaid chart\n<svg id='x'>body</svg>\n\n");
  assertEq(out, "<svg id='x'>body</svg>");
});

test("extractSvg keeps a clean document unchanged", () => {
  assertEq(extractSvg("<svg>a</svg>"), "<svg>a</svg>");
});

test("extractSvg handles a nested closing tag by taking the last one", () => {
  const nested = "<svg><g><svg>inner</svg></g></svg>";
  assertEq(extractSvg(`noise${nested}noise`), nested);
});

// ─── backend selection / privacy ───

test("no renderer and no configured URL means no backend, never a public fallback", async () => {
  const saved = { url: process.env.MERMAID_RENDER_URL, cli: process.env.MERMAID_CLI_PATH };
  delete process.env.MERMAID_RENDER_URL;
  process.env.MERMAID_CLI_PATH = "/nonexistent/definitely-not-mmdc";
  try {
    const backend = await detectBackend();
    assertEq(backend, null, "must not invent a remote backend");
  } finally {
    if (saved.url) process.env.MERMAID_RENDER_URL = saved.url;
    if (saved.cli) process.env.MERMAID_CLI_PATH = saved.cli;
    else delete process.env.MERMAID_CLI_PATH;
  }
});

test("rendering without any backend throws with actionable guidance", async () => {
  const saved = { url: process.env.MERMAID_RENDER_URL, cli: process.env.MERMAID_CLI_PATH };
  delete process.env.MERMAID_RENDER_URL;
  process.env.MERMAID_CLI_PATH = "/nonexistent/definitely-not-mmdc";
  try {
    let caught: unknown;
    try {
      await renderMermaidToSvg(FLOW);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof MermaidRenderError, "should raise MermaidRenderError");
    assert(
      String((caught as MermaidRenderError).hint).includes("mermaid-cli"),
      "hint should say how to install a renderer",
    );
  } finally {
    if (saved.url) process.env.MERMAID_RENDER_URL = saved.url;
    if (saved.cli) process.env.MERMAID_CLI_PATH = saved.cli;
    else delete process.env.MERMAID_CLI_PATH;
  }
});

test("an explicitly configured endpoint IS used when no CLI exists", async () => {
  const saved = { url: process.env.MERMAID_RENDER_URL, cli: process.env.MERMAID_CLI_PATH };
  const origFetch = globalThis.fetch;
  let hit = "";
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    hit = String(url);
    return new Response("<svg>remote</svg>", { status: 200 });
  };
  process.env.MERMAID_CLI_PATH = "/nonexistent/definitely-not-mmdc";
  process.env.MERMAID_RENDER_URL = "https://kroki.internal.example";
  try {
    const { svg, backend } = await renderMermaidToSvg(FLOW);
    assertEq(backend.kind, "http");
    assertEq(svg, "<svg>remote</svg>");
    assertEq(hit, "https://kroki.internal.example/mermaid/svg", "Kroki-shaped path");
  } finally {
    (globalThis as { fetch: unknown }).fetch = origFetch;
    if (saved.url) process.env.MERMAID_RENDER_URL = saved.url;
    else delete process.env.MERMAID_RENDER_URL;
    if (saved.cli) process.env.MERMAID_CLI_PATH = saved.cli;
    else delete process.env.MERMAID_CLI_PATH;
  }
});

test("a local CLI wins over a configured endpoint", async () => {
  const cli = await detectCli();
  if (!cli) return; // skipped without a CLI
  const saved = process.env.MERMAID_RENDER_URL;
  process.env.MERMAID_RENDER_URL = "https://should.not.be.used.example";
  try {
    const backend = await detectBackend();
    assertEq(backend?.kind, "cli", "local rendering must be preferred over remote");
  } finally {
    if (saved) process.env.MERMAID_RENDER_URL = saved;
    else delete process.env.MERMAID_RENDER_URL;
  }
});

test("empty source is rejected before any backend work", async () => {
  let caught: unknown;
  try {
    await renderMermaidToSvg("   ");
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof MermaidRenderError, "empty source should raise");
});

test("the no-backend hint names all three escape routes", () => {
  for (const needle of ["mermaid-cli", "MERMAID_CLI_PATH", "MERMAID_RENDER_URL", "sync_attachments"]) {
    assert(NO_BACKEND_HINT.includes(needle), `hint should mention ${needle}`);
  }
});

// ─── live render (skipped when no CLI is installed) ───

test("LIVE: a flowchart renders to real SVG through the local CLI", async () => {
  const cli = await detectCli();
  if (!cli) {
    console.log("    (skipped — no local mermaid CLI)");
    return;
  }
  const { svg, backend } = await renderMermaidToSvg(FLOW, { backgroundColor: "transparent" });
  assertEq(backend.kind, "cli");
  assert(svg.startsWith("<svg"), "output should be a bare SVG document");
  assert(svg.trimEnd().endsWith("</svg>"), "…and end at the closing tag");
  assert(svg.includes("Catalog"), "node labels should survive into the SVG");
  assert(svg.includes("Pricing"), "both nodes present");
});

test("LIVE: invalid mermaid source fails loudly instead of emitting junk", async () => {
  const cli = await detectCli();
  if (!cli) {
    console.log("    (skipped — no local mermaid CLI)");
    return;
  }
  let caught: unknown;
  try {
    await renderMermaidToSvg("graph TD;\n  A[[[[unclosed\n", { timeoutMs: 45_000 });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof MermaidRenderError, "a broken diagram must raise, not return partial SVG");
});

// ─── runner ───

export async function run(): Promise<{ passed: number; failed: number; failures: string[] }> {
  let passed = 0;
  const failures: string[] = [];
  for (const t of tests) {
    try {
      await t.fn();
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
  const { passed, failed, failures } = await run();
  console.log(`${passed} passed, ${failed} failed`);
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(failed === 0 ? 0 : 1);
}
