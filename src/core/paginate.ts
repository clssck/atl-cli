import { AtlError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { type Writer, writeDiagnostic, writeStderr } from "./output.ts";

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

/** The one `invalid_cursor` error, so every paginator reports a bad `--cursor` the same way. */
function invalidCursor(cursor: string | undefined, detail?: string): AtlError {
  const suffix = detail === undefined ? "" : `: ${detail}`;
  return new AtlError(`Invalid --cursor ${String(cursor)}${suffix}`, {
    code: "invalid_cursor",
    category: "input",
    hint: "Pass the nextCursor value from a previous result unchanged, with the same query.",
  });
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
    let step: Step<T>;
    try {
      step = await fetchStep(cursor, Math.min(policy.maxPageSize, remaining));
    } catch (error) {
      // Cursors from the server are opaque, so a garbled `--cursor` surfaces only as the API's 400
      // (localized text, no hint); later cursors are server-made, so only the first page maps.
      if (
        cursor === policy.cursor &&
        cursor !== undefined &&
        error instanceof AtlError &&
        error.status === 400
      ) {
        throw invalidCursor(cursor, error.message);
      }
      throw error;
    }
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
  /** Total hits the server claims; compared with what came back to detect a short answer. */
  totalSize?: number;
}

/** Continuation of a Confluence v1 search page: `_links.next` cursor, else the top-level `cursor`. */
export function searchNextCursor(page: {
  _links?: { next?: string } | undefined;
  cursor?: string | undefined;
}): string | null {
  const linked = cursorFromNextLink(page._links?.next);
  return linked ?? (page.cursor === undefined || page.cursor === "" ? null : page.cursor);
}

/**
 * Confluence v1 search (`/wiki/rest/api/search`): `_links.next` cursor, else top-level `cursor`.
 * Under load the index sometimes answers a page with no results (even `totalSize: 0`), or fewer
 * than `totalSize` and no next link, and the same request moments later succeeds. Such a page is
 * requested once more; if it is still short the result is returned with a `search_incomplete`
 * warning instead of passing as complete. The expected total is the largest `totalSize` any page
 * reported; after a resumed `--cursor` the offset is unknown, so only an empty page is retried.
 */
export function paginateConfluenceV1Search<T>(
  policy: PagePolicy,
  fetchPage: (request: CursorRequest) => Promise<ConfluenceSearchPage<T>>,
  stderr: Writer = writeStderr,
): Promise<Paged<T>> {
  let seen = 0;
  let expected = 0;
  return drain(policy, async (cursor, pageSize) => {
    const lacksTotal = (page: ConfluenceSearchPage<T>): boolean =>
      policy.cursor === undefined && seen + page.results.length < expected;
    const fetchChecked = async (): Promise<ConfluenceSearchPage<T>> => {
      const page = await fetchPage({ cursor, pageSize });
      expected = Math.max(expected, page.totalSize ?? 0);
      return page;
    };

    let page = await fetchChecked();
    let next = searchNextCursor(page);
    if (next === null && (page.results.length === 0 || lacksTotal(page))) {
      const again = await fetchChecked();
      const againNext = searchNextCursor(again);
      if (again.results.length > page.results.length || againNext !== null) {
        page = again;
        next = againNext;
      }
    }
    if (next === null && lacksTotal(page)) {
      writeDiagnostic(
        {
          type: "warning",
          code: "search_incomplete",
          message: `Confluence search returned ${seen + page.results.length} of ${expected} results with no next page`,
          totalSize: expected,
          returned: seen + page.results.length,
          hint: "The search index answered inconsistently; rerun the query to get the rest.",
        },
        stderr,
      );
    }
    seen += page.results.length;
    return { items: page.results, next };
  });
}

export interface JiraTokenPage {
  nextPageToken?: string | undefined;
  isLast?: boolean | undefined;
}

/** Continuation of a Jira token page (`search/jql` style): its `nextPageToken`, or null on the last page. */
export function nextPageToken(page: JiraTokenPage): string | null {
  const more =
    page.isLast !== true && page.nextPageToken !== undefined && page.nextPageToken !== "";
  return more ? (page.nextPageToken ?? null) : null;
}

/** Jira `search/jql` style: continue with `nextPageToken` until `isLast` or no token. */
export function paginateJiraToken<P extends JiraTokenPage, T>(
  policy: PagePolicy,
  getItems: (page: P) => readonly T[],
  fetchPage: (request: CursorRequest) => Promise<P>,
): Promise<Paged<T>> {
  return drain(policy, async (cursor, pageSize) => {
    const page = await fetchPage({ cursor, pageSize });
    return { items: getItems(page), next: nextPageToken(page) };
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
      throw invalidCursor(cursor);
    }
    const page = await fetchPage({ startAt, pageSize });
    const items = getItems(page);
    const end = startAt + items.length;
    const exhausted =
      items.length === 0 || page.isLast === true || (page.total !== undefined && end >= page.total);
    return { items, next: exhausted ? null : String(end) };
  });
}
