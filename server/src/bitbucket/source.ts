// Bitbucket source tree browsing + blame.
//
// The existing get_file_contents tool fetches a single file's text. These
// two tools are the missing investigation primitives:
//
//   list_source_tree(repo, commit, path)
//     GET /repositories/{ws}/{repo}/src/{commit}/{path}/
//     Returns directory listing — files + subdirectories — at a given
//     commit. Without this you can't explore a repo without cloning it.
//
//   get_blame(repo, commit, path)
//     GET /repositories/{ws}/{repo}/src/{commit}/{path}?annotate=true
//     Returns per-line annotations: which commit last touched each line,
//     who authored it, when. The "who wrote this line" primitive.
//
// Bitbucket's /src/{commit}/{path}/ endpoint quirks:
//   - trailing slash matters: foo/bar/ lists the dir, foo/bar gets the file
//   - `commit` can be a branch name, tag, or SHA
//   - the default (no annotate param) returns raw file content for files
//     or a paginated list for directories — the endpoint is overloaded by
//     path-semantics.

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { BitbucketContext } from "./index.js";
import { safeExecute, workspaceOf } from "./_helpers.js";

export function registerSourceTools(server: FastMCP, ctx: BitbucketContext): void {
  const srcBase = (workspace: string | undefined, repo: string, commit: string): string =>
    `/repositories/${workspaceOf(ctx, workspace)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(commit)}`;

  // Resolve the default branch name for a repo when the caller passed
  // "HEAD" or left commit empty. Bitbucket exposes this on the repo
  // metadata as mainbranch.name. One extra call, but avoids "which branch
  // is the default?" guessing (some repos use main, others master, some
  // use develop).
  const resolveCommit = async (
    workspace: string | undefined,
    repo: string,
    commit: string,
  ): Promise<string> => {
    if (commit && commit !== "HEAD" && commit !== "") return commit;
    const ws = workspaceOf(ctx, workspace);
    const meta = await ctx.http.get<{ mainbranch?: { name?: string } }>(
      `/repositories/${ws}/${encodeURIComponent(repo)}`,
    );
    return meta?.mainbranch?.name || "main";
  };

  // ---------------- List directory contents ----------------

  server.addTool({
    name: "list_source_tree",
    description:
      "List files + subdirectories at a path in a Bitbucket repo at a given commit (or branch/tag). Lets you browse the repo without cloning. Returns paginated `values[]` with {type, path, size, commit, mimetype} per entry.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z
        .string()
        .default("HEAD")
        .describe(
          "Commit SHA, branch name, or tag name. e.g. 'main', 'abc123', 'v1.4.0'. Default 'HEAD' = the repo's default branch (auto-resolved).",
        ),
      path: z
        .string()
        .default("")
        .describe("Path within the repo. Empty string means root. No leading slash."),
      pagelen: z.number().int().min(1).max(100).optional(),
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("If set, Bitbucket returns a flat recursive listing up to this depth"),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      commit: string;
      path: string;
      pagelen?: number;
      max_depth?: number;
      workspace?: string;
    }) =>
      safeExecute(async () => {
        const commit = await resolveCommit(args.workspace, args.repo_slug, args.commit);
        // Trailing slash forces dir-listing semantics even if path matches
        // a file. For empty path we just hit .../src/{commit}/ which
        // enumerates the repo root.
        const normalised = args.path.replace(/^\/+|\/+$/g, "");
        const pathPart = normalised ? `/${normalised}/` : "/";
        const url = `${srcBase(args.workspace, args.repo_slug, commit)}${pathPart}`;
        const query: Record<string, string | number> = {
          pagelen: args.pagelen ?? 50,
        };
        if (args.max_depth != null) query.max_depth = args.max_depth;
        return ctx.http.get(url, query);
      }),
  });

  // ---------------- Blame (per-line annotation) ----------------

  server.addTool({
    name: "get_file_blame",
    description:
      "Get per-line blame annotations for a file — which commit + author last modified each line. Use for 'who wrote this' investigation. Returns `values[]` where each entry has {commit, path, hunks:[{lines:[...]}]}.",
    parameters: z.object({
      repo_slug: z.string(),
      commit: z
        .string()
        .default("HEAD")
        .describe(
          "Commit SHA, branch name, or tag name. Default 'HEAD' = default branch.",
        ),
      path: z.string().describe("File path within the repo. No leading slash."),
      workspace: z.string().optional(),
    }),
    execute: async (args: {
      repo_slug: string;
      commit: string;
      path: string;
      workspace?: string;
    }) =>
      safeExecute(async () => {
        const commit = await resolveCommit(args.workspace, args.repo_slug, args.commit);
        const normalised = args.path.replace(/^\/+/, "");
        const url = `${srcBase(args.workspace, args.repo_slug, commit)}/${normalised}`;
        return ctx.http.get(url, { annotate: true });
      }),
  });
}
