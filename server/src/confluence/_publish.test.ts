// Unit tests for the Confluence PUBLISH surface — pins the safety behaviour
// that makes a docs->Confluence sync attemptable at all.
//
// The customer report this exists for: 27 published pages carrying inline
// comment threads, pre-rendered SVG diagrams, an info-macro banner and
// <ac:link> cross-references, with the markdown thirteen days ahead of them.
// A wholesale republish silently destroys the comments and diagrams, and
// nothing warns first — so nobody could safely run the sync.
//
// These mock `fetch` (same approach as qmetry/_write.test.ts) because the
// interesting assertions are about what goes on the wire and, more
// importantly, about when NOTHING goes on the wire: the refusal paths are the
// feature. A test that only checked the happy path would pass on a build that
// silently orphans every comment.
//
// Runner: `npx tsx src/confluence/_publish.test.ts`.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

process.env.CONFLUENCE_URL = "https://acme.atlassian.net/wiki";
process.env.ATLASSIAN_USERNAME = "test@example.com";
process.env.ATLASSIAN_API_TOKEN = "test-token";

const { registerPublishTools } = await import("./publish.js");

type Call = { method: string; url: string; body: any };
let calls: Call[] = [];

// Mutable page state the fake API serves.
let pageStorage = "";
let pageVersion = 7;
let danglingIds: string[] = [];

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const method = init.method ?? "GET";
  const u = String(url);
  let body: any;
  if (init.body !== undefined && typeof init.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  calls.push({ method, url: u, body });

  if (u.includes("/inline-comments")) {
    return jsonResponse({ results: danglingIds.map((id) => ({ id })) });
  }
  if (u.includes("/attachments")) {
    return jsonResponse({ results: [] });
  }
  if (method === "PUT") {
    pageVersion += 1;
    pageStorage = body?.body?.value ?? pageStorage;
    return jsonResponse({ id: "123", title: "Chapter 4", version: { number: pageVersion } });
  }
  return jsonResponse({
    id: "123",
    title: "Chapter 4",
    version: { number: pageVersion },
    body: { storage: { value: pageStorage } },
  });
};

const tools = new Map<string, (args: any) => Promise<string>>();
const fakeServer: any = {
  addTool: ({ name, execute }: { name: string; execute: (a: any) => Promise<string> }) =>
    tools.set(name, execute),
};
registerPublishTools(fakeServer, { readOnly: false });

const call = async (name: string, args: any) => {
  const fn = tools.get(name);
  if (!fn) throw new Error(`tool not registered: ${name}`);
  return JSON.parse(await fn(args));
};

// A real file to upload. /etc/hostname does not exist on macOS, and the
// content-comparison tests need bytes they can hash on both sides.
const { writeFileSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createHash } = await import("node:crypto");
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "as-publish-test-"));
const FIXTURE_PATH = join(FIXTURE_DIR, "ch-02-0.svg");
const FIXTURE_BYTES = Buffer.from("<svg><g>catalog</g></svg>");
writeFileSync(FIXTURE_PATH, FIXTURE_BYTES);
const FIXTURE_HASH = createHash("sha256").update(FIXTURE_BYTES).digest("hex");

