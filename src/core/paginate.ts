import { AtlError } from "./errors.ts";
import { isRecord } from "./guards.ts";

/** Hard ceiling on items collected by one call, even with `--all`. */
export const SAFETY_CAP = 1000;

export interface PagePolicy {
  /** `--limit N`: total item cap. Ignored when `all` is set. */
  limit?: number | undefined;
  /** `--all`: no user cap, still bounded by SAFETY_CAP. */
  all?: boolean | undefined;
  /** Cap used when neither `limit` nor `all` is given. */
  defaultLimit: number;
  /** Resume token from a previous `nextCursor`. */
  cursor?: string | undefined;
  /** Largest page size the endpoint accepts. */
  maxPageSize: number;
}

export interface Paged<T> {
  items: T[];
  /** Token to continue from, or null when the result set is exhausted. */
  nextCursor: string | null;
  /** True only when the safety cap stopped collection while more items remained. */
  truncated?: true;
}

export interface CursorRequest {
  cursor: string | undefined;
  pageSize: number;
}

export interface OffsetRequest {
  startAt: number;
  pageSize: number;
}

interface Step<T> {
  items: readonly T[];
  next: string | null;
}

function requestedCap(policy: PagePolicy): number {
  if (policy.all === true) {
    return Number.POSITIVE_INFINITY;
  }
  const cap = policy.limit ?? policy.defaultLimit;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new AtlError(`--limit must be a positive integer, got ${String(cap)}`, {
      code: "invalid_limit",
      category: "input",
      hint: "Pass --limit N with N >= 1, or --all.",
    });
  }
  return cap;
}

async function drain<T>(
  policy: PagePolicy,
  fetchStep: (cursor: string | undefined, pageSize: number) => Promise<Step<T>>,
): Promise<Paged<T>> {
  const wanted = requestedCap(policy);
  const cap = Math.min(wanted, SAFETY_CAP);
  const items: T[] = [];
  let cursor = policy.cursor;
  let next: string | null = null;

  for (;;) {
    const remaining = cap - items.length;
    const step = await fetchStep(cursor, Math.min(policy.maxPageSize, remaining));
    items.push(...step.items.slice(0, remaining));
    next = step.next;
    if (next === null || items.length >= cap) {
      break;
    }
    if (next === cursor) {
      throw new AtlError("Pagination did not advance: server returned the same cursor", {
        code: "pagination_stalled",
        category: "internal",
      });
    }
    cursor = next;
  }

  const truncated = next !== null && items.length >= cap && wanted > SAFETY_CAP;
  return { items, nextCursor: next, ...(truncated ? { truncated: true as const } : {}) };
}

/** Extract the `cursor` query parameter from a relative or absolute `_links.next` URL. */
export function cursorFromNextLink(link?: string): string | null {
  if (link === undefined || link === "") {
    return null;
  }
  const cursor = new URL(link, "https://atlassian.invalid").searchParams.get("cursor");
  if (cursor === null) {
    throw new AtlError("Pagination link has no cursor parameter", {
      code: "pagination_link_invalid",
      category: "internal",
    });
  }
  return cursor;
}

/** Opaque cursor for client-side paging state (multi-source merges, local windows): base64url JSON. */
export function encodeStateCursor(state: object): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

/** Inverse of `encodeStateCursor`; `undefined` when the text is not such a cursor. */
export function decodeStateCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ConfluenceCursorPage<T> {
  results: readonly T[];
  _links?: { next?: string };
}

/** Confluence v2: follow `_links.next`, whose query carries the `cursor`. */
export function paginateConfluenceV2<T>(
  policy: PagePolicy,
  fetchPage: (request: CursorRequest) => Promise<ConfluenceCursorPage<T>>,
): Promise<Paged<T>> {
  return drain(policy, async (cursor, pageSize) => {
    const page = await fetchPage({ cursor, pageSize });
    return { items: page.results, next: cursorFromNextLink(page._links?.next) };
  });
}

export interface ConfluenceSearchPage<T> extends ConfluenceCursorPage<T> {
  /** Some v1 search responses carry the continuation token at the top level. */
  cursor?: string;
}

/** Confluence v1 search (`/wiki/rest/api/search`): `_links.next` cursor, else top-level `cursor`. */
export function paginateConfluenceV1Search<T>(
  policy: PagePolicy,
  fetchPage: (request: CursorRequest) => Promise<ConfluenceSearchPage<T>>,
): Promise<Paged<T>> {
  return drain(policy, async (cursor, pageSize) => {
    const page = await fetchPage({ cursor, pageSize });
    const linked = cursorFromNextLink(page._links?.next);
    return {
      items: page.results,
      next: linked ?? (page.cursor === undefined || page.cursor === "" ? null : page.cursor),
    };
  });
}

export interface JiraTokenPage {
  nextPageToken?: string | undefined;
  isLast?: boolean | undefined;
}

/** Jira `search/jql` style: continue with `nextPageToken` until `isLast` or no token. */
export function paginateJiraToken<P extends JiraTokenPage, T>(
  policy: PagePolicy,
  getItems: (page: P) => readonly T[],
  fetchPage: (request: CursorRequest) => Promise<P>,
): Promise<Paged<T>> {
  return drain(policy, async (cursor, pageSize) => {
    const page = await fetchPage({ cursor, pageSize });
    const more =
      page.isLast !== true && page.nextPageToken !== undefined && page.nextPageToken !== "";
    return { items: getItems(page), next: more ? (page.nextPageToken ?? null) : null };
  });
}

export interface JiraOffsetPage {
  startAt?: number | undefined;
  total?: number | undefined;
  isLast?: boolean | undefined;
}

/**
 * Jira `startAt`/`maxResults` style. The cursor is the next `startAt` as a string. Exhaustion is
 * `isLast`, `startAt + count >= total`, or an empty page; the count actually returned drives the
 * next offset because servers may return fewer items than requested.
 */
export function paginateJiraOffset<P extends JiraOffsetPage, T>(
  policy: PagePolicy,
  getItems: (page: P) => readonly T[],
  fetchPage: (request: OffsetRequest) => Promise<P>,
): Promise<Paged<T>> {
  return drain(policy, async (cursor, pageSize) => {
    const startAt = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(startAt) || startAt < 0) {
      throw new AtlError(`Invalid offset cursor: ${String(cursor)}`, {
        code: "invalid_cursor",
        category: "input",
        hint: "Pass the nextCursor value from a previous result.",
      });
    }
    const page = await fetchPage({ startAt, pageSize });
    const items = getItems(page);
    const end = startAt + items.length;
    const exhausted =
      items.length === 0 || page.isLast === true || (page.total !== undefined && end >= page.total);
    return { items, next: exhausted ? null : String(end) };
  });
}
