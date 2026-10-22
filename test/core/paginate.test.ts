import { describe, expect, test } from "bun:test";
import { AtlError } from "../../src/core/errors.ts";
import {
  SAFETY_CAP,
  cursorFromNextLink,
  paginateConfluenceV1Search,
  paginateConfluenceV2,
  paginateJiraOffset,
  paginateJiraToken,
  type CursorRequest,
  type OffsetRequest,
} from "../../src/core/paginate.ts";

/** Serve `total` numbered items in cursor pages; cursors are the string start index. */
function cursorServer(total: number) {
  const requests: CursorRequest[] = [];
  const fetchPage = (request: CursorRequest) => {
    requests.push(request);
    const start = request.cursor === undefined ? 0 : Number(request.cursor);
    const end = Math.min(total, start + request.pageSize);
    const results = Array.from({ length: end - start }, (_, index) => start + index);
    return Promise.resolve({
      results,
      ...(end < total
        ? { _links: { next: `/wiki/api/v2/pages?limit=${request.pageSize}&cursor=${end}` } }
        : {}),
    });
  };
  return { requests, fetchPage };
}

/** A Confluence page whose next link always repeats the same cursor. */
function stuckCursorPage() {
  return Promise.resolve({ results: [1], _links: { next: "/x?cursor=same" } });
}

/** Serve `total` Jira issues via `nextPageToken`, signalling the end by `isLast` or a missing token. */
function tokenServer(total: number, mode: "isLast" | "noToken") {
  const requests: CursorRequest[] = [];
  const fetchPage = (request: CursorRequest) => {
    requests.push(request);
    const start = request.cursor === undefined ? 0 : Number(request.cursor.replace("t", ""));
    const end = Math.min(total, start + request.pageSize);
    const issues = Array.from({ length: end - start }, (_, index) => ({
      key: `K-${start + index}`,
    }));
    const last = end >= total;
    return Promise.resolve(
      mode === "isLast"
        ? { issues, nextPageToken: `t${end}`, isLast: last }
        : { issues, ...(last ? {} : { nextPageToken: `t${end}` }) },
    );
  };
  return { requests, fetchPage };
}

/** Serve `total` numbered values by offset, capping each page at `serverMax`. */
function offsetServer(total: number, serverMax: number, reportTotal: boolean) {
  const requests: OffsetRequest[] = [];
  const fetchPage = (request: OffsetRequest) => {
    requests.push(request);
    const size = Math.min(request.pageSize, serverMax);
    const end = Math.min(total, request.startAt + size);
    const values = Array.from(
      { length: Math.max(0, end - request.startAt) },
      (_, index) => request.startAt + index,
    );
    return Promise.resolve({
      startAt: request.startAt,
      maxResults: size,
      values,
      ...(reportTotal ? { total } : { isLast: end >= total }),
    });
  };
  return { requests, fetchPage };
}

describe("cursorFromNextLink", () => {
  test("extracts the cursor from relative and absolute links", () => {
    expect(cursorFromNextLink("/wiki/api/v2/pages?limit=25&cursor=abc%3D%3D")).toBe("abc==");
    expect(
      cursorFromNextLink("https://x.atlassian.net/wiki/rest/api/search?cursor=zz&next=true"),
    ).toBe("zz");
    expect(cursorFromNextLink()).toBeNull();
  });

  test("a next link without cursor is an internal error", () => {
    expect(() => cursorFromNextLink("/wiki/api/v2/pages?limit=25")).toThrow(AtlError);
  });
});

