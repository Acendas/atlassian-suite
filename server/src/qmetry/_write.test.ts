// Unit tests for the QMetry WRITE surface — pins the exact request body/path
// each create/update/link tool puts on the wire, verified against the qTM4J
// Cloud OpenAPI spec.
//
// Why this exists: the whole QMetry write surface was originally built against
// the *read* response shapes (named-value `{id,name}` objects, `name`-keyed
// fields) instead of the *write* request schemas (bare integer ids, different
// field names — `stepDetails` not `step`, `folderName` not `name`,
// `executionAssignee` not `assignee`, `testCases` not `testcases`, …). Those
// mismatches 2xx-succeed while silently doing nothing, so they can't be caught
// by "did the call error?" — only by asserting the serialized body. We can't
// create in live production, so this mocks `fetch` and inspects what would be
// sent. Each assertion cites the spec field it pins.
//
// Runner: `node --import tsx/esm src/qmetry/_write.test.ts`, or via the
// atlassian-suite eval harness (tests/eval-run.py → check_qmetry_write_tests).

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Drive loadQMetryConfig() through env so qmetryClient() builds a real client
// whose global fetch we control.
process.env.QMETRY_API_KEY = "test-key";
process.env.QMETRY_BASE_URL = "https://qtm.test/rest/api/latest";

import { registerQMetryTestCaseTools } from "./testcases.js";
import { registerQMetryFolderTools } from "./folders.js";
import { registerQMetryTestCycleTools } from "./testcycles.js";
import { registerQMetryExecutionTools } from "./executions.js";

type Call = { method: string; url: string; body: any };
const calls: Call[] = [];

// Canned lookup responses, keyed by URL fragment. Writes return {} (200).
function canned(url: string): unknown {
  if (url.includes("/execution-results")) return [{ id: 501, name: "Pass" }, { id: 502, name: "Fail" }];
  if (url.includes("/testcase-statuses")) return [{ id: 101, name: "To Do" }, { id: 102, name: "In Progress" }];
  if (url.includes("/testcycle-statuses")) return [{ id: 401, name: "Not Started" }];
  if (url.includes("/priorities")) return [{ id: 201, name: "High" }, { id: 202, name: "Medium" }];
  if (url.includes("/labels")) return [{ id: 301, name: "smoke" }, { id: 302, name: "regression" }];
  return {};
}

