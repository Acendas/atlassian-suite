// Shared helpers for Bitbucket tool modules.

import type { BitbucketContext } from "./index.js";

export const workspaceOf = (ctx: BitbucketContext, override?: string): string =>
  (override && override.length > 0 ? override : ctx.workspace);

// Wraps tool execution to convert HTTP errors into MCP-friendly user errors.
export async function safeExecute<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    if (err?.name === "BitbucketHttpError") {
      return JSON.stringify(
        {
          error: true,
          status: err.status,
          message: err.message,
          body: err.body,
        },
        null,
        2,
      );
    }
    return JSON.stringify({ error: true, message: err?.message ?? String(err) }, null, 2);
  }
}

export function ensureWritable(ctx: BitbucketContext): void {
  if (ctx.readOnly) {
    throw new Error("READ_ONLY_MODE is enabled — write operations are blocked.");
  }
}