describe("paginateConfluenceV2", () => {
  test("follows _links.next up to the limit and returns the resume cursor", async () => {
    const { requests, fetchPage } = cursorServer(100);
    const result = await paginateConfluenceV2(
      { limit: 30, defaultLimit: 25, maxPageSize: 25 },
      fetchPage,
    );
    expect(result.items).toHaveLength(30);
    expect(result.items.at(-1)).toBe(29);
    expect(result.nextCursor).toBe("30");
    expect(result.truncated).toBeUndefined();
    expect(requests.map((r) => r.pageSize)).toEqual([25, 5]);
    expect(requests.map((r) => r.cursor)).toEqual([undefined, "25"]);
  });

  test("uses the default limit and reports exhaustion with a null cursor", async () => {
    const { fetchPage } = cursorServer(10);
    const result = await paginateConfluenceV2({ defaultLimit: 25, maxPageSize: 250 }, fetchPage);
    expect(result).toEqual({ items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], nextCursor: null });
  });

  test("exactly the limit with nothing more yields a null cursor", async () => {
    const { fetchPage } = cursorServer(25);
    const result = await paginateConfluenceV2({ defaultLimit: 25, maxPageSize: 25 }, fetchPage);
    expect(result.items).toHaveLength(25);
    expect(result.nextCursor).toBeNull();
  });

  test("resumes from a supplied cursor", async () => {
    const { requests, fetchPage } = cursorServer(10);
    const result = await paginateConfluenceV2(
      { cursor: "7", defaultLimit: 25, maxPageSize: 25 },
      fetchPage,
    );
    expect(requests[0]?.cursor).toBe("7");
    expect(result.items).toEqual([7, 8, 9]);
  });

  test("--all stops at the safety cap and reports truncated", async () => {
    const { requests, fetchPage } = cursorServer(5000);
    const result = await paginateConfluenceV2(
      { all: true, defaultLimit: 25, maxPageSize: 250 },
      fetchPage,
    );
    expect(SAFETY_CAP).toBe(1000);
    expect(result.items).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe("1000");
    expect(requests).toHaveLength(4);
  });

  test("--all with fewer items than the cap is not truncated", async () => {
    const { fetchPage } = cursorServer(300);
    const result = await paginateConfluenceV2(
      { all: true, defaultLimit: 25, maxPageSize: 250 },
      fetchPage,
    );
    expect(result.items).toHaveLength(300);
    expect(result.nextCursor).toBeNull();
    expect(result.truncated).toBeUndefined();
  });

  test("an explicit limit above the safety cap is clamped and truncated", async () => {
    const { fetchPage } = cursorServer(5000);
    const result = await paginateConfluenceV2(
      { limit: 3000, defaultLimit: 25, maxPageSize: 250 },
      fetchPage,
    );
    expect(result.items).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  test("rejects a non-positive limit as input error", async () => {
    const { fetchPage } = cursorServer(5);
    const error = await paginateConfluenceV2(
      { limit: 0, defaultLimit: 25, maxPageSize: 25 },
      fetchPage,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ category: "input" });
  });

  test("a server that repeats the cursor does not loop forever", async () => {
    const error = await paginateConfluenceV2(
      { all: true, defaultLimit: 25, maxPageSize: 25 },
      stuckCursorPage,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code: "pagination_stalled" });
  });
});

describe("paginateConfluenceV1Search", () => {
  test("follows _links.next cursors", async () => {
    const { fetchPage } = cursorServer(7);
    const result = await paginateConfluenceV1Search(
      { all: true, defaultLimit: 25, maxPageSize: 3 },
      fetchPage,
    );
    expect(result.items).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.nextCursor).toBeNull();
  });

  test("falls back to a top-level cursor when there is no next link", async () => {
    const pages = [{ results: ["a", "b"], cursor: "tok1" }, { results: ["c"] }];
    const seen: (string | undefined)[] = [];
    const result = await paginateConfluenceV1Search(
      { all: true, defaultLimit: 25, maxPageSize: 2 },
      (request) => {
        seen.push(request.cursor);
        return Promise.resolve(pages.shift() ?? { results: [] });
      },
    );
    expect(result.items).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([undefined, "tok1"]);
  });
});

