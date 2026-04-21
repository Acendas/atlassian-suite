// Shared helpers for Confluence tool modules.
//
// Includes:
//   - safeConfluence: error-wrapping for MCP tool execute() functions.
//   - ensureWritable: READ_ONLY_MODE guard.
//   - buildConfluenceBody  — v1 nested body shape (atlas_doc_format/storage/wiki).
//   - buildConfluenceBodyV2 — v2 flat body shape ({representation, value}).
//   - Projection types (PageProjection, CommentProjection, etc.) + mappers
//     (toPageProjection, toCommentProjection, etc.) so tools return a
//     stable shape regardless of whether the call hit v1 or v2. Skills
//     never see raw API responses.

import { markdownToAdf, assertValidAdf } from "../common/adf.js";
import { classifyConfluenceError } from "../common/confluenceErrors.js";

// ---------------------------------------------------------------------------
// Tool-execution safety

/** Wraps a tool implementation. On success, returns stringified result
 *  (what the MCP transport expects). On failure, returns a structured
 *  error payload including the classified error kind so the calling
 *  agent can reason about the failure. */
export async function safeConfluence<T>(fn: () => Promise<T>): Promise<string> {
  try {
    const result = await fn();
    return JSON.stringify(result, null, 2);
  } catch (err: unknown) {
    const info = classifyConfluenceError(err);
    return JSON.stringify(
      {
        error: true,
        kind: info.kind,
        status: info.status || null,
        message: info.message,
        body: info.body ?? null,
      },
      null,
      2,
    );
  }
}

export function ensureWritable(readOnly: boolean): void {
  if (readOnly) throw new Error("READ_ONLY_MODE is enabled — write operations are blocked.");
}

// ---------------------------------------------------------------------------
// Body builders

export type Representation = "atlas_doc_format" | "storage" | "wiki" | "view";

/** v1 body shape — nested map of { atlas_doc_format | storage | wiki }.
 *  Used for v1 fallback endpoints (attachment upload, etc). v2 uses a
 *  different flat shape — prefer buildConfluenceBodyV2 for v2 endpoints. */
export function buildConfluenceBody(opts: {
  body_adf?: unknown;
  body_storage?: string;
  body_wiki?: string;
  body_markdown?: string;
  bodyMarkdown?: string;
  bodyRaw?: string;
  representation?: Representation;
}): {
  atlas_doc_format?: { value: string; representation: "atlas_doc_format" };
  storage?: { value: string; representation: "storage" };
  wiki?: { value: string; representation: "wiki" };
} {
  if (opts.body_adf !== undefined) {
    const adf = assertValidAdf(opts.body_adf, "body_adf");
    return {
      atlas_doc_format: {
        value: JSON.stringify(adf),
        representation: "atlas_doc_format",
      },
    };
  }
  if (opts.body_storage !== undefined) {
    return { storage: { value: opts.body_storage, representation: "storage" } };
  }
  if (opts.body_wiki !== undefined) {
    return { wiki: { value: opts.body_wiki, representation: "wiki" } };
  }
  const repr = opts.representation;
  if (repr === "storage") {
    return {
      storage: { value: opts.bodyRaw ?? opts.bodyMarkdown ?? "", representation: "storage" },
    };
  }
  if (repr === "wiki") {
    return {
      wiki: { value: opts.bodyRaw ?? opts.bodyMarkdown ?? "", representation: "wiki" },
    };
  }
  const md = opts.body_markdown ?? opts.bodyMarkdown ?? opts.bodyRaw ?? "";
  return {
    atlas_doc_format: {
      value: JSON.stringify(markdownToAdf(md)),
      representation: "atlas_doc_format",
    },
  };
}

/** v2 flat body shape — `{representation, value}`. Used on POST /pages,
 *  PUT /pages/{id}, POST /footer-comments, POST /inline-comments, etc.
 *  Priority order mirrors v1 builder. */
