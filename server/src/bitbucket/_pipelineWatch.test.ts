// Unit tests for pipeline watching — the follower loop and watch_pipeline.
//
// Why this exists: a user asked to watch a build and be told how it ended.
// The follower's output IS the notification, so every way it can go quiet is
// a missed outcome: a manual step that leaves the run IN_PROGRESS forever, a
// state shape this code has never seen, a credential failure, a network
// blip. Each scenario below asserts what the user would see, line by line,
// and that every run ends with exactly one DONE / WATCH_ERROR / WATCH_TIMEOUT.
//
// State shapes are copied from live Bitbucket responses (2026-10-17).
//
// Runner: `npx tsx src/bitbucket/_pipelineWatch.test.ts`, or via
// tests/eval-run.py → check_pipeline_watch_tests. Prints "N passed, M failed".

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildWatchCommand,
  classifyPipeline,
  runPipelineWatch,
  WATCH_EXIT,
  type Pipeline,
  type PipelineStep,
} from "./_pipelineWatch.js";
import { registerPipelineTools } from "./pipelines.js";

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
};
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

// ─── Live state shapes ───
const RUNNING = { name: "IN_PROGRESS", type: "pipeline_state_in_progress", stage: { name: "RUNNING" } };
const PAUSED = { name: "IN_PROGRESS", type: "pipeline_state_in_progress", stage: { name: "PAUSED" } };
const PENDING = { name: "PENDING", type: "pipeline_state_pending" };
const completed = (result: string, extra: object = {}) => ({
  name: "COMPLETED",
  type: "pipeline_state_completed",
  result: { name: result, ...extra },
});
const step = (name: string, state: object, extra: Partial<PipelineStep> = {}): PipelineStep => ({
  uuid: `{${name}}`,
  name,
  state,
  trigger: { type: "pipeline_step_trigger_automatic" },
  ...extra,
});
const stepDone = (name: string, result: string, secs: number) =>
  step(name, { name: "COMPLETED", result: { name: result } }, { duration_in_seconds: secs });
const stepRunning = (name: string) => step(name, { name: "IN_PROGRESS" });
const stepPending = (name: string) => step(name, { name: "PENDING", stage: { name: "PENDING" } });
const stepManual = (name: string) =>
  step(name, { name: "PENDING", stage: { name: "PAUSED" } }, { trigger: { type: "pipeline_step_trigger_manual" } });

const pipeline = (state: object, extra: Partial<Pipeline> = {}): Pipeline => ({
  uuid: "{60c39e86-241f-483e-a83d-136740aad870}",
  build_number: 5956,
  state,
  target: { type: "pipeline_ref_target", ref_name: "main" },
  ...extra,
});

type Poll = { pipeline: Pipeline; steps: PipelineStep[] } | { error: any };

/** Run the follower against a scripted sequence of polls. The last poll repeats. */
async function watch(polls: Poll[], opts: { deadlineMs?: number } = {}) {
  const lines: string[] = [];
  const paths: string[] = [];
  let i = 0;
  let clock = 0;
  let current: Poll = polls[0];
  const code = await runPipelineWatch(
    {
      get: async <T>(path: string): Promise<T> => {
        paths.push(path);
        if (path.endsWith("/steps/")) {
          if ("error" in current) throw current.error;
          return { values: current.steps } as T;
        }
        current = polls[Math.min(i++, polls.length - 1)];
        if ("error" in current) throw current.error;
        return current.pipeline as T;
      },
      emit: (l) => lines.push(l),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
    { workspace: "acme", repo: "afm-app", pipeline: "5956", intervalMs: 30_000, deadlineMs: opts.deadlineMs ?? 4 * 3600_000 },
  );
  return { code, lines, paths };
}

const FINAL = /\] (DONE|WATCH_ERROR|WATCH_TIMEOUT) /;
const assertOneFinalLast = (lines: string[]): void => {
  eq(lines.filter((l) => FINAL.test(l)).length, 1, "exactly one final line");
  ok(FINAL.test(lines[lines.length - 1]), `last line is the final line: ${lines[lines.length - 1]}`);
};

const httpError = (status: number) =>
  Object.assign(new Error(`Bitbucket GET failed: ${status}`), { name: "AtlassianHttpError", status });

// ─── watch_pipeline tool harness ───
type Call = { path: string; query: any };
function toolHarness(respond: (path: string, query: any) => unknown) {
  const tools = new Map<string, any>();
  const calls: Call[] = [];
  const fakeServer = { addTool: (t: any) => tools.set(t.name, t) } as any;
  const http = {
    get: async (path: string, query?: any) => {
      calls.push({ path, query });
      return respond(path, query);
    },
  } as any;
  registerPipelineTools(fakeServer, { workspace: "acme", http, readOnly: true });
  return {
    calls,
    run: async (args: any) => JSON.parse(await tools.get("watch_pipeline").execute(args)),
  };
}