const marker = (ref: string, text: string) =>
  `<ac:inline-comment-marker ac:ref="${ref}">${text}</ac:inline-comment-marker>`;

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}
const tests: TestCase[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

const assert = (cond: any, msg: string) => {
  if (!cond) throw new Error(msg);
};
const eq = (a: unknown, b: unknown, msg: string) => {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`,
  );
};

function reset(storage: string) {
  pageStorage = storage;
  pageVersion = 7;
  danglingIds = [];
  calls = [];
}

const writes = () => calls.filter((c) => c.method === "PUT" || c.method === "POST");

// ─── registration ───

test("all four publish tools register", async () => {
  for (const name of [
    "confluence_markdown_to_storage",
    "confluence_publish_preflight",
    "confluence_publish_page",
    "confluence_sync_attachments",
  ]) {
    assert(tools.has(name), `${name} should be registered`);
  }
});

// ─── pure render ───

test("markdown_to_storage never touches the network", async () => {
  reset("");
  await call("confluence_markdown_to_storage", { markdown: "# Hi\n" });
  eq(calls.length, 0, "pure render must make no API call");
});

test("markdown_to_storage reports diagrams and gaps", async () => {
  reset("");
  const out = await call("confluence_markdown_to_storage", {
    markdown: "```mermaid\nA\n```\n\n![x](./missing.svg)\n\n[y](./gone.md)\n",
    diagram_prefix: "ch-04",
  });
  eq(out.diagrams.length, 1, "one diagram");
  eq(out.diagrams[0].filename, "ch-04-0.svg", "zero-indexed diagram name");
  eq(out.missing_assets, ["./missing.svg"], "unmapped asset reported");
  eq(out.unresolved_links, ["./gone.md"], "unresolved link reported");
});

// ─── preflight is read-only ───

test("preflight writes nothing", async () => {
  reset(`<p>The ${marker("chris-1", "Adjustment")} is applied.</p>`);
  await call("confluence_publish_preflight", {
    page_id: "123",
    markdown: "The Adjustment is applied.\n",
  });
  eq(writes().length, 0, "preflight must not write");
});

test("preflight inventories anchors without markdown", async () => {
  reset(`<p>${marker("chris-1", "Adjustment")} and ${marker("mart-1", "Ledger")}</p>`);
  const out = await call("confluence_publish_preflight", { page_id: "123" });
  eq(out.inline_comment_anchors.length, 2, "both anchors listed");
  eq(out.inline_comment_anchors[0].ref, "chris-1", "ref surfaced");
  assert(out.note.includes("2 inline comment anchor"), "note should quantify the risk");
});

test("preflight marks a surviving anchor safe", async () => {
  reset(`<p>The ${marker("chris-1", "Adjustment")} is applied monthly.</p>`);
  const out = await call("confluence_publish_preflight", {
    page_id: "123",
    markdown: "Each cycle the Adjustment runs first.\n",
  });
  eq(out.safe_to_publish, true, "anchor text still present -> safe");
  eq(out.anchors.will_survive.length, 1, "one survivor");
  eq(out.anchors.at_risk.length, 0, "nothing at risk");
});

test("preflight flags an anchor whose text was deleted", async () => {
  reset(`<p>The ${marker("mart-1", "Reconciliation")} step.</p>`);
  const out = await call("confluence_publish_preflight", {
    page_id: "123",
    markdown: "That section was cut.\n",
  });
  eq(out.safe_to_publish, false, "losing an anchor is not safe");
  eq(out.anchors.at_risk.length, 1, "the doomed anchor is named");
  eq(out.anchors.at_risk[0].ref, "mart-1", "with its ref, so it can be looked up");
});

test("preflight reports attachments that would stop being referenced", async () => {
  reset(
    `<p>text</p><ac:image><ri:attachment ri:filename="ch-04-the-catalog-0.svg" /></ac:image>`,
  );
  const out = await call("confluence_publish_preflight", {
    page_id: "123",
    markdown: "Just prose now.\n",
  });
  eq(
    out.attachments.no_longer_referenced,
    ["ch-04-the-catalog-0.svg"],
    "dropped diagram must be named",
  );
});

test("preflight reports page links that would be dropped", async () => {
  reset(`<p><ac:link><ri:page ri:content-title="Chapter 5" /></ac:link></p>`);
  const out = await call("confluence_publish_preflight", {
    page_id: "123",
    markdown: "No links.\n",
  });
  eq(out.page_links.no_longer_referenced, ["Chapter 5"], "dropped cross-reference named");
});

test("preflight counts the info-macro banner before and after", async () => {
  reset(`<ac:structured-macro ac:name="info"><ac:rich-text-body><p>b</p></ac:rich-text-body></ac:structured-macro>`);
  const out = await call("confluence_publish_preflight", {
    page_id: "123",
    markdown: "plain prose\n",
  });
  eq(out.macros.before.info, 1, "banner counted on the live page");
  eq(out.macros.after.info, undefined, "and shown as absent from the proposed body");
});

// ─── publish refuses before damaging anything ───

test("publish REFUSES when an anchor would be orphaned, and writes nothing", async () => {
  reset(`<p>The ${marker("mart-1", "Reconciliation")} step.</p>`);
  const out = await call("confluence_publish_page", {
    page_id: "123",
    markdown: "That section was cut.\n",
  });
  eq(out.published, false, "must not publish");
  eq(out.refused, "anchor_loss", "with a machine-readable reason");
  eq(out.at_risk[0].ref, "mart-1", "naming the comment at risk");
  eq(writes().length, 0, "and crucially: no PUT reached the API");
});

test("publish proceeds when anchor loss is explicitly accepted", async () => {
  reset(`<p>The ${marker("mart-1", "Reconciliation")} step.</p>`);
  const out = await call("confluence_publish_page", {
    page_id: "123",
    markdown: "That section was cut.\n",
    accept_anchor_loss: true,
  });
  eq(out.published, true, "override allows the write");
  eq(out.anchors_orphaned.length, 1, "but the loss is still reported, not hidden");
  eq(writes().length, 1, "exactly one PUT");
});

test("publish REFUSES on unmapped assets and writes nothing", async () => {
  reset("<p>old</p>");
  const out = await call("confluence_publish_page", {
    page_id: "123",
    markdown: "![diagram](./img/flow.svg)\n",
  });
  eq(out.published, false, "must not publish a page with broken images");
  eq(out.refused, "missing_assets", "machine-readable reason");
  eq(writes().length, 0, "no PUT");
});

test("a clean publish carries the anchor into the new body", async () => {
  reset(`<h2>Pricing</h2><p>The ${marker("chris-1", "Adjustment")} is applied monthly.</p>`);
  const out = await call("confluence_publish_page", {
    page_id: "123",
    markdown: "## Pricing\n\nEach cycle, the Adjustment runs before invoicing.\n",
  });
  eq(out.published, true, "publishes");
  eq(out.anchors_preserved.length, 1, "anchor carried");
  eq(out.anchors_orphaned.length, 0, "nothing lost");
  const put = calls.find((c) => c.method === "PUT");
  assert(
    String(put?.body?.body?.value).includes(
      `<ac:inline-comment-marker ac:ref="chris-1">Adjustment</ac:inline-comment-marker>`,
    ),
    "the marker must actually be in the body that goes on the wire",
  );
});

// ─── wire shape ───

test("publish sends storage representation and bumps the version by one", async () => {
  reset("<p>old</p>");
  await call("confluence_publish_page", { page_id: "123", markdown: "new\n" });
  const put = calls.find((c) => c.method === "PUT");
  eq(put?.body?.body?.representation, "storage", "must write storage, never ADF");
  eq(put?.body?.version?.number, 8, "version = current + 1");
  eq(put?.body?.status, "current", "publishes as current, not draft");
});

test("publish keeps the existing title unless one is given", async () => {
  reset("<p>old</p>");
  await call("confluence_publish_page", { page_id: "123", markdown: "x\n" });
  eq(calls.find((c) => c.method === "PUT")?.body?.title, "Chapter 4", "title preserved");

  reset("<p>old</p>");
  await call("confluence_publish_page", { page_id: "123", markdown: "x\n", title: "Renamed" });
  eq(calls.find((c) => c.method === "PUT")?.body?.title, "Renamed", "explicit title wins");
});

test("version_message rides along when supplied", async () => {
  reset("<p>old</p>");
  await call("confluence_publish_page", {
    page_id: "123",
    markdown: "x\n",
    version_message: "sync from repo @ abc123",
  });
  eq(
    calls.find((c) => c.method === "PUT")?.body?.version?.message,
    "sync from repo @ abc123",
    "audit trail on the version",
  );
});

// ─── post-write verification ───

test("publish reports rollback coordinates pointing at the pre-publish version", async () => {
  reset("<p>old</p>");
  const out = await call("confluence_publish_page", { page_id: "123", markdown: "x\n" });
  eq(out.rollback.tool, "confluence_restore_version", "names the rollback tool");
  eq(out.rollback.version_number, 7, "rolls back to the version before this write");
  eq(out.version_before, 7, "");
  eq(out.version_after, 8, "");
});

test("verification is clean when nothing went dangling", async () => {
  reset("<p>old</p>");
  const out = await call("confluence_publish_page", { page_id: "123", markdown: "x\n" });
  eq(out.verification.ok, true, "clean publish verifies clean");
  eq(out.verification.newly_dangling, [], "");
});

test("a comment that goes dangling during the write is detected after the fact", async () => {
  reset(`<p>The ${marker("chris-1", "Adjustment")} is applied.</p>`);
  const fn = tools.get("confluence_publish_page")!;
  // Anchor text survives, so the pre-write gate passes — but Confluence
  // reports a new dangling comment afterwards. This is the case belief-based
  // checking misses and only the post-write query catches.
  const original = (globalThis as any).fetch;
  let seenPut = false;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const u = String(url);
    if ((init.method ?? "GET") === "PUT") seenPut = true;
    if (u.includes("/inline-comments")) {
      return jsonResponse({ results: seenPut ? [{ id: "cmt-9" }] : [] });
    }
    return original(url, init);
  };
  const out = JSON.parse(
    await fn({ page_id: "123", markdown: "The Adjustment is applied.\n" }),
  );
  (globalThis as any).fetch = original;

  eq(out.published, true, "the write did happen");
  eq(out.verification.ok, false, "and verification caught the damage");
  eq(out.verification.newly_dangling, ["cmt-9"], "naming the orphaned comment");
  assert(
    String(out.verification.message).includes("version_number: 7") ||
      String(out.verification.message).includes("7"),
    "message should point at the rollback version",
  );
});

test("pre-existing dangling comments are not blamed on this publish", async () => {
  reset("<p>old</p>");
  danglingIds = ["already-broken"];
  const out = await call("confluence_publish_page", { page_id: "123", markdown: "x\n" });
  eq(out.verification.ok, true, "a comment that was already dangling is not a new regression");
  eq(out.verification.newly_dangling, [], "delta, not absolute count");
});

// ─── mermaid rendering ───

/** Run `fn` with no mermaid backend reachable, then restore the environment. */
async function withNoRenderer(fn: () => Promise<void>) {
  const saved = { cli: process.env.MERMAID_CLI_PATH, url: process.env.MERMAID_RENDER_URL };
  process.env.MERMAID_CLI_PATH = "/nonexistent/definitely-not-mmdc";
  delete process.env.MERMAID_RENDER_URL;
  try {
    await fn();
  } finally {
    if (saved.cli) process.env.MERMAID_CLI_PATH = saved.cli;
    else delete process.env.MERMAID_CLI_PATH;
    if (saved.url) process.env.MERMAID_RENDER_URL = saved.url;
  }
}

test("render_mermaid dry run reports filenames and writes nothing", async () => {
  reset("<p>old</p>");
  const out = await call("confluence_render_mermaid", {
    markdown: "```mermaid\ngraph TD; A-->B;\n```\n",
    diagram_prefix: "ch-04-the-catalog",
  });
  eq(out.dry_run, true, "no page_id means dry run");
  eq(out.diagrams[0].filename, "ch-04-the-catalog-0.svg", "names match what publish references");
  eq(writes().length, 0, "dry run must not upload");
});

test("publish REFUSES a document with diagrams when no renderer exists", async () => {
  await withNoRenderer(async () => {
    reset("<p>old</p>");
    const out = await call("confluence_publish_page", {
      page_id: "123",
      markdown: "```mermaid\ngraph TD; A-->B;\n```\n",
      diagram_prefix: "ch-04",
    });
    eq(out.published, false, "must not publish a page whose diagrams cannot be produced");
    eq(out.refused, "no_mermaid_renderer", "machine-readable reason");
    assert(String(out.message).includes("mermaid-cli"), "message should say how to fix it");
    eq(writes().length, 0, "and no PUT");
  });
});

test("accept_diagram_failure lets a no-renderer publish through", async () => {
  await withNoRenderer(async () => {
    reset("<p>old</p>");
    const out = await call("confluence_publish_page", {
      page_id: "123",
      markdown: "```mermaid\ngraph TD; A-->B;\n```\n",
      diagram_prefix: "ch-04",
      accept_diagram_failure: true,
    });
    eq(out.published, true, "explicit override publishes");
    eq(writes().length, 1, "one PUT");
  });
});

test("render_diagrams:false publishes without needing a renderer at all", async () => {
  await withNoRenderer(async () => {
    reset("<p>old</p>");
    const out = await call("confluence_publish_page", {
      page_id: "123",
      markdown: "```mermaid\ngraph TD; A-->B;\n```\n",
      diagram_prefix: "ch-04",
      render_diagrams: false,
    });
    eq(out.published, true, "pre-rendered-asset workflow stays available");
    const put = calls.find((c) => c.method === "PUT");
    assert(
      String(put?.body?.body?.value).includes('ri:filename="ch-04-0.svg"'),
      "body still references the diagram attachment",
    );
  });
});

test("a document with no diagrams never consults a renderer", async () => {
  await withNoRenderer(async () => {
    reset("<p>old</p>");
    const out = await call("confluence_publish_page", { page_id: "123", markdown: "just prose\n" });
    eq(out.published, true, "no diagrams means the missing renderer is irrelevant");
  });
});

test("the rendered body references the diagram the renderer will attach", async () => {
  reset("<p>old</p>");
  await call("confluence_publish_page", {
    page_id: "123",
    markdown: "```mermaid\ngraph TD; A-->B;\n```\n",
    diagram_prefix: "ch-04-the-catalog",
    render_diagrams: false,
  });
  const put = calls.find((c) => c.method === "PUT");
  assert(
    String(put?.body?.body?.value).includes(
      '<ac:image ac:alt="Diagram 1"><ri:attachment ri:filename="ch-04-the-catalog-0.svg" /></ac:image>',
    ),
    "storage must point at exactly the filename the render step produces",
  );
});

// ─── attachment upload verb (regression: v0.9.0-0.9.2 used create-only POST) ───
//
// `POST /content/{id}/child/attachment` only ADDS an attachment and returns
// 400 when the filename already exists. Every diagram upload used it, so the
// second publish of any page — and the first publish of any page whose
// diagrams were attached by hand — failed with an unexplained 400. PUT is the
// documented create-or-update verb. Pinning the verb because the failure is
// invisible until a page already has the attachment.

test("attachment uploads use PUT, never create-only POST", async () => {
  reset("<p>old</p>");
  await call("confluence_sync_attachments", {
    page_id: "123",
    files: [{ path: FIXTURE_PATH, filename: "ch-02-0.svg" }],
  });
  const uploads = calls.filter((c) => c.url.includes("/child/attachment") && c.method !== "GET");
  eq(uploads.length, 1, "one upload");
  eq(uploads[0].method, "PUT", "POST is create-only and 400s on an existing filename");
});

test("sync_attachments skips a file whose recorded hash already matches", async () => {
  reset("<p>old</p>");
  const origFetch = (globalThis as any).fetch;
  const hash = FIXTURE_HASH;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    if (String(url).includes("/attachments")) {
      return jsonResponse({
        results: [{ title: "ch-02-0.svg", version: { message: `sha256:${hash}` } }],
      });
    }
    return origFetch(url, init);
  };
  try {
    const out = await call("confluence_sync_attachments", {
      page_id: "123",
      files: [{ path: FIXTURE_PATH, filename: "ch-02-0.svg" }],
    });
    eq(out.uploaded, 0, "unchanged file must not be re-uploaded");
    eq(out.files[0].reason, "unchanged", "");
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

test("an attachment with no recorded hash is compared by CONTENT before re-upload", async () => {
  // The customer's case: diagrams attached by hand months earlier carry no
  // sha marker, so the metadata check can't help. Without a content fallback
  // every such file is re-uploaded on every sync, spending a version to store
  // bytes that are already there.
  reset("<p>old</p>");
  const origFetch = (globalThis as any).fetch;
  const content = FIXTURE_BYTES;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const u = String(url);
    if (u.includes("/attachments")) {
      // No version.message -> no recorded hash, but a download link exists.
      return jsonResponse({
        results: [{ title: "ch-02-0.svg", _links: { download: "/download/ch-02-0.svg" } }],
      });
    }
    if (u.includes("/download/")) {
      return new Response(content, { status: 200 });
    }
    return origFetch(url, init);
  };
  try {
    const out = await call("confluence_sync_attachments", {
      page_id: "123",
      files: [{ path: FIXTURE_PATH, filename: "ch-02-0.svg" }],
    });
    eq(out.uploaded, 0, "identical bytes must not be re-uploaded");
    eq(out.files[0].reason, "identical_content", "and the reason says why");
    eq(
      calls.filter((c) => c.method === "PUT").length,
      0,
      "no upload call at all",
    );
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

test("differing content IS uploaded even without a recorded hash", async () => {
  reset("<p>old</p>");
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const u = String(url);
    if (u.includes("/attachments")) {
      return jsonResponse({
        results: [{ title: "ch-02-0.svg", _links: { download: "/download/ch-02-0.svg" } }],
      });
    }
    if (u.includes("/download/")) {
      return new Response(Buffer.from("totally different bytes"), { status: 200 });
    }
    return origFetch(url, init);
  };
  try {
    const out = await call("confluence_sync_attachments", {
      page_id: "123",
      files: [{ path: FIXTURE_PATH, filename: "ch-02-0.svg" }],
    });
    eq(out.uploaded, 1, "changed content must still upload");
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

test("force re-uploads even when the hash matches", async () => {
  reset("<p>old</p>");
  const origFetch = (globalThis as any).fetch;
  const hash = FIXTURE_HASH;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    if (String(url).includes("/attachments")) {
      return jsonResponse({
        results: [{ title: "ch-02-0.svg", version: { message: `sha256:${hash}` } }],
      });
    }
    return origFetch(url, init);
  };
  try {
    const out = await call("confluence_sync_attachments", {
      page_id: "123",
      files: [{ path: FIXTURE_PATH, filename: "ch-02-0.svg" }],
      force: true,
    });
    eq(out.uploaded, 1, "force overrides both skip paths");
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

// ─── read-only mode ───

test("publish and sync_attachments respect read-only mode", async () => {
  const roTools = new Map<string, (a: any) => Promise<string>>();
  registerPublishTools(
    { addTool: ({ name, execute }: any) => roTools.set(name, execute) } as any,
    { readOnly: true },
  );
  reset("<p>old</p>");
  const out = JSON.parse(
    await roTools.get("confluence_publish_page")!({ page_id: "123", markdown: "x\n" }),
  );
  eq(out.error, true, "read-only mode must refuse the write");
  eq(writes().length, 0, "and issue no PUT");
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

const __filename = fileURLToPath(import.meta.url);
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
