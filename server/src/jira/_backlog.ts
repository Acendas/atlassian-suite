// Pure helpers behind the backlog-ordering and issue-edit tools. Kept free of
// client calls so the request shapes can be unit-tested (see _backlog.test.ts).

/** Jira Agile bulk endpoints (rank, move-to-backlog, move-to-sprint) cap at 50 issues. */
export const AGILE_BULK_MAX = 50;

/**
 * Prefix a JQL query with `project in (...)`, keeping any trailing ORDER BY
 * outside the parentheses. JQL rejects `ORDER BY` inside a parenthesised
 * clause, so naive wrapping breaks every ordered query (e.g. `ORDER BY Rank`)
 * for anyone with JIRA_PROJECTS_FILTER set.
 */
export function scopeJql(jql: string, projects: string[] | undefined): string {
  if (!projects || projects.length === 0) return jql;
  const scope = `project in (${projects.map((p) => `"${p}"`).join(",")})`;
  // ORDER BY must be the last clause, so split on the LAST match — a quoted
  // "order by" inside a text search comes earlier.
  const matches = [...jql.matchAll(/\border\s+by\b/gi)];
  const m = matches.at(-1);
  const where = (m ? jql.slice(0, m.index) : jql).trim();
  const orderBy = m ? " " + jql.slice(m.index).trim() : "";
  return (where ? `${scope} AND (${where})` : scope) + orderBy;
}

/**
 * Validate a rank/move request: 1–50 issues, exactly one anchor (or none when
 * `anchorOptional`), and the anchor must not be one of the issues being moved.
 * Checked in `execute` rather than via `.refine()` so the tool's top-level
 * JSON Schema stays a plain object.
 */
export function assertRankRequest(
  issues: string[],
  before: string | undefined,
  after: string | undefined,
  anchorOptional = false,
): void {
  if (issues.length === 0) throw new Error("issue_keys must contain at least one issue.");
  if (issues.length > AGILE_BULK_MAX) {
    throw new Error(
      `Jira ranks at most ${AGILE_BULK_MAX} issues per call; got ${issues.length}. Split into batches, ` +
        `anchoring each batch after the last issue of the previous one.`,
    );
  }
  if (before && after) throw new Error("Pass rank_before_issue OR rank_after_issue, not both.");
  if (!before && !after && !anchorOptional) {
    throw new Error("Pass rank_before_issue or rank_after_issue — the issue to rank relative to.");
  }
  const anchor = (before ?? after)?.toUpperCase();
  if (anchor && issues.some((k) => k.toUpperCase() === anchor)) {
    throw new Error(`Anchor ${anchor} is also in issue_keys; an issue cannot be ranked relative to itself.`);
  }
}

export interface RankOutcome {
  ok: boolean;
  ranked: string[];
  failed: Array<{ issue: string; status?: number; errors: string[] }>;
  anchor: { before?: string; after?: string };
}

/**
 * Normalise the rank endpoint's response. Success is 204 (empty body); a
 * partial failure is 207 with `entries[]` carrying per-issue status/errors.
 * axios does not throw on 207, so without this a partly failed rank would be
 * reported as success.
 */
export function summarizeRank(
  issues: string[],
  response: unknown,
  anchor: { before?: string; after?: string },
): RankOutcome {
  const entries = (response as { entries?: unknown[] } | null | undefined)?.entries;
  if (!Array.isArray(entries)) return { ok: true, ranked: [...issues], failed: [], anchor };
  const failed: RankOutcome["failed"] = [];
  const failedKeys = new Set<string>();
  for (const e of entries as Array<Record<string, any>>) {
    const status = typeof e.status === "number" ? e.status : undefined;
    const errors: string[] = Array.isArray(e.errors) ? e.errors.map(String) : [];
    if ((status !== undefined && status >= 300) || errors.length > 0) {
      const issue = String(e.issueKey ?? e.issueId ?? "unknown");
      failed.push({ issue, status, errors });
      failedKeys.add(issue.toUpperCase());
      if (e.issueId !== undefined) failedKeys.add(String(e.issueId));
    }
  }
  const ranked = issues.filter((k) => !failedKeys.has(k.toUpperCase()));
  return { ok: failed.length === 0, ranked, failed, anchor };
}

export interface IssueEditArgs {
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  components?: string[];
  add_components?: string[];
  remove_components?: string[];
  parent_key?: string;
}

/**
 * Build the `fields` + `update` parts of an issue edit for labels, components
 * and parent. `labels`/`components` replace the whole list (fields); the
 * add_/remove_ variants are incremental (update ops). Jira rejects an edit that
 * sets the same field in both, so mixing the two forms is refused up front.
 */
export function buildIssueEditOps(args: IssueEditArgs): {
  fields: Record<string, unknown>;
  update: Record<string, unknown[]>;
} {
  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown[]> = {};

  const incremental = (
    field: "labels" | "components",
    replace: string[] | undefined,
    add: string[] | undefined,
    remove: string[] | undefined,
    wrap: (v: string) => unknown,
  ) => {
    const hasOps = (add?.length ?? 0) > 0 || (remove?.length ?? 0) > 0;
    if (replace !== undefined && hasOps) {
      throw new Error(
        `Pass either ${field} (replaces the whole list) or add_${field}/remove_${field} (incremental), not both.`,
      );
    }
    if (replace !== undefined) fields[field] = replace.map(wrap);
    if (hasOps) {
      update[field] = [
        ...(add ?? []).map((v) => ({ add: wrap(v) })),
        ...(remove ?? []).map((v) => ({ remove: wrap(v) })),
      ];
    }
  };

  incremental("labels", args.labels, args.add_labels, args.remove_labels, (v) => v);
  incremental("components", args.components, args.add_components, args.remove_components, (name) => ({ name }));
  if (args.parent_key !== undefined) fields.parent = { key: args.parent_key };
  return { fields, update };
}

/** Fields a PO needs in a backlog/search listing (size, release and epic included). */
export const BACKLOG_FIELDS = [
  "summary",
  "status",
  "assignee",
  "priority",
  "issuetype",
  "parent",
  "fixVersions",
  "labels",
  "updated",
];

/** Pull the board's estimation (story points) field id out of a board configuration. */
export function estimationFieldId(boardConfig: unknown): string | undefined {
  const id = (boardConfig as any)?.estimation?.field?.fieldId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