const tests: TestCase[] = [
  // ─── classification ───
  { name: "classify: every completed result is terminal", fn: () => {
    for (const r of ["SUCCESSFUL", "FAILED", "ERROR", "STOPPED", "EXPIRED"]) {
      eq(classifyPipeline(completed(r)), { label: r, terminal: true }, r);
    }
  } },
  { name: "classify: paused on a manual step ends the watch", fn: () => {
    eq(classifyPipeline(PAUSED), { label: "PAUSED", terminal: true }, "paused");
  } },
  { name: "classify: running, pending and unknown shapes keep watching, labelled raw", fn: () => {
    eq(classifyPipeline(RUNNING), { label: "RUNNING", terminal: false }, "running");
    eq(classifyPipeline(PENDING), { label: "PENDING", terminal: false }, "pending");
    eq(classifyPipeline({ name: "IN_PROGRESS", stage: { name: "HALTED" } }), { label: "HALTED", terminal: false }, "unknown stage");
    eq(classifyPipeline({ name: "PARSING" }), { label: "PARSING", terminal: false }, "unknown name");
    eq(classifyPipeline(undefined), { label: "UNKNOWN", terminal: false }, "no state");
  } },

  // ─── follower scenarios ───
  { name: "already finished: one DONE line naming the failed step, exit 0", fn: async () => {
    const { code, lines } = await watch([
      { pipeline: pipeline(completed("FAILED"), { duration_in_seconds: 281 }), steps: [stepDone("Lint", "SUCCESSFUL", 40), stepDone("PR review", "FAILED", 241)] },
    ]);
    eq(code, WATCH_EXIT.done, "exit code");
    eq(lines, ['[pipeline #5956] DONE FAILED after 4m41s — failed step: "PR review" — https://bitbucket.org/acme/afm-app/pipelines/results/5956'], "lines");
  } },
  { name: "running to failure: start line, each step result, then DONE", fn: async () => {
    const { code, lines } = await watch([
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Build"), stepPending("Test")] },
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Build"), stepPending("Test")] },
      { pipeline: pipeline(RUNNING), steps: [stepDone("Build", "SUCCESSFUL", 62), stepRunning("Test")] },
      { pipeline: pipeline(completed("FAILED"), { duration_in_seconds: 400 }), steps: [stepDone("Build", "SUCCESSFUL", 62), stepDone("Test", "FAILED", 330)] },
    ]);
    eq(code, WATCH_EXIT.done, "exit code");
    eq(lines, [
      '[pipeline #5956] watching afm-app @ main — RUNNING, 0/2 steps done, running: "Build"',
      '[pipeline #5956] step "Build" SUCCESSFUL (1m02s)',
      '[pipeline #5956] step "Test" FAILED (5m30s)',
      '[pipeline #5956] DONE FAILED after 6m40s — failed step: "Test" — https://bitbucket.org/acme/afm-app/pipelines/results/5956',
    ], "lines");
  } },
  { name: "successful run: DONE SUCCESSFUL with no failed-step clause", fn: async () => {
    const { lines } = await watch([
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Build")] },
      { pipeline: pipeline(completed("SUCCESSFUL"), { duration_in_seconds: 3723 }), steps: [stepDone("Build", "SUCCESSFUL", 3700)] },
    ]);
    eq(lines.at(-1), "[pipeline #5956] DONE SUCCESSFUL after 1h02m — https://bitbucket.org/acme/afm-app/pipelines/results/5956", "final");
    assertOneFinalLast(lines);
  } },
  { name: "paused on a manual step: DONE PAUSED names the waiting step", fn: async () => {
    const { code, lines } = await watch([
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Deploy staging"), stepManual("Deployment to Production")] },
      { pipeline: pipeline(PAUSED), steps: [stepDone("Deploy staging", "SUCCESSFUL", 5), stepManual("Deployment to Production")] },
    ]);
    eq(code, WATCH_EXIT.done, "exit code");
    eq(lines.at(-1), '[pipeline #5956] DONE PAUSED — 1/2 steps done, waiting for manual step "Deployment to Production" — https://bitbucket.org/acme/afm-app/pipelines/results/5956', "final");
    assertOneFinalLast(lines);
  } },
  { name: "stopped: DONE names who stopped it", fn: async () => {
    const { lines } = await watch([
      { pipeline: pipeline(completed("STOPPED", { terminator: { display_name: "Sam Lee" } }), { duration_in_seconds: 90 }), steps: [stepDone("Build", "STOPPED", 88)] },
    ]);
    ok(lines[0].includes("DONE STOPPED by Sam Lee after 1m30s"), lines[0]);
  } },
  { name: "state changes are reported: PENDING → RUNNING", fn: async () => {
    const { lines } = await watch([
      { pipeline: pipeline(PENDING), steps: [stepPending("Build")] },
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Build")] },
      { pipeline: pipeline(completed("SUCCESSFUL")), steps: [stepDone("Build", "SUCCESSFUL", 10)] },
    ]);
    ok(lines.includes("[pipeline #5956] now RUNNING (was PENDING)"), lines.join("\n"));
    assertOneFinalLast(lines);
  } },
  { name: "an unknown state shape mid-watch is reported, not swallowed", fn: async () => {
    const { lines } = await watch([
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Build")] },
      { pipeline: pipeline({ name: "IN_PROGRESS", stage: { name: "HALTED" } }), steps: [stepRunning("Build")] },
      { pipeline: pipeline(completed("SUCCESSFUL")), steps: [stepDone("Build", "SUCCESSFUL", 10)] },
    ]);
    ok(lines.includes("[pipeline #5956] now HALTED (was RUNNING)"), lines.join("\n"));
  } },
  { name: "follower polls by build number, steps by uuid", fn: async () => {
    const { paths } = await watch([{ pipeline: pipeline(completed("SUCCESSFUL")), steps: [] }]);
    eq(paths, [
      "/repositories/acme/afm-app/pipelines/5956",
      "/repositories/acme/afm-app/pipelines/%7B60c39e86-241f-483e-a83d-136740aad870%7D/steps/",
    ], "paths");
  } },

  // ─── failures still end with a line ───
  { name: "401: one WATCH_ERROR line pointing at as-init, exit 2", fn: async () => {
    const { code, lines } = await watch([{ error: httpError(401) }]);
    eq(code, WATCH_EXIT.error, "exit code");
    eq(lines.length, 1, "one line");
    ok(lines[0].startsWith("[pipeline #5956] WATCH_ERROR 401") && lines[0].includes("as-init"), lines[0]);
  } },
  { name: "404: WATCH_ERROR says which run was not found", fn: async () => {
    const { lines } = await watch([{ error: httpError(404) }]);
    ok(lines[0].includes("WATCH_ERROR 404 — no pipeline 5956 in acme/afm-app"), lines[0]);
  } },
  { name: "network blips: one warning at 3 failures, then recovery continues the watch", fn: async () => {
    const blip = { error: new TypeError("fetch failed") };
    const { code, lines } = await watch([
      { pipeline: pipeline(RUNNING), steps: [stepRunning("Build")] },
      blip, blip, blip, blip,
      { pipeline: pipeline(completed("SUCCESSFUL")), steps: [stepDone("Build", "SUCCESSFUL", 10)] },
    ]);
    eq(code, WATCH_EXIT.done, "exit code");
    eq(lines.filter((l) => l.includes("warning:")), ["[pipeline #5956] warning: 3 polls failed in a row (fetch failed); still trying"], "one warning per streak");
    assertOneFinalLast(lines);
  } },
  { name: "sustained 5xx: WATCH_ERROR gives up after 10 failed polls", fn: async () => {
    const { code, lines } = await watch([{ error: httpError(503) }]);
    eq(code, WATCH_EXIT.error, "exit code");
    ok(lines.at(-1)!.includes("WATCH_ERROR gave up after 10 failed polls in a row: 503"), lines.at(-1)!);
    assertOneFinalLast(lines);
  } },
  { name: "time cap: WATCH_TIMEOUT with the last known state, exit 3", fn: async () => {
    const { code, lines } = await watch([{ pipeline: pipeline(RUNNING), steps: [stepRunning("Build")] }], { deadlineMs: 5 * 60_000 });
    eq(code, WATCH_EXIT.timeout, "exit code");
    eq(lines.at(-1), "[pipeline #5956] WATCH_TIMEOUT still RUNNING at the watch's time limit (1970-01-01T00:05Z) — watch again to keep following it", "final");
    assertOneFinalLast(lines);
  } },
  { name: "re-arm after the deadline: current state, then WATCH_TIMEOUT, no endless restart", fn: async () => {
    const { code, lines } = await watch([{ pipeline: pipeline(RUNNING), steps: [stepRunning("Build")] }], { deadlineMs: 0 });
    eq(code, WATCH_EXIT.timeout, "exit code");
    eq(lines.length, 2, "progress line + timeout");
    assertOneFinalLast(lines);
  } },
  { name: "re-arm after a step failed unwatched: the first line names it", fn: async () => {
    // Monitor killed the follower at 30 min; "Lint" failed before the re-arm,
    // so no step line exists for it. The restart line must carry it.
    const { lines } = await watch([
      { pipeline: pipeline(RUNNING), steps: [stepDone("Lint", "FAILED", 20), stepRunning("Build")] },
      { pipeline: pipeline(completed("FAILED")), steps: [stepDone("Lint", "FAILED", 20), stepDone("Build", "SUCCESSFUL", 90)] },
    ]);
    eq(lines[0], '[pipeline #5956] watching afm-app @ main — RUNNING, 1/2 steps done, failed so far: "Lint", running: "Build"', "first line");
    eq(lines.filter((l) => l.includes('step "Lint"')).length, 0, "no duplicate step line for an already-failed step");
    assertOneFinalLast(lines);
  } },

  // ─── the command handed to Monitor ───
  { name: "command survives spaces and quotes through a real shell", fn: () => {
    if (process.platform === "win32") return;
    // Swap node for printf so the shell prints each argument it received.
    const cmd = buildWatchCommand({
      node: "printf",
      nodeArgs: ["%s\\n"],
      entry: "/Users/O'Brien/My Plugins/server.js",
      workspace: "acme",
      repo: "afm-app",
      buildNumber: 5956,
      intervalSeconds: 45,
      deadlineEpochSeconds: 1792000000,
    });
    const out = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
    eq(out.stdout.split("\n").filter(Boolean), [
      "/Users/O'Brien/My Plugins/server.js", "watch-pipeline", "--workspace", "acme", "--repo", "afm-app", "--pipeline", "5956",
      "--interval", "45", "--deadline", "1792000000",
    ], "argv after shell parsing");
  } },
  { name: "command on Windows uses forward slashes", fn: () => {
    const cmd = buildWatchCommand(
      { node: "C:\\Program Files\\nodejs\\node.exe", nodeArgs: [], entry: "C:\\Users\\me\\plugin\\server.js", workspace: "acme", repo: "app", buildNumber: 7 },
      "win32",
    );
    ok(cmd.startsWith("'C:/Program Files/nodejs/node.exe' 'C:/Users/me/plugin/server.js' 'watch-pipeline'"), cmd);
  } },

  // ─── watch_pipeline tool ───
  { name: "watch_pipeline by branch: latest run via target.branch, command by build number, no secrets", fn: async () => {
    process.env.ATLASSIAN_API_TOKEN = "s3cr3t-token-value";
    try {
      const h = toolHarness((path) =>
        path.endsWith("/steps/") ? { values: [stepRunning("Build")] } : { values: [pipeline(RUNNING)] },
      );
      const out = await h.run({ repo_slug: "afm-app", branch: "main" });
      eq(h.calls[0].query["target.branch"], "main", "branch filter matches branch and PR pipelines");
      eq(h.calls[0].query.pagelen, 1, "latest run only");
      eq(out.build_number, 5956, "build number");
      eq(out.terminal, false, "not terminal");
      ok(out.monitor_command.includes("'--pipeline' '5956'"), out.monitor_command);
      ok(!out.monitor_command.includes("{"), "no uuid braces in the command");
      const deadline = Number(/'--deadline' '(\d+)'/.exec(out.monitor_command)?.[1]);
      const expected = Math.floor(Date.now() / 1000) + 240 * 60;
      ok(Math.abs(deadline - expected) < 5, `deadline is an absolute 240 min from now, shared by re-arms: ${deadline}`);
      ok(!JSON.stringify(out).includes("s3cr3t-token-value"), "token never in the response");
      ok(out.credentials_note?.includes("ATLASSIAN_API_TOKEN"), "env-credential note names the var");
      eq(out.monitor_description, "Bitbucket pipeline afm-app #5956", "description");
    } finally {
      delete process.env.ATLASSIAN_API_TOKEN;
    }
  } },
  { name: "watch_pipeline on a finished run: summary only, nothing to arm", fn: async () => {
    const h = toolHarness((path) =>
      path.endsWith("/steps/") ? { values: [stepDone("Build", "FAILED", 30)] } : pipeline(completed("FAILED"), { duration_in_seconds: 31 }),
    );
    const out = await h.run({ repo_slug: "afm-app", pipeline: "5956" });
    eq(h.calls[0].path, "/repositories/acme/afm-app/pipelines/5956", "fetched by build number");
    eq(out.terminal, true, "terminal");
    eq(out.monitor_command, undefined, "no command");
    ok(out.summary.includes("DONE FAILED after 31s"), out.summary);
  } },
  { name: "watch_pipeline: no run on the branch is an error, not an empty watch", fn: async () => {
    const h = toolHarness(() => ({ values: [] }));
    const out = await h.run({ repo_slug: "afm-app", branch: "nope" });
    ok(out.error && out.message.includes("No pipeline runs on branch nope"), JSON.stringify(out));
  } },
  { name: "watch_pipeline: needs a pipeline or a branch", fn: async () => {
    const h = toolHarness(() => ({}));
    const out = await h.run({ repo_slug: "afm-app" });
    ok(out.error && h.calls.length === 0, JSON.stringify(out));
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
      console.error(`FAIL: ${t.name}: ${e?.message ?? e}`);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main();