export function buildConfluenceBodyV2(opts: {
  body_adf?: unknown;
  body_storage?: string;
  body_wiki?: string;
  body_markdown?: string;
}): { representation: "atlas_doc_format" | "storage" | "wiki"; value: string } {
  if (opts.body_adf !== undefined) {
    const adf = assertValidAdf(opts.body_adf, "body_adf");
    return { representation: "atlas_doc_format", value: JSON.stringify(adf) };
  }
  if (opts.body_storage !== undefined) {
    return { representation: "storage", value: opts.body_storage };
  }
  if (opts.body_wiki !== undefined) {
    return { representation: "wiki", value: opts.body_wiki };
  }
  const md = opts.body_markdown ?? "";
  return {
    representation: "atlas_doc_format",
    value: JSON.stringify(markdownToAdf(md)),
  };
}

// ---------------------------------------------------------------------------
// Stable projections — what tools return, what skills consume.
//
// These are narrower than the raw API responses on purpose. Skills don't
// need "link _expandable" or "_links.base" — just the meaningful fields.
// If a caller really needs the full response, use body-format=raw and the
// dedicated get* tools that return richer shapes — but today, no skill
// does that.

export interface BodyPayload {
  representation: string;
  value: string;
}

export interface PageProjection {
  id: string;
  type: "page";
  title: string;
  spaceId?: string;
  parentId?: string | null;
  status?: string;
  authorId?: string;
  createdAt?: string;
  versionNumber?: number;
  position?: number;
  body?: BodyPayload | null;
  webui?: string;
}

export interface SpaceProjection {
  id: string;
  key: string;
  name: string;
  type?: string;
  status?: string;
  homepageId?: string;
  description?: string | null;
  webui?: string;
}

export interface CommentProjection {
  id: string;
  type: "footer" | "inline";
  pageId?: string;
  parentCommentId?: string | null;
  authorId?: string;
  createdAt?: string;
  versionNumber?: number;
  resolved?: boolean;
  textSelection?: string | null;
  body?: BodyPayload | null;
  webui?: string;
}

export interface AttachmentProjection {
  id: string;
  title: string;
  mediaType?: string;
  fileSize?: number;
  fileId?: string;
  pageId?: string;
  versionNumber?: number;
  downloadLink?: string;
  webui?: string;
}

export interface VersionProjection {
  number: number;
  authorId?: string;
  createdAt?: string;
  minorEdit?: boolean;
  message?: string;
}

export interface UserProjection {
  accountId: string;
  accountType?: string;
  displayName?: string;
  email?: string | null;
  publicName?: string;
  profilePicture?: string;
}

export interface LabelProjection {
  id?: string;
  name: string;
  prefix?: string;
}

// ---------------------------------------------------------------------------
// Mappers — raw v2/v1 responses → projections.

type AnyObj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): AnyObj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as AnyObj) : undefined;

/** Extract first non-null body payload from either v2's flat structure
 *  (body.storage / body.atlas_doc_format / body.view — each is
 *  {value, representation}) or v1's same nested shape. */
function extractBody(raw: unknown): BodyPayload | null {
  const b = obj(raw);
  if (!b) return null;
  for (const key of ["storage", "atlas_doc_format", "view", "export_view", "wiki"]) {
    const r = obj(b[key]);
    if (r && typeof r.value === "string") {
      return { representation: r.representation as string ?? key, value: r.value };
    }
  }
  return null;
}

export function toPageProjection(raw: unknown): PageProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  const version = obj(r.version);
  const webuiLink = obj(obj(r._links)?.webui) ? String(obj(r._links)!.webui) : str((obj(r._links) ?? {}).webui);
  return {
    id: String(r.id ?? ""),
    type: "page",
    title: str(r.title) ?? "",
    spaceId: str(r.spaceId) ?? str(obj(r.space)?.key) ?? str(obj(r.space)?.id),
    parentId: str(r.parentId) ?? null,
    status: str(r.status),
    authorId: str(r.authorId) ?? str(obj(r.history)?.createdBy && obj(obj(r.history)!.createdBy)?.accountId),
    createdAt: str(r.createdAt) ?? str(obj(r.history)?.createdDate),
    versionNumber: num(version?.number) ?? num(r.version) ?? undefined,
    position: num(r.position),
    body: extractBody(r.body),
    webui: webuiLink,
  };
}

