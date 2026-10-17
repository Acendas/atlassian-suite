// Pipeline watching for Claude Code's Monitor.
//
// `watch_pipeline` (pipelines.ts) resolves a run and returns a command that
// re-runs this bundle as a follower: `server.js watch-pipeline --repo … `.
// The follower polls Bitbucket and prints one line per change. Each stdout
// line becomes a notification in the user's session, so:
//
//  - It always ends with exactly one final line — DONE, WATCH_ERROR or
//    WATCH_TIMEOUT. A follower that dies silently looks the same as a build
//    that is still running.
//  - It reads credentials itself (env or ~/.acendas-atlassian). None go on
//    the command line, which lands in the transcript.
//  - PAUSED ends the watch. A run waiting on a manual step stays IN_PROGRESS
//    indefinitely (seen live: a run paused on "Deployment to Production" for
//    over a year), so a watcher that only knew COMPLETED would never finish.
//
// The loop takes its HTTP, clock and output as arguments so tests can script
// a run end to end (see _pipelineWatch.test.ts).

import { parseArgs } from "node:util";
import { loadBitbucketConfig } from "../common/config.js";
import { createBitbucketHttp, type Query } from "../common/http.js";

interface StateResult {
  name?: string;
  terminator?: { display_name?: string };
}

export interface PipelineState {
  name?: string;
  type?: string;
  stage?: { name?: string };
  result?: StateResult;
}

export interface PipelineStep {
  uuid?: string;
  name?: string;
  state?: PipelineState;
  trigger?: { type?: string };
  duration_in_seconds?: number;
}

export interface Pipeline {
  uuid?: string;
  build_number?: number;
  state?: PipelineState;
  duration_in_seconds?: number;
  target?: {
    type?: string;
    ref_name?: string;
    source?: string;
    destination?: string;
    pullrequest?: { id?: number };
    commit?: { hash?: string };
    selector?: { type?: string; pattern?: string };
  };
}

export const DEFAULT_INTERVAL_SECONDS = 30;
export const MIN_INTERVAL_SECONDS = 10;
export const DEFAULT_MAX_MINUTES = 240;

/** Statuses that will not change on retry: bad request, auth, scope, missing run. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 410]);
/** Consecutive failed polls before a warning line, and before giving up. */
const WARN_AFTER_FAILURES = 3;
const GIVE_UP_AFTER_FAILURES = 10;

/** What a pipeline state means for a watch. Unknown shapes are reported raw
 *  and keep the watch going, so a new Bitbucket state is visible, not silent. */
export function classifyPipeline(state: PipelineState | undefined): { label: string; terminal: boolean } {
  const name = state?.name;
  if (name === "COMPLETED") return { label: state?.result?.name ?? "COMPLETED", terminal: true };
  if (name === "IN_PROGRESS") {
    const stage = state?.stage?.name;
    if (stage === "PAUSED") return { label: "PAUSED", terminal: true };
    return { label: !stage || stage === "RUNNING" ? "RUNNING" : stage, terminal: false };
  }
  return { label: name ?? state?.type ?? "UNKNOWN", terminal: false };
}

export function stepLabel(step: PipelineStep): string {
  const s = step.state;
  if (s?.name === "COMPLETED") return s.result?.name ?? "COMPLETED";
  if (s?.name === "IN_PROGRESS") return "RUNNING";
  if (s?.name === "PENDING" && s.stage?.name === "PAUSED") return "WAITING_MANUAL";
  return s?.name ?? s?.type ?? "UNKNOWN";
}

const isDone = (step: PipelineStep): boolean => step.state?.name === "COMPLETED";
const stepKey = (step: PipelineStep, i: number): string => step.uuid ?? `${i}:${step.name ?? ""}`;
const quoted = (names: string[]): string => names.map((n) => `"${n}"`).join(", ");

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "?";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function pipelineUrl(workspace: string, repo: string, buildNumber: number | string): string {
  return `https://bitbucket.org/${workspace}/${repo}/pipelines/results/${buildNumber}`;
}

