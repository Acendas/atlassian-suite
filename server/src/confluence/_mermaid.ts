// Mermaid -> SVG rendering for the Confluence publisher.
//
// Confluence has no native mermaid macro, so a ```mermaid fence has to become
// an image. The publisher previously required the caller to render diagrams
// themselves; this module renders them, without the plugin taking on a
// browser dependency of its own.
//
// The distinction that makes that possible: BUNDLING a renderer and USING one
// are different things. Bundling @mermaid-js/mermaid-cli means every install
// of this plugin downloads Chromium (~300MB) whether or not the user has a
// single diagram — and on Windows, a first-class target here, headless
// Chromium is exactly the kind of dependency that turns "install the plugin"
// into a support thread. But a machine that authors mermaid diagrams usually
// already has a renderer. So: detect, don't bundle.
//
// Backends, in strict preference order:
//
//   1. mermaid CLI (`mmdc`) on PATH, or MERMAID_CLI_PATH. Renders locally via
//      stdin->stdout, so no temp files and nothing leaves the machine.
//   2. A Kroki-compatible HTTP endpoint, ONLY when explicitly configured via
//      MERMAID_RENDER_URL. Meant for a self-hosted Kroki.
//   3. Nothing — fail with install instructions.
//
// There is deliberately no default public endpoint. Diagram sources are
// internal architecture: which services call which, what the data model is,
// what the deploy topology looks like. Silently POSTing that to a third party
// because a local renderer happened to be missing is not a fallback, it's a
// disclosure. Reaching a remote service requires the operator to name it.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type MermaidBackendKind = "cli" | "http";

export interface MermaidBackend {
  kind: MermaidBackendKind;
  /** Human-readable detail: resolved CLI path, or endpoint URL. */
  detail: string;
}

export interface MermaidOptions {
  /** Explicit CLI path. Defaults to MERMAID_CLI_PATH, then `mmdc` on PATH. */
  cliPath?: string;
  /** Kroki-compatible base URL. Defaults to MERMAID_RENDER_URL. Never public. */
  httpUrl?: string;
  theme?: "default" | "forest" | "dark" | "neutral";
  /** Background. "transparent" reads best on a Confluence page. */
  backgroundColor?: string;
  scale?: number;
  /** Passed through to mmdc as --puppeteerConfigFile. Needed in sandboxes and
   *  containers where Chromium requires --no-sandbox. */
  puppeteerConfigFile?: string;
  timeoutMs?: number;
}

export class MermaidRenderError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "MermaidRenderError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Stable hash of a diagram's source plus the options that affect its pixels.
 *  Rendering is the slow part of a publish (Chromium startup dominates), so a
 *  caller can cache on this and skip diagrams whose source did not change. */
export function diagramHash(source: string, opts: MermaidOptions = {}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        source: source.trim(),
        theme: opts.theme ?? "default",
        backgroundColor: opts.backgroundColor ?? "transparent",
        scale: opts.scale ?? 1,
      }),
    )
    .digest("hex");
}

/** Run a command with stdin, capturing stdout. Rejects on non-zero exit,
 *  spawn failure, or timeout — a renderer that hangs must not wedge a
 *  27-page publish. */
function runWithStdin(
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(new MermaidRenderError(`could not start ${cmd}: ${(err as Error).message}`));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MermaidRenderError(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MermaidRenderError(`could not start ${cmd}: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(Buffer.concat(outChunks).toString("utf8"));
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(
          new MermaidRenderError(
            `${cmd} exited ${code}${stderr ? `: ${stderr.slice(0, 800)}` : ""}`,
          ),
        );
      }
    });

    child.stdin?.on("error", () => {
      /* EPIPE when the child dies early — the close handler reports the real cause. */
    });
    child.stdin?.end(input);
  });
}

/** Is a mermaid CLI usable? Resolves to the backend, or null. */
export async function detectCli(opts: MermaidOptions = {}): Promise<MermaidBackend | null> {
  const cmd = opts.cliPath ?? process.env.MERMAID_CLI_PATH ?? "mmdc";
  try {
    const out = await runWithStdin(cmd, ["--version"], "", 15_000);
    return { kind: "cli", detail: `${cmd} (${out.trim() || "version unknown"})` };
  } catch {
    return null;
  }
}

/** Resolve which backend will be used, without rendering anything. */
export async function detectBackend(opts: MermaidOptions = {}): Promise<MermaidBackend | null> {
  const cli = await detectCli(opts);
  if (cli) return cli;
  const url = opts.httpUrl ?? process.env.MERMAID_RENDER_URL;
  if (url) return { kind: "http", detail: url };
  return null;
}

export const NO_BACKEND_HINT =
  "No mermaid renderer available. Either install the CLI (`npm i -g @mermaid-js/mermaid-cli`, " +
  "which provides `mmdc`), point MERMAID_CLI_PATH at an existing one, or set MERMAID_RENDER_URL " +
  "to a self-hosted Kroki-compatible endpoint. Alternatively render the SVGs in your own " +
  "toolchain and pass them via confluence_sync_attachments + asset_map.";

/** Render one diagram to SVG markup. */
export async function renderMermaidToSvg(
  source: string,
  opts: MermaidOptions = {},
): Promise<{ svg: string; backend: MermaidBackend }> {
  if (!source.trim()) throw new MermaidRenderError("empty mermaid source");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const cli = await detectCli(opts);
  if (cli) {
    const cmd = opts.cliPath ?? process.env.MERMAID_CLI_PATH ?? "mmdc";
    const args = ["-i", "-", "-o", "-", "-e", "svg"];
    args.push("-b", opts.backgroundColor ?? "transparent");
    if (opts.theme) args.push("-t", opts.theme);
    if (opts.scale) args.push("-s", String(opts.scale));
    const puppeteerConfig = opts.puppeteerConfigFile ?? process.env.MERMAID_PUPPETEER_CONFIG;
    if (puppeteerConfig) args.push("-p", puppeteerConfig);

    const svg = await runWithStdin(cmd, args, source, timeoutMs);
    if (!svg.includes("<svg")) {
      throw new MermaidRenderError(
        "mermaid CLI produced no SVG — the diagram source is probably invalid",
      );
    }
    return { svg: extractSvg(svg), backend: cli };
  }

  const url = opts.httpUrl ?? process.env.MERMAID_RENDER_URL;
  if (url) {
    const endpoint = url.replace(/\/+$/, "") + "/mermaid/svg";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: source,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new MermaidRenderError(
        `mermaid render endpoint ${endpoint} returned ${res.status}`,
        (await res.text().catch(() => "")).slice(0, 500) || undefined,
      );
    }
    const svg = await res.text();
    if (!svg.includes("<svg")) {
      throw new MermaidRenderError(`mermaid render endpoint ${endpoint} did not return SVG`);
    }
    return { svg: extractSvg(svg), backend: { kind: "http", detail: url } };
  }

  throw new MermaidRenderError("no mermaid renderer available", NO_BACKEND_HINT);
}

/** Trim anything the CLI prints around the SVG (progress lines, trailing
 *  newlines) so the attachment is a clean standalone SVG document. */
export function extractSvg(out: string): string {
  const start = out.indexOf("<svg");
  const endTag = out.lastIndexOf("</svg>");
  if (start === -1 || endTag === -1) return out.trim();
  return out.slice(start, endTag + "</svg>".length);
}