describe("paginateJiraToken", () => {
  for (const mode of ["isLast", "noToken"] as const) {
    test(`stops on ${mode}`, async () => {
      const { fetchPage } = tokenServer(12, mode);
      const result = await paginateJiraToken(
        { all: true, defaultLimit: 25, maxPageSize: 5 },
        (page) => page.issues,
        fetchPage,
      );
      expect(result.items).toHaveLength(12);
      expect(result.nextCursor).toBeNull();
    });
  }

  test("limit caps items and returns nextPageToken as the cursor", async () => {
    const { requests, fetchPage } = tokenServer(100, "isLast");
    const result = await paginateJiraToken(
      { limit: 7, defaultLimit: 25, maxPageSize: 5 },
      (page) => page.issues,
      fetchPage,
    );
    expect(result.items.map((i) => i.key)).toEqual([
      "K-0",
      "K-1",
      "K-2",
      "K-3",
      "K-4",
      "K-5",
      "K-6",
    ]);
    expect(result.nextCursor).toBe("t7");
    expect(requests.map((r) => r.pageSize)).toEqual([5, 2]);
  });

  test("--all safety cap", async () => {
    const { fetchPage } = tokenServer(2500, "isLast");
    const result = await paginateJiraToken(
      { all: true, defaultLimit: 25, maxPageSize: 500 },
      (page) => page.issues,
      fetchPage,
    );
    expect(result.items).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe("t1000");
  });
});

describe("paginateJiraOffset", () => {
  test("advances by items returned even when the server caps page size below the request", async () => {
    const { requests, fetchPage } = offsetServer(23, 10, true);
    const result = await paginateJiraOffset(
      { all: true, defaultLimit: 25, maxPageSize: 50 },
      (page) => page.values,
      fetchPage,
    );
    expect(result.items).toHaveLength(23);
    expect(result.nextCursor).toBeNull();
    expect(requests.map((r) => r.startAt)).toEqual([0, 10, 20]);
  });

  test("uses isLast when total is absent", async () => {
    const { fetchPage } = offsetServer(8, 50, false);
    const result = await paginateJiraOffset(
      { all: true, defaultLimit: 25, maxPageSize: 50 },
      (page) => page.values,
      fetchPage,
    );
    expect(result.items).toHaveLength(8);
    expect(result.nextCursor).toBeNull();
  });

  test("limit returns the next startAt as the cursor, and it resumes", async () => {
    const { fetchPage } = offsetServer(50, 50, true);
    const first = await paginateJiraOffset(
      { limit: 20, defaultLimit: 25, maxPageSize: 50 },
      (page) => page.values,
      fetchPage,
    );
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe("20");
    const second = await paginateJiraOffset(
      { limit: 100, cursor: first.nextCursor ?? undefined, defaultLimit: 25, maxPageSize: 50 },
      (page) => page.values,
      fetchPage,
    );
    expect(second.items[0]).toBe(20);
    expect(second.items).toHaveLength(30);
    expect(second.nextCursor).toBeNull();
  });

  test("--all safety cap", async () => {
    const { fetchPage } = offsetServer(4000, 100, true);
    const result = await paginateJiraOffset(
      { all: true, defaultLimit: 25, maxPageSize: 100 },
      (page) => page.values,
      fetchPage,
    );
    expect(result.items).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe("1000");
  });

  test("an empty page ends iteration when neither total nor isLast is given", async () => {
    const pages = [[1, 2], [3], []];
    const result = await paginateJiraOffset(
      { all: true, defaultLimit: 25, maxPageSize: 2 },
      (page: { values: number[]; isLast?: boolean }) => page.values,
      () => Promise.resolve({ values: pages.shift() ?? [] }),
    );
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.nextCursor).toBeNull();
  });

  test("a malformed offset cursor is an input error", async () => {
    const pending = paginateJiraOffset(
      { cursor: "abc", defaultLimit: 5, maxPageSize: 5 },
      () => [],
      () => Promise.resolve({}),
    );
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code: "invalid_cursor" });
  });
});