export function describeTarget(p: Pipeline): string {
  const t = p.target ?? {};
  let where: string;
  if (t.type === "pipeline_pullrequest_target") {
    where = `PR #${t.pullrequest?.id ?? "?"} ${t.source ?? "?"} → ${t.destination ?? "?"}`;
  } else if (t.ref_name) {
    where = t.ref_name;
  } else {
    where = t.commit?.hash?.slice(0, 12) ?? "?";
  }
  if (t.selector?.type === "custom" && t.selector.pattern) where += ` (custom: ${t.selector.pattern})`;
  return where;
}

const failedSteps = (steps: PipelineStep[]): string[] =>
  steps.filter((s) => ["FAILED", "ERROR"].includes(stepLabel(s))).map((s) => s.name ?? "?");

/** One line describing where a run stands; used for the first line of a watch.
 *  Names steps that already failed: on a re-arm, a step that failed while no
 *  follower was running gets no step line of its own. */
export function progressLine(tag: string, repo: string, p: Pipeline, steps: PipelineStep[]): string {
  const { label } = classifyPipeline(p.state);
  const done = steps.filter(isDone).length;
  const running = steps.filter((s) => s.state?.name === "IN_PROGRESS").map((s) => s.name ?? "?");
  const failed = failedSteps(steps);
  let line = `${tag} watching ${repo} @ ${describeTarget(p)} — ${label}, ${done}/${steps.length} steps done`;
  if (failed.length > 0) line += `, failed so far: ${quoted(failed)}`;
  if (running.length > 0) line += `, running: ${quoted(running)}`;
  return line;
}

/** The DONE line for a run that has reached a terminal state. */
export function doneLine(tag: string, p: Pipeline, steps: PipelineStep[], url: string): string {
  const { label } = classifyPipeline(p.state);
  if (label === "PAUSED") {
    const waiting = steps.filter((s) => stepLabel(s) === "WAITING_MANUAL").map((s) => s.name ?? "?");
    const done = steps.filter(isDone).length;
    const what = waiting.length > 0 ? `waiting for manual step ${quoted(waiting)}` : "waiting for a manual step";
    return `${tag} DONE PAUSED — ${done}/${steps.length} steps done, ${what} — ${url}`;
  }
  const stoppedBy = p.state?.result?.terminator?.display_name;
  let line = `${tag} DONE ${label}`;
  if (label === "STOPPED" && stoppedBy) line += ` by ${stoppedBy}`;
  line += ` after ${formatDuration(p.duration_in_seconds)}`;
  const failed = failedSteps(steps);
  if (failed.length > 0) line += ` — failed step${failed.length > 1 ? "s" : ""}: ${quoted(failed)}`;
  return `${line} — ${url}`;
}

/** Lines for steps that finished since the previous poll. */
export function stepEvents(tag: string, prev: Map<string, string>, steps: PipelineStep[]): string[] {
  const lines: string[] = [];
  steps.forEach((step, i) => {
    const label = stepLabel(step);
    if (isDone(step) && prev.get(stepKey(step, i)) !== label) {
      lines.push(`${tag} step "${step.name ?? "?"}" ${label} (${formatDuration(step.duration_in_seconds)})`);
    }
  });
  return lines;
}

const stepSnapshot = (steps: PipelineStep[]): Map<string, string> =>
  new Map(steps.map((s, i) => [stepKey(s, i), stepLabel(s)]));

/** POSIX single-quote one argument. Claude Code runs Monitor and Bash
 *  commands through a POSIX shell on every platform (Git Bash on Windows). */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface WatchCommandSpec {
  node: string;
  nodeArgs: string[];
  entry: string;
  workspace: string;
  repo: string;
  /** Build number, never the {uuid}: braces are shell syntax in some shells. */
  buildNumber: number | string;
  intervalSeconds?: number;
  /** Absolute give-up time (epoch seconds). Baked into the command so every
   *  re-arm of the same command shares one limit instead of restarting it. */
  deadlineEpochSeconds?: number;
}