(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const method = init.method ?? "GET";
  let body: any;
  if (init.body !== undefined) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  calls.push({ method, url: String(url), body });
  return new Response(JSON.stringify(canned(String(url))), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Fake FastMCP server — capture each tool's execute fn by name.
const tools = new Map<string, (args: any) => Promise<unknown>>();
const fakeServer: any = {
  addTool: ({ name, execute }: { name: string; execute: (args: any) => Promise<unknown> }) => {
    tools.set(name, execute);
  },
};
const opts = { readOnly: false };
registerQMetryTestCaseTools(fakeServer, opts);
registerQMetryFolderTools(fakeServer, opts);
registerQMetryTestCycleTools(fakeServer, opts);
registerQMetryExecutionTools(fakeServer, opts);

// ─── assertion helpers ───
function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
// Run a tool, return the single non-GET (write) request it made.
async function write(toolName: string, args: any): Promise<Call> {
  const execute = tools.get(toolName);
  assert(execute, `tool not registered: ${toolName}`);
  calls.length = 0;
  await execute!(args);
  const writes = calls.filter((c) => c.method !== "GET");
  assert(writes.length === 1, `${toolName}: expected exactly 1 write call, got ${writes.length} (${writes.map((w) => w.method + " " + w.url).join("; ")})`);
  return writes[0];
}

type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [
  { name: "create_test_case: status/priority/labels resolve to integer ids", fn: async () => {
    const w = await write("qmetry_create_test_case", { project_id: 10, summary: "S", status: "To Do", priority: "High", description: "D", labels: ["smoke"], folder_id: 5 });
    eq(w.method, "POST", "method"); assert(w.url.endsWith("/rest/api/latest/testcases"), `path ${w.url}`);
    eq(w.body.status, 101, "status must be integer id (testcase-statuses lookup)");
    eq(w.body.priority, 201, "priority must be integer id (priorities lookup)");
    eq(w.body.labels, [301], "labels must be integer ids");
    eq(w.body.projectId, 10, "projectId"); eq(w.body.summary, "S", "summary"); eq(w.body.folderId, 5, "folderId");
    assert(typeof w.body.status === "number" && (w.body.status as any).name === undefined, "status must NOT be a {name} object");
  } },
  { name: "update_test_case: status integer id, no labels field", fn: async () => {
    const w = await write("qmetry_update_test_case", { test_case_id: "abc", version: 1, project_id: 10, status: "In Progress", summary: "S2" });
    eq(w.method, "PUT", "method"); assert(w.url.endsWith("/rest/api/latest/testcases/abc/versions/1"), `path ${w.url}`);
    eq(w.body.status, 102, "status integer id"); eq(w.body.summary, "S2", "summary");
    assert(!("labels" in w.body), "update must not send a flat labels array (spec uses MetaDataUpdateRequest)");
  } },
  { name: "create_test_step: action field is stepDetails not step", fn: async () => {
    const w = await write("qmetry_create_test_step", { test_case_id: "abc", version: 1, step: "do x", expected_result: "y", test_data: "d" });
    eq(w.method, "POST", "method"); assert(w.url.endsWith("/versions/1/teststeps"), `path ${w.url}`);
    eq(w.body.stepDetails, "do x", "stepDetails (required CreateTestStepRequest field)");
    assert(!("step" in w.body), "must NOT send `step`"); eq(w.body.expectedResult, "y", "expectedResult"); eq(w.body.testData, "d", "testData");
  } },
  { name: "update_test_step: stepDetails + id", fn: async () => {
    const w = await write("qmetry_update_test_step", { test_case_id: "abc", version: 1, step_id: 9, step: "new", expected_result: "z" });
    eq(w.method, "PUT", "method"); eq(w.body.id, 9, "id (required)"); eq(w.body.stepDetails, "new", "stepDetails");
    assert(!("step" in w.body), "must NOT send `step`");
  } },
  { name: "delete_test_step: body stepIds:[id]", fn: async () => {
    const w = await write("qmetry_delete_test_step", { test_case_id: "abc", version: 1, step_id: 9 });
    eq(w.method, "DELETE", "method"); eq(w.body.stepIds, [9], "DeleteTestStepRequest.stepIds");
    assert(!("id" in w.body), "must NOT send bare `id`");
  } },
  { name: "link_requirement: requirement-keyed endpoint + testcases array", fn: async () => {
    const w = await write("qmetry_link_requirement", { test_case_id: "abc", version: 2, jira_issue_key: "PROJ-1" });
    eq(w.method, "POST", "method"); assert(w.url.endsWith("/rest/api/latest/requirements/PROJ-1/testcases/link"), `path ${w.url}`);
    eq(w.body.testcases, [{ id: "abc", versionNo: 2 }], "testcases:[{id,versionNo}]");
    assert(!("issueKey" in w.body), "must NOT send issueKey (not an accepted field)");
  } },
  { name: "unlink_requirement: requirement-keyed DELETE + testcases array", fn: async () => {
    const w = await write("qmetry_unlink_requirement", { test_case_id: "abc", version: 2, jira_issue_key: "PROJ-1" });
    eq(w.method, "DELETE", "method"); assert(w.url.endsWith("/rest/api/latest/requirements/PROJ-1/testcases/unlink"), `path ${w.url}`);
    eq(w.body.testcases, [{ id: "abc", versionNo: 2 }], "testcases:[{id,versionNo}]");
  } },
  { name: "create_folder: field folderName not name", fn: async () => {
    const w = await write("qmetry_create_folder", { project_id: 10, name: "F", parent_id: 3 });
    eq(w.method, "POST", "method"); assert(w.url.endsWith("/rest/api/latest/projects/10/testcase-folders"), `path ${w.url}`);
    eq(w.body.folderName, "F", "FolderRequest.folderName"); eq(w.body.parentId, 3, "parentId");
    assert(!("name" in w.body), "must NOT send `name`");
  } },
  { name: "create_test_cycle: status id + plannedStartDate/EndDate", fn: async () => {
    const w = await write("qmetry_create_test_cycle", { project_id: 10, summary: "C", status: "Not Started", priority: "Medium", start_date: "01/Jul/2026 09:00", end_date: "15/Jul/2026 18:00", description: "D" });
    eq(w.method, "POST", "method"); assert(w.url.endsWith("/rest/api/latest/testcycles"), `path ${w.url}`);
    eq(w.body.status, 401, "status integer id (testcycle-statuses)"); eq(w.body.priority, 202, "priority integer id");
    eq(w.body.plannedStartDate, "01/Jul/2026 09:00", "plannedStartDate"); eq(w.body.plannedEndDate, "15/Jul/2026 18:00", "plannedEndDate");
    eq(w.body.projectId, 10, "projectId");
    assert(!("startDate" in w.body) && !("endDate" in w.body), "must NOT send legacy startDate/endDate");
  } },
  { name: "update_test_cycle: status id + plannedStartDate", fn: async () => {
    const w = await write("qmetry_update_test_cycle", { test_cycle_id: "cyc", project_id: 10, status: "Not Started", start_date: "01/Jul/2026 09:00" });
    eq(w.method, "PUT", "method"); assert(w.url.endsWith("/rest/api/latest/testcycles/cyc"), `path ${w.url}`);
    eq(w.body.status, 401, "status integer id"); eq(w.body.plannedStartDate, "01/Jul/2026 09:00", "plannedStartDate");
  } },
  { name: "add_test_cases_to_cycle: testCases:[{id,versionNo}]", fn: async () => {
    const w = await write("qmetry_add_test_cases_to_cycle", { test_cycle_id: "cyc", test_case_ids: ["a", "b"], version: 1 });
    eq(w.method, "POST", "method"); assert(w.url.endsWith("/rest/api/latest/testcycles/cyc/testcases"), `path ${w.url}`);
    eq(w.body.testCases, [{ id: "a", versionNo: 1 }, { id: "b", versionNo: 1 }], "LinkTestCaseRequest.testCases (capital C, with versionNo)");
    assert(!("testcases" in w.body), "must NOT send lowercase `testcases`");
  } },
  { name: "remove_test_cases_from_cycle: DELETE testCases:[{id,versionNo}]", fn: async () => {
    const w = await write("qmetry_remove_test_cases_from_cycle", { test_cycle_id: "cyc", test_case_ids: ["a", "b"], version: 1 });
    eq(w.method, "DELETE", "method"); assert(w.url.endsWith("/rest/api/latest/testcycles/cyc/testcases"), `path ${w.url}`);
    eq(w.body.testCases, [{ id: "a", versionNo: 1 }, { id: "b", versionNo: 1 }], "UnlinkTestCaseRequest.testCases (capital C, with versionNo)");
  } },
  { name: "delete_execution: path-only DELETE, no body", fn: async () => {
    const w = await write("qmetry_delete_execution", { test_cycle_id: "cyc", execution_id: 7 });
    eq(w.method, "DELETE", "method"); assert(w.url.endsWith("/rest/api/latest/testcycles/cyc/testcase-executions/7"), `path ${w.url}`);
    assert(w.body === undefined, "delete execution must send no request body");
  } },
  { name: "update_execution: executionAssignee + executionResultId", fn: async () => {
    const w = await write("qmetry_update_execution", { test_cycle_id: "cyc", execution_id: 7, status_name: "Pass", project_id: 10, comment: "c", assignee_account_id: "712020:x" });
    eq(w.method, "PUT", "method"); assert(w.url.endsWith("/rest/api/latest/testcycles/cyc/testcase-executions/7"), `path ${w.url}`);
    eq(w.body.executionResultId, 501, "executionResultId (execution-results lookup)"); eq(w.body.executionAssignee, "712020:x", "executionAssignee");
    eq(w.body.comment, "c", "comment");
    assert(!("assignee" in w.body), "must NOT send `assignee` (silently dropped by QMetry)");
  } },
  { name: "read-only mode blocks writes", fn: async () => {
    const roTools = new Map<string, (a: any) => Promise<unknown>>();
    registerQMetryTestCaseTools({ addTool: ({ name, execute }: any) => roTools.set(name, execute) } as any, { readOnly: true });
    const res = (await roTools.get("qmetry_create_test_case")!({ project_id: 10, summary: "S" })) as string;
    assert(/READ_ONLY_MODE/.test(res), "read-only mode must block create_test_case");
  } },
];

async function run() {
  const failures: string[] = [];
  let passed = 0;
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
const isMain = typeof process !== "undefined" && process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isMain) {
  run().then(({ passed, failed, failures }) => {
    console.log(`${passed} passed, ${failed} failed`);
    for (const f of failures) console.log("  FAIL:", f);
    process.exit(failed === 0 ? 0 : 1);
  });
}
