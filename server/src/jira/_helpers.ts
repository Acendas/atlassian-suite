// Shared helpers for Jira tool modules.

export async function safeJira<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status;
    const body = err?.response?.data ?? err?.body;
    return JSON.stringify(
      {
        error: true,
        status: status ?? null,
        message: err?.message ?? String(err),
        body: body ?? null,
      },
      null,
      2,
    );
  }
}

export function ensureWritable(readOnly: boolean): void {
  if (readOnly) throw new Error("READ_ONLY_MODE is enabled — write operations are blocked.");
}