export function toSpaceProjection(raw: unknown): SpaceProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  const desc = obj(r.description);
  return {
    id: String(r.id ?? ""),
    key: str(r.key) ?? "",
    name: str(r.name) ?? "",
    type: str(r.type),
    status: str(r.status),
    homepageId: str(r.homepageId) ?? str(obj(r.homepage)?.id),
    description: desc && typeof desc.plain === "object"
      ? str(obj(desc.plain)?.value)
      : str(r.description as string),
    webui: str(obj(r._links)?.webui),
  };
}

export function toCommentProjection(raw: unknown, kind: "footer" | "inline"): CommentProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  const version = obj(r.version);
  const inlineProps = obj(r.inlineCommentProperties);
  const textSel = obj(inlineProps?.textSelection);
  return {
    id: String(r.id ?? ""),
    type: kind,
    pageId: str(r.pageId) ?? str(obj(r.container)?.id),
    parentCommentId: str(r.parentCommentId) ?? null,
    authorId: str(r.authorId) ?? str(obj(r.version)?.authorId),
    createdAt: str(r.createdAt) ?? str(version?.createdAt),
    versionNumber: num(version?.number),
    resolved: typeof r.resolved === "boolean" ? r.resolved : undefined,
    textSelection: str(inlineProps?.textSelectionMatchCount) ?? str(textSel?.selection) ?? null,
    body: extractBody(r.body),
  };
}

export function toAttachmentProjection(raw: unknown): AttachmentProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  const links = obj(r._links) ?? {};
  return {
    id: String(r.id ?? ""),
    title: str(r.title) ?? "",
    mediaType: str(r.mediaType) ?? str(obj(r.extensions)?.mediaType),
    fileSize: num(r.fileSize) ?? num(obj(r.extensions)?.fileSize),
    fileId: str(r.fileId),
    pageId: str(r.pageId),
    versionNumber: num(obj(r.version)?.number),
    downloadLink: str(links.download) ?? str(r.downloadLink),
    webui: str(links.webui),
  };
}

export function toVersionProjection(raw: unknown): VersionProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  return {
    number: num(r.number) ?? 0,
    authorId: str(r.authorId) ?? str(obj(r.by)?.accountId),
    createdAt: str(r.createdAt) ?? str(r.when),
    minorEdit: typeof r.minorEdit === "boolean" ? r.minorEdit : undefined,
    message: str(r.message),
  };
}

export function toUserProjection(raw: unknown): UserProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  return {
    accountId: String(r.accountId ?? ""),
    accountType: str(r.accountType),
    displayName: str(r.displayName) ?? str(r.publicName),
    email: str(r.email) ?? (r.email === null ? null : str(r.emailAddress)) ?? null,
    publicName: str(r.publicName),
    profilePicture: str(obj(r.profilePicture)?.path),
  };
}

export function toLabelProjection(raw: unknown): LabelProjection {
  const r = (obj(raw) ?? {}) as AnyObj;
  return {
    id: str(r.id),
    name: str(r.name) ?? str(r.label) ?? "",
    prefix: str(r.prefix),
  };
}

// ---------------------------------------------------------------------------
// Pagination — v2 response shape {results: [...], _links: {next: "..."}}.

export interface PagedResponse<T> {
  results: T[];
  _links?: { next?: string; base?: string };
}

/** Extract the opaque cursor value from a v2 `_links.next` URL (or return
 *  null if the response has no next page). Returned cursor can be passed
 *  back into the same endpoint's `cursor` query param to fetch the next
 *  page. */
export function extractNextCursor(resp: PagedResponse<unknown> | undefined): string | null {
  const next = resp?._links?.next;
  if (!next) return null;
  try {
    const url = new URL(next, "https://dummy.example");
    return url.searchParams.get("cursor");
  } catch {
    return null;
  }
}
