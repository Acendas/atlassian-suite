// Unit tests for the PO backlog surface — ordering, paging, issue edits,
// versions. Pins the exact request each tool puts on the wire.
//
// Why this exists: a LeSS PO could not order their backlog at all (no rank
// tool; Rank is not an editable field), and the neighbouring gaps all fail in
// the silent-success shape — jira_search ignored start_at so "page 2" was page
// 1 again, a 207 partial rank looks like a 2xx success, replacing labels wiped
// the ones already there, and wrapping `ORDER BY` inside the projects-filter
// parentheses is invalid JQL. None of that shows up as "did the call error?",
// only in the serialized request.
//
// jira.js sends through axios via `client.sendRequest(config)`, so we patch
// that on the singleton clients and inspect {method, url, data, params}.
//
// Runner: `npx tsx src/jira/_backlog.test.ts`, or via tests/eval-run.py →
// check_jira_backlog_tests. Prints "N passed, M failed".

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

process.env.JIRA_URL = "https://po.atlassian.test";
process.env.JIRA_USERNAME = "po@test";
process.env.JIRA_API_TOKEN = "token";
process.env.JIRA_PROJECTS_FILTER = "ABC";

import { jiraClient, jiraAgileClient } from "../common/jiraClient.js";
import { registerSearchTools } from "./search.js";
import { registerIssueTools } from "./issues.js";
import { registerProjectTools } from "./projects.js";
import { registerAgileTools } from "./agile.js";
import { scopeJql, summarizeRank, buildIssueEditOps, assertRankRequest } from "./_backlog.js";

type Call = { method: string; url: string; data: any; params: any };
const calls: Call[] = [];
let respond: (c: Call) => unknown = () => ({});

const intercept = async (config: any) => {
  const c: Call = {
    method: String(config.method ?? "GET").toUpperCase(),
    url: config.url,
    data: config.data,
    params: config.params,
  };
  calls.push(c);
  return respond(c);
};
(jiraClient() as any).sendRequest = intercept;
(jiraAgileClient() as any).sendRequest = intercept;

const tools = new Map<string, (args: any) => Promise<string>>();
const schemas = new Map<string, any>();
const fakeServer: any = {
  addTool: ({ name, execute, parameters }: { name: string; execute: (args: any) => Promise<string>; parameters: any }) => {
    tools.set(name, execute);
    schemas.set(name, parameters);
  },
};
const opts = { readOnly: false };
registerSearchTools(fakeServer);
registerIssueTools(fakeServer, opts);
registerProjectTools(fakeServer, opts);
registerAgileTools(fakeServer, opts);

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function throws(fn: () => void, pattern: RegExp, msg: string) {
  try {
    fn();
  } catch (e: any) {
    assert(pattern.test(String(e?.message)), `${msg} — wrong error: ${e?.message}`);
    return;
  }
  throw new Error(`${msg} — expected a throw`);
}

/** Run a tool; return its parsed output and every request it made. */
async function run(name: string, args: any, reply: (c: Call) => unknown = () => ({})) {
  const execute = tools.get(name);
  assert(execute, `tool not registered: ${name}`);
  calls.length = 0;
  respond = reply;
  const out = JSON.parse(await execute!(args));
  return { out, calls: [...calls] };
}