export function buildWatchCommand(spec: WatchCommandSpec, platform: NodeJS.Platform = process.platform): string {
  // Git Bash accepts C:/… paths; backslashes inside its quotes are fragile.
  const path = (p: string): string => (platform === "win32" ? p.replace(/\\/g, "/") : p);
  const args = [
    path(spec.node),
    ...spec.nodeArgs,
    path(spec.entry),
    "watch-pipeline",
    "--workspace",
    spec.workspace,
    "--repo",
    spec.repo,
    "--pipeline",
    String(spec.buildNumber),
  ];
  if (spec.intervalSeconds !== undefined) args.push("--interval", String(spec.intervalSeconds));
  if (spec.deadlineEpochSeconds !== undefined) args.push("--deadline", String(spec.deadlineEpochSeconds));
  return args.map(shellQuote).join(" ");
}

export interface WatchDeps {
  get: <T>(path: string, query?: Query) => Promise<T>;
  emit: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface WatchOptions {
  workspace: string;
  repo: string;
  /** Build number or {uuid}. */
  pipeline: string;
  intervalMs: number;
  /** Absolute time (same clock as deps.now) after which the watch gives up. */
  deadlineMs: number;
}

export const WATCH_EXIT = { done: 0, error: 2, timeout: 3 } as const;

function describeError(err: any, opts: WatchOptions): string {
  const status: number | undefined = typeof err?.status === "number" ? err.status : undefined;
  if (status === 401) return "401 — Bitbucket rejected the credentials; re-run /atlassian-suite:as-init";
  if (status === 403) return "403 — these credentials can't read pipelines in this repo (token scope or repo access)";
  if (status === 404) return `404 — no pipeline ${opts.pipeline} in ${opts.workspace}/${opts.repo}`;
  const msg = err?.message ?? String(err);
  return status !== undefined ? `${status} — ${msg}` : msg;
}

/** Poll one run until it reaches a verdict. Returns the process exit code:
 *  0 when the run reached a terminal state (whatever the result), 2 when the
 *  watcher could not read it, 3 when it hit its own time cap. */
export async function runPipelineWatch(deps: WatchDeps, opts: WatchOptions): Promise<number> {
  const base = `/repositories/${opts.workspace}/${opts.repo}/pipelines/`;
  let tag = `[pipeline ${/^\d+$/.test(opts.pipeline) ? "#" : ""}${opts.pipeline}]`;
  let prevLabel: string | undefined;
  let prevSteps = new Map<string, string>();
  let failures = 0;

  for (;;) {
    let p: Pipeline | undefined;
    let steps: PipelineStep[] = [];
    try {
      p = await deps.get<Pipeline>(`${base}${encodeURIComponent(opts.pipeline)}`);
      const list = await deps.get<{ values?: PipelineStep[] }>(
        `${base}${encodeURIComponent(p.uuid ?? opts.pipeline)}/steps/`,
        { pagelen: 100 },
      );
      steps = Array.isArray(list?.values) ? list.values : [];
      failures = 0;
    } catch (err: any) {
      if (FATAL_STATUSES.has(err?.status)) {
        deps.emit(`${tag} WATCH_ERROR ${describeError(err, opts)}`);
        return WATCH_EXIT.error;
      }
      failures++;
      if (failures >= GIVE_UP_AFTER_FAILURES) {
        deps.emit(`${tag} WATCH_ERROR gave up after ${failures} failed polls in a row: ${describeError(err, opts)}`);
        return WATCH_EXIT.error;
      }
      if (failures === WARN_AFTER_FAILURES) {
        deps.emit(`${tag} warning: ${failures} polls failed in a row (${describeError(err, opts)}); still trying`);
      }
    }

    if (p) {
      if (p.build_number !== undefined) tag = `[pipeline #${p.build_number}]`;
      const url = pipelineUrl(opts.workspace, opts.repo, p.build_number ?? opts.pipeline);
      const { label, terminal } = classifyPipeline(p.state);
      if (prevLabel !== undefined) {
        for (const line of stepEvents(tag, prevSteps, steps)) deps.emit(line);
      }
      if (terminal) {
        deps.emit(doneLine(tag, p, steps, url));
        return WATCH_EXIT.done;
      }
      if (prevLabel === undefined) deps.emit(progressLine(tag, opts.repo, p, steps));
      else if (label !== prevLabel) deps.emit(`${tag} now ${label} (was ${prevLabel})`);
      prevLabel = label;
      prevSteps = stepSnapshot(steps);
    }

    if (deps.now() >= opts.deadlineMs) {
      const at = new Date(opts.deadlineMs).toISOString().slice(0, 16) + "Z";
      deps.emit(`${tag} WATCH_TIMEOUT still ${prevLabel ?? "unknown"} at the watch's time limit (${at}) — watch again to keep following it`);
      return WATCH_EXIT.timeout;
    }
    await deps.sleep(opts.intervalMs);
  }
}

/** Entry point for `server.js watch-pipeline …`. Writes events to stdout and
 *  sets process.exitCode rather than calling process.exit(), which can drop
 *  the final line when stdout is a pipe. */
export async function runPipelineWatchCli(argv: string[]): Promise<void> {
  const emit = (line: string): void => {
    process.stdout.write(line + "\n");
  };
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        workspace: { type: "string" },
        repo: { type: "string" },
        pipeline: { type: "string" },
        interval: { type: "string" },
        deadline: { type: "string" },
        "max-minutes": { type: "string" },
      },
      strict: true,
    }) as { values: Record<string, string | undefined> });
  } catch (err: any) {
    emit(`[pipeline ?] WATCH_ERROR bad arguments: ${err?.message ?? err}`);
    process.exitCode = WATCH_EXIT.error;
    return;
  }
  const tag = `[pipeline ${values.pipeline ?? "?"}]`;
  if (!values.repo || !values.pipeline) {
    emit(
      `${tag} WATCH_ERROR usage: watch-pipeline --repo <slug> --pipeline <build-number> [--workspace <ws>] ` +
        `[--interval <s>] [--deadline <epoch-seconds> | --max-minutes <m>]`,
    );
    process.exitCode = WATCH_EXIT.error;
    return;
  }
  const cfg = loadBitbucketConfig();
  if (!cfg) {
    emit(
      `${tag} WATCH_ERROR Bitbucket credentials not found in this shell. The watcher runs in your shell, ` +
        `not inside the MCP server, so env vars set only for the server don't reach it; store them with /atlassian-suite:as-init.`,
    );
    process.exitCode = WATCH_EXIT.error;
    return;
  }
  const http = createBitbucketHttp(cfg);
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, Number(values.interval) || DEFAULT_INTERVAL_SECONDS);
  const deadlineSeconds = Number(values.deadline);
  const deadlineMs = deadlineSeconds > 0
    ? deadlineSeconds * 1000
    : Date.now() + (Number(values["max-minutes"]) || DEFAULT_MAX_MINUTES) * 60_000;
  try {
    process.exitCode = await runPipelineWatch(
      {
        get: (path, query) => http.get(path, query),
        emit,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
      },
      {
        workspace: values.workspace || cfg.workspace,
        repo: values.repo,
        pipeline: values.pipeline,
        intervalMs: intervalSeconds * 1000,
        deadlineMs,
      },
    );
  } catch (err: any) {
    // A bug here must still end the watch with a line, not a stack trace on stderr.
    emit(`${tag} WATCH_ERROR watcher crashed: ${err?.message ?? err}`);
    process.exitCode = WATCH_EXIT.error;
  }
}