type Test = { name: string; fn: () => Promise<void> | void };
const tests: Test[] = [
  // ─── JQL scoping ───
  { name: "scopeJql: ORDER BY stays outside the filter parentheses", fn: () => {
    eq(scopeJql("status = 'To Do' ORDER BY Rank ASC", ["ABC"]), `project in ("ABC") AND (status = 'To Do') ORDER BY Rank ASC`, "ordered query");
    eq(scopeJql("ORDER BY Rank", ["ABC", "DEF"]), `project in ("ABC","DEF") ORDER BY Rank`, "order-only query");
    eq(scopeJql("summary ~ 'x'", ["ABC"]), `project in ("ABC") AND (summary ~ 'x')`, "unordered query");
    eq(scopeJql("a = 1 order by rank", undefined), "a = 1 order by rank", "no filter → untouched");
    eq(scopeJql(`summary ~ "sort order by date" ORDER BY Rank`, ["ABC"]), `project in ("ABC") AND (summary ~ "sort order by date") ORDER BY Rank`, "quoted 'order by' is not the clause");
  } },

  // ─── jira_search paging ───
  { name: "jira_search: sends next_page_token and scoped JQL, PO default fields", fn: async () => {
    const { calls } = await run("jira_search", { jql: "sprint is EMPTY ORDER BY Rank", max_results: 100, next_page_token: "tok-2" });
    eq(calls.length, 1, "one request");
    eq(calls[0].url, "/rest/api/3/search/jql", "enhanced search endpoint");
    eq(calls[0].params.nextPageToken, "tok-2", "token must reach Jira (was always undefined)");
    eq(calls[0].params.jql, `project in ("ABC") AND (sprint is EMPTY) ORDER BY Rank`, "scoped JQL");
    for (const f of ["parent", "fixVersions", "labels"]) assert(calls[0].params.fields.includes(f), `default fields include ${f}`);
  } },

  // ─── Ranking ───
  { name: "jira_rank_issues: PUT /issue/rank with before anchor", fn: async () => {
    const { out, calls } = await run("jira_rank_issues", { issue_keys: ["ABC-12", "ABC-13"], rank_before_issue: "ABC-7" }, () => "");
    eq(calls.length, 1, "one request");
    eq(calls[0].method, "PUT", "method"); eq(calls[0].url, "/rest/agile/1.0/issue/rank", "path");
    eq(calls[0].data.issues, ["ABC-12", "ABC-13"], "issues in order");
    eq(calls[0].data.rankBeforeIssue, "ABC-7", "rankBeforeIssue");
    assert(calls[0].data.rankAfterIssue === undefined, "no after anchor");
    eq(out.ok, true, "204 → ok"); eq(out.ranked, ["ABC-12", "ABC-13"], "all ranked");
  } },
  { name: "jira_rank_issues: 207 partial failure is reported, not success", fn: async () => {
    const body = { entries: [
      { issueId: 1, issueKey: "ABC-12", status: 200 },
      { issueId: 2, issueKey: "ABC-13", status: 403, errors: ["No permission to rank"] },
    ] };
    const { out } = await run("jira_rank_issues", { issue_keys: ["ABC-12", "ABC-13"], rank_after_issue: "ABC-1" }, () => body);
    eq(out.ok, false, "partial → not ok");
    eq(out.ranked, ["ABC-12"], "only ABC-12 ranked");
    eq(out.failed, [{ issue: "ABC-13", status: 403, errors: ["No permission to rank"] }], "failure detail");
  } },
  { name: "jira_rank_issues: bad requests refused before any call", fn: async () => {
    for (const [args, pattern] of [
      [{ issue_keys: ["ABC-1"] }, /rank_before_issue or rank_after_issue/],
      [{ issue_keys: ["ABC-1"], rank_before_issue: "ABC-2", rank_after_issue: "ABC-3" }, /not both/],
      [{ issue_keys: ["ABC-1", "abc-2"], rank_before_issue: "ABC-2" }, /relative to itself/],
      [{ issue_keys: Array.from({ length: 51 }, (_, i) => `ABC-${i}`), rank_before_issue: "X-1" }, /at most 50/],
    ] as const) {
      const { out, calls } = await run("jira_rank_issues", args);
      eq(calls.length, 0, `no request for ${JSON.stringify(args).slice(0, 60)}`);
      assert(out.error === true && pattern.test(out.message), `error ${pattern}: ${out.message}`);
    }
  } },
  { name: "summarizeRank: 204 empty body → all ranked", fn: () => {
    eq(summarizeRank(["A-1"], "", {}).ok, true, "empty string body");
    eq(summarizeRank(["A-1"], undefined, {}).ranked, ["A-1"], "undefined body");
  } },

  // ─── Backlog ───
  { name: "jira_move_issues_to_backlog: POST /backlog/issue", fn: async () => {
    const { calls } = await run("jira_move_issues_to_backlog", { issue_keys: ["ABC-5"] });
    eq(calls[0].method, "POST", "method"); eq(calls[0].url, "/rest/agile/1.0/backlog/issue", "path");
    eq(calls[0].data, { issues: ["ABC-5"] }, "body");
  } },
  { name: "jira_get_backlog_issues: adds the board's estimation field", fn: async () => {
    const { out, calls } = await run("jira_get_backlog_issues", { board_id: 7, max_results: 50, start_at: 0 }, (c) =>
      c.url.endsWith("/configuration") ? { estimation: { field: { fieldId: "customfield_10016" } } } : { issues: [], total: 0 });
    const backlog = calls.find((c) => c.url === "/rest/agile/1.0/board/7/backlog");
    assert(backlog, "backlog endpoint called");
    assert(backlog!.params.fields.includes("customfield_10016"), "story points field requested");
    eq(out.estimation_field, "customfield_10016", "estimation field reported");
  } },
  { name: "jira_get_backlog_issues: board config failure still returns backlog", fn: async () => {
    const { out } = await run("jira_get_backlog_issues", { board_id: 7, max_results: 50, start_at: 0 }, (c) => {
      if (c.url.endsWith("/configuration")) throw new Error("403");
      return { issues: [{ key: "ABC-1" }] };
    });
    eq(out.estimation_field, null, "no estimation field"); eq(out.issues, [{ key: "ABC-1" }], "backlog still returned");
  } },
  { name: "jira_add_issues_to_sprint: supports rank_before_issue", fn: async () => {
    const { calls } = await run("jira_add_issues_to_sprint", { sprint_id: 3, issue_keys: ["ABC-1"], rank_before_issue: "ABC-9" });
    eq(calls[0].url, "/rest/agile/1.0/sprint/3/issue", "path");
    eq(calls[0].data.rankBeforeIssue, "ABC-9", "rankBeforeIssue");
  } },

  // ─── Issue edits ───
  { name: "jira_update_issue: add/remove labels are update ops, not a replace", fn: async () => {
    const { calls } = await run("jira_update_issue", { issue_key: "ABC-1", add_labels: ["client-x"], remove_labels: ["stale"] });
    eq(calls[0].method, "PUT", "method");
    eq(calls[0].data.update.labels, [{ add: "client-x" }, { remove: "stale" }], "incremental labels");
    assert(!("labels" in calls[0].data.fields), "must NOT replace labels via fields");
  } },
  { name: "jira_update_issue: components and parent", fn: async () => {
    const { calls } = await run("jira_update_issue", { issue_key: "ABC-1", components: ["API"], parent_key: "ABC-50", add_components: [] });
    eq(calls[0].data.fields.components, [{ name: "API" }], "components replace");
    eq(calls[0].data.fields.parent, { key: "ABC-50" }, "parent");
    assert(calls[0].data.update === undefined, "no empty update block");
  } },
  { name: "buildIssueEditOps: replace + incremental on one field is refused", fn: () => {
    throws(() => buildIssueEditOps({ labels: ["a"], add_labels: ["b"] }), /not both/, "labels");
    throws(() => buildIssueEditOps({ components: ["a"], remove_components: ["b"] }), /not both/, "components");
  } },
  { name: "jira_create_issue: description_adf schema is an object that accepts a JSON string", fn: async () => {
    const doc = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "AC" }] }] };
    // Run the tool's OWN schema (what fastmcp does before execute) — a z.any()
    // regression would pass the string through untouched.
    const args = schemas.get("jira_create_issue").parse({ project_key: "ABC", summary: "S", issue_type: "Story", description_adf: JSON.stringify(doc) });
    eq(typeof args.description_adf, "object", "stringified ADF parsed to an object");
    const { calls } = await run("jira_create_issue", args, () => ({ key: "ABC-99" }));
    eq(calls[0].data.fields.description, doc, "description is the ADF object");
  } },
  // ─── Versions ───
  { name: "jira_update_version: release + move unfixed uses the target's self URL", fn: async () => {
    const self = "https://po.atlassian.test/rest/api/3/version/200";
    const { calls } = await run("jira_update_version", { version_id: "100", released: true, release_date: "2026-10-30", move_unfixed_issues_to_version_id: "200" },
      (c) => (c.method === "GET" ? { id: "200", self } : {}));
    const put = calls.find((c) => c.method === "PUT")!;
    eq(put.url, "/rest/api/3/version/100", "path");
    eq(put.data.released, true, "released"); eq(put.data.releaseDate, "2026-10-30", "releaseDate");
    eq(put.data.moveUnfixedIssuesTo, self, "moveUnfixedIssuesTo is a URL, not an id");
  } },
  { name: "assertRankRequest: anchor optional for sprint/backlog moves", fn: () => {
    assertRankRequest(["A-1"], undefined, undefined, true);
  } },
];

async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
    } catch (e: any) {
      failed++;
      console.error(`FAIL ${t.name}: ${e?.message ?? e}`);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main();
