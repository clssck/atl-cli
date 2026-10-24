import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentGet,
  attachmentList,
  confluenceCommands,
  confluenceDeps,
  commentGet,
  commentReplies,
  commentList,
  commentVersions,
  cql,
  pageAncestors,
  pageChildren,
  pageDiff,
  pageGet,
  pageOperations,
  pagePermissionsList,
  pageProperties,
  pageRestriction,
  pageVersions,
  pageLabels,
  pageTree,
  spaceGet,
  spaceList,
  spacePages,
  spacePersonal,
} from "../../src/commands/confluence.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { makeContext } from "../helpers/context.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { prune, sourceMarkdown } from "../../src/core/output.ts";

interface Call {
  url: URL;
}

let configDir: string;
let calls: Call[] = [];
let routes: Map<string, unknown> = new Map();
let handlers: Map<string, (url: URL) => unknown> = new Map();

function adf(text: string): string {
  return JSON.stringify({
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

/** Routes are keyed by path (after `/wiki`), without the query string. */
function route(path: string, body: unknown): void {
  routes.set(path, body);
}

/** A route whose body depends on the request, e.g. its `version` query. */
function routeBy(path: string, handler: (url: URL) => unknown): void {
  handlers.set(path, handler);
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "atl-confluence-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      sites: {
        "acme.atlassian.net": {
          cloudId: "cloud-1",
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["read:page:confluence"],
          cachedAt: "2026-10-01T00:00:00Z",
        },
      },
    }),
  );
  confluenceDeps.fetch = (input) => {
    const url = new URL(input);
    calls.push({ url });
    const path = url.pathname.replace("/ex/confluence/cloud-1/wiki", "");
    const handler = handlers.get(path);
    const body = handler === undefined ? routes.get(path) : handler(url);
    if (body instanceof Response) {
      return Promise.resolve(body);
    }
    if (body === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: `no route ${path}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
});

afterEach(() => {
  calls = [];
  routes = new Map();
  handlers = new Map();
});

afterAll(async () => {
  confluenceDeps.fetch = undefined;
  await rm(configDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return makeContext({ ATL_CONFIG_DIR: configDir, ATL_ACCESS_TOKEN: "test-token" }, overrides);
}

/** Run a command with flags typed loosely; the runtime normally validates them. */
function run(
  spec: CommandSpec,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  context: CommandContext = ctx(),
): Promise<unknown> {
  // The parser delivers a variadic positional in `rest`; tests name it like any other argument.
  const variadic = spec.args.find((arg) => arg.variadic === true)?.name;
  const values = variadic === undefined ? undefined : args[variadic];
  return spec.run(context, { args, rest: values === undefined ? [] : [values], flags });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected an object");
  }
  return value;
}

function itemsOf(result: unknown): unknown[] {
  const { items } = asRecord(result);
  if (!Array.isArray(items)) {
    throw new Error("expected an items array");
  }
  return items;
}

async function rejection(promise: Promise<unknown>): Promise<AtlError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AtlError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected rejection");
}

function lastQuery(): URLSearchParams {
  const last = calls.at(-1);
  if (last === undefined) {
    throw new Error("no request made");
  }
  return last.url.searchParams;
}

const PAGE = {
  id: "123456",
  status: "current",
  title: "Runbook",
  spaceId: "98765",
  parentId: "100",
  authorId: "acc-author",
  createdAt: "2026-01-02T03:04:05.000Z",
  version: { number: 4, createdAt: "2026-02-03T04:05:06.000Z", authorId: "acc-editor" },
  body: {
    atlas_doc_format: { representation: "atlas_doc_format", value: adf("Hello world") },
    storage: { representation: "storage", value: "<p>Hello <b>world</b></p>" },
  },
  _links: { webui: "/spaces/ENG/pages/123456/Runbook", base: "https://acme.atlassian.net/wiki" },
};

describe("confluenceCommands", () => {
  test("exposes every read command with no side effects", () => {
    expect(confluenceCommands.map((c) => c.name)).toEqual([
      "page.get",
      "page.ancestors",
      "page.diff",
      "page.permissions.list",
      "page.restriction",
      "page.operations",
      "page.properties",
      "attachment.list",
      "attachment.get",
      "space.get",
      "space.personal",
      "page.tree",
      "page.children",
      "page.versions",
      "page.labels",
      "space.list",
      "space.pages",
      "comment.list",
      "comment.get",
      "comment.replies",
      "comment.versions",
      "cql",
    ]);
    expect(confluenceCommands.every((c) => c.sideEffects === "none")).toBe(true);
  });
});

describe("page.get", () => {
  test("requests ADF and renders markdown with a compact shape", async () => {
    route("/api/v2/pages/123456", PAGE);
    route("/api/v2/pages/100", { id: "100", title: "Handbook" });
    const result = await run(pageGet, { page: "123456" });
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.pathname).toEndWith("/api/v2/pages/100");
    expect(calls[1]?.url.searchParams.has("body-format")).toBe(false);
    expect(result).toEqual({
      id: "123456",
      type: "page",
      title: "Runbook",
      spaceId: "98765",
      parent: { id: "100", title: "Handbook" },
      status: "current",
      version: 4,
      authorId: "acc-author",
      created: "2026-01-02T03:04:05Z",
      updated: "2026-02-03T04:05:06Z",
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456",
      body: ["Hello world"],
    });
  });

  test("storage format requests body-format=storage and passes XHTML through", async () => {
    route("/api/v2/pages/123456", PAGE);
    const result = await run(pageGet, { page: "123456" }, { format: "storage" });
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("storage");
    expect(result).toMatchObject({ body: ["<p>Hello <b>world</b></p>"] });
  });

  test("adf format returns the parsed document", async () => {
    route("/api/v2/pages/123456", PAGE);
    const result = await run(pageGet, { page: "123456" }, { format: "adf" });
    expect(result).toMatchObject({ body: { type: "doc" } });
  });

  test("--full returns the raw API object", async () => {
    route("/api/v2/pages/123456", PAGE);
    expect(await run(pageGet, { page: "123456" }, {}, ctx({ full: true }))).toEqual(PAGE);
  });

  test("blog post URLs route to /blogposts/", async () => {
    route("/api/v2/blogposts/555", { ...PAGE, id: "555" });
    const result = await run(pageGet, {
      page: "https://acme.atlassian.net/wiki/spaces/ENG/blog/2026/01/02/555/Release-notes",
    });
    expect(calls[0]?.url.pathname).toEndWith("/api/v2/blogposts/555");
    expect(result).toMatchObject({ type: "blogpost" });
  });

  test("--type blogpost overrides a bare id", async () => {
    route("/api/v2/blogposts/555", { ...PAGE, id: "555" });
    await run(pageGet, { page: "555" }, { type: "blogpost" });
    expect(calls[0]?.url.pathname).toEndWith("/api/v2/blogposts/555");
  });

  test("page URL host selects the site", async () => {
    route("/api/v2/pages/123456", PAGE);
    await run(pageGet, {
      page: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Runbook",
    });
    expect(calls[0]?.url.pathname).toBe("/ex/confluence/cloud-1/wiki/api/v2/pages/123456");
  });

  test("a comment reference is rejected with a next hint", async () => {
    const error = await rejection(run(pageGet, { page: "ari:cloud:confluence::comment/777" }));
    expect(error.category).toBe("input");
    expect(error.next).toEqual([["atl", "comment", "get", "777"]]);
  });
});

describe("page.get parent and --grep", () => {
  const BODY_TEXTS = [
    "intro",
    "Cold storage: 90 days",
    "middle",
    "cold storage again",
    "outro",
    "tail",
  ];
  // Markdown paragraphs are separated by blank lines: the hits are lines 3 and 7 of 11.
  const GREP_PAGE = {
    ...PAGE,
    parentId: undefined,
    body: {
      atlas_doc_format: { representation: "atlas_doc_format", value: paragraphs(...BODY_TEXTS) },
    },
  };

  test("a non-page parent carries its type and costs no extra request", async () => {
    route("/api/v2/pages/123456", { ...PAGE, parentId: "55", parentType: "folder" });
    const result = await run(pageGet, { page: "123456" });
    expect(asRecord(result).parent).toEqual({ id: "55", type: "folder" });
    expect(asRecord(result)).not.toHaveProperty("parentId");
    expect(calls).toHaveLength(1);
  });

  test("a parent the caller cannot read keeps its id; a top-level page has no parent", async () => {
    route("/api/v2/pages/123456", PAGE);
    expect(asRecord(await run(pageGet, { page: "123456" })).parent).toEqual({ id: "100" });
    calls = [];
    route("/api/v2/pages/123456", GREP_PAGE);
    const top = asRecord(await run(pageGet, { page: "123456" }));
    expect(top.parent).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("--full stays raw and sends no parent request", async () => {
    route("/api/v2/pages/123456", PAGE);
    await run(pageGet, { page: "123456" }, {}, ctx({ full: true }));
    expect(calls).toHaveLength(1);
  });

  test("--grep returns matching lines with 1-based numbers instead of the body", async () => {
    route("/api/v2/pages/123456", GREP_PAGE);
    const result = await run(pageGet, { page: "123456" }, { grep: "cold storage" });
    expect(result).toEqual({
      id: "123456",
      title: "Runbook",
      version: 4,
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456",
      lines: 11,
      matches: [
        { from: 3, text: ["Cold storage: 90 days"] },
        { from: 7, text: ["cold storage again"] },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  test("--context adds surrounding lines and merges overlapping or adjacent ranges", async () => {
    route("/api/v2/pages/123456", GREP_PAGE);
    const apart = await run(pageGet, { page: "123456" }, { grep: "storage", context: 1 });
    expect(asRecord(apart).matches).toEqual([
      { from: 2, to: 4, hits: [3], text: ["", "Cold storage: 90 days", ""] },
      { from: 6, to: 8, hits: [7], text: ["", "cold storage again", ""] },
    ]);
    const adjacent = await run(pageGet, { page: "123456" }, { grep: "storage", context: 2 });
    expect(asRecord(adjacent).matches).toEqual([
      {
        from: 1,
        to: 9,
        hits: [3, 7],
        text: [
          "intro",
          "",
          "Cold storage: 90 days",
          "",
          "middle",
          "",
          "cold storage again",
          "",
          "outro",
        ],
      },
    ]);
    const edge = await run(pageGet, { page: "123456" }, { grep: "tail", context: 3 });
    expect(asRecord(edge).matches).toEqual([
      { from: 8, to: 11, hits: [11], text: ["", "outro", "", "tail"] },
    ]);
  });

  test("no match reports the line count with an empty match list", async () => {
    route("/api/v2/pages/123456", GREP_PAGE);
    const result = await run(pageGet, { page: "123456" }, { grep: "absent" });
    expect(result).toMatchObject({ lines: 11, matches: [] });
  });

  test("a pattern matching everywhere prints 20 ranges and counts the rest", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `row ${i + 1}`);
    route("/api/v2/pages/123456", {
      ...GREP_PAGE,
      body: {
        atlas_doc_format: { representation: "atlas_doc_format", value: paragraphs(...many) },
      },
    });
    const result = asRecord(await run(pageGet, { page: "123456" }, { grep: "row" }));
    expect(result.matches).toHaveLength(20);
    expect(result.moreMatches).toBe(5);
    const few = asRecord(await run(pageGet, { page: "123456" }, { grep: "row 25" }));
    expect(few.moreMatches).toBeUndefined();
  });

  test("--grep keeps the parent so one call answers 'which page and under what'", async () => {
    route("/api/v2/pages/123456", { ...GREP_PAGE, parentId: "100" });
    route("/api/v2/pages/100", { id: "100", title: "Runbooks" });
    const result = asRecord(await run(pageGet, { page: "123456" }, { grep: "cold" }));
    expect(result.parent).toEqual({ id: "100", title: "Runbooks" });
  });

  test("--grep works with --version and searches storage with --format storage", async () => {
    route("/api/v2/pages/123456", {
      ...GREP_PAGE,
      status: "historical",
      body: { storage: { value: "<p>one</p>\n<p>two COLD</p>" } },
    });
    const result = await run(
      pageGet,
      { page: "123456" },
      { grep: "cold", version: 2, format: "storage" },
    );
    expect(calls[0]?.url.searchParams.get("version")).toBe("2");
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("storage");
    expect(result).toMatchObject({ lines: 2, matches: [{ from: 2, text: ["<p>two COLD</p>"] }] });
  });

  test("a leading (?i) is accepted and matched like the bare pattern", async () => {
    route("/api/v2/pages/123456", GREP_PAGE);
    const plain = await run(pageGet, { page: "123456" }, { grep: "cold" });
    const inline = await run(pageGet, { page: "123456" }, { grep: "(?i)COLD" });
    expect(inline).toEqual(plain);
  });

  test("an invalid regex and unusable flag combinations are input errors before any request", async () => {
    const bad = await rejection(run(pageGet, { page: "123456" }, { grep: "(" }));
    expect(bad.code).toBe("invalid_regex");
    expect(bad.category).toBe("input");
    const inline = await rejection(run(pageGet, { page: "123456" }, { grep: "(?s)laptop" }));
    expect(inline.code).toBe("invalid_regex");
    expect(inline.hint).toMatch(/already match case-insensitively/);
    const orphan = await rejection(run(pageGet, { page: "123456" }, { context: 2 }));
    expect(orphan.code).toBe("invalid_flag_combination");
    const full = await rejection(
      run(pageGet, { page: "123456" }, { grep: "x" }, ctx({ full: true })),
    );
    expect(full.code).toBe("invalid_flag_combination");
    const adfFormat = await rejection(
      run(pageGet, { page: "123456" }, { grep: "x", format: "adf" }),
    );
    expect(adfFormat.code).toBe("invalid_flag_combination");
    expect(calls).toHaveLength(0);
  });
});

describe("page.tree / children / labels", () => {
  test("tree passes depth and paginates via the next cursor", async () => {
    route("/api/v2/pages/123456/descendants", {
      results: [
        {
          id: "1",
          title: "A",
          type: "page",
          status: "current",
          parentId: "123456",
          depth: 1,
          childPosition: 0,
        },
      ],
      _links: { next: "/wiki/api/v2/pages/123456/descendants?depth=2&cursor=abc&limit=1" },
    });
    const result = await run(pageTree, { page: "123456" }, { depth: 2, limit: 1 });
    expect(lastQuery().get("depth")).toBe("2");
    expect(lastQuery().get("limit")).toBe("1");
    expect(result).toEqual({
      items: [{ id: "1", title: "A", parentId: "123456", depth: 1 }],
      nextCursor: "abc",
    });
  });

  test("tree keeps type and status only when they are not page/current", async () => {
    route("/api/v2/pages/123456/descendants", {
      results: [
        { id: "1", title: "A", type: "folder", status: "archived", parentId: "123456", depth: 1 },
      ],
    });
    expect(itemsOf(await run(pageTree, { page: "123456" }))).toEqual([
      { id: "1", title: "A", type: "folder", status: "archived", parentId: "123456", depth: 1 },
    ]);
  });

  test("tree rejects blog post refs", async () => {
    const error = await rejection(run(pageTree, { page: "ari:cloud:confluence::blogpost/5" }));
    expect(error.code).toBe("unsupported_for_blogpost");
  });

  test("children hits direct-children and keeps only id, title, and non-default type/status", async () => {
    route("/api/v2/pages/123456/direct-children", {
      results: [
        {
          id: "2",
          title: "B",
          type: "database",
          status: "current",
          childPosition: 3,
          spaceId: "9",
        },
      ],
    });
    const result = await run(pageChildren, { page: "123456" });
    expect(result).toEqual({
      items: [{ id: "2", title: "B", type: "database" }],
      nextCursor: null,
    });
  });

  test("labels map id/name and drop the default global prefix", async () => {
    route("/api/v2/pages/123456/labels", {
      results: [
        { id: "10", name: "runbook", prefix: "global" },
        { id: "11", name: "mine", prefix: "my" },
      ],
    });
    expect(await run(pageLabels, { page: "123456" })).toEqual({
      items: [
        { id: "10", name: "runbook" },
        { id: "11", name: "mine", prefix: "my" },
      ],
      nextCursor: null,
    });
  });
});

describe("space.list / space.pages", () => {
  test("list sends keys as a repeated param and type filter", async () => {
    route("/api/v2/spaces", {
      results: [
        {
          id: "98765",
          key: "ENG",
          name: "Engineering",
          type: "global",
          status: "current",
          homepageId: "1",
          authorId: "x",
          _links: { webui: "/spaces/ENG" },
        },
      ],
    });
    const result = await run(spaceList, {}, { keys: "ENG, OPS", type: "global" });
    expect(lastQuery().getAll("keys")).toEqual(["ENG", "OPS"]);
    expect(lastQuery().get("type")).toBe("global");
    expect(result).toEqual({
      items: [{ id: "98765", key: "ENG", name: "Engineering", homepageId: "1" }],
      nextCursor: null,
    });
  });

  test("list keeps type and status only when not global/current", async () => {
    route("/api/v2/spaces", {
      results: [
        { id: "1", key: "~me", name: "Me", type: "personal", status: "archived", homepageId: "5" },
      ],
    });
    expect(itemsOf(await run(spaceList, {}))).toEqual([
      { id: "1", key: "~me", name: "Me", type: "personal", status: "archived", homepageId: "5" },
    ]);
  });

  test("pages resolves a space key to its id first", async () => {
    route("/api/v2/spaces", { results: [{ id: "98765", key: "ENG" }] });
    route("/api/v2/spaces/98765/pages", {
      results: [{ id: "7", title: "Home", status: "current", parentId: null, childPosition: 0 }],
    });
    const result = await run(spacePages, { space: "ENG" }, { title: "Home", status: "current" });
    expect(calls.map((c) => c.url.pathname.replace("/ex/confluence/cloud-1/wiki", ""))).toEqual([
      "/api/v2/spaces",
      "/api/v2/spaces/98765/pages",
    ]);
    expect(calls[0]?.url.searchParams.get("keys")).toBe("ENG");
    expect(lastQuery().get("title")).toBe("Home");
    expect(lastQuery().get("status")).toBe("current");
    expect(result).toEqual({ items: [{ id: "7", title: "Home", type: "page" }], nextCursor: null });
  });

  test("pages skips the lookup for numeric space ids", async () => {
    route("/api/v2/spaces/98765/pages", { results: [] });
    await run(spacePages, { space: "98765" });
    expect(calls).toHaveLength(1);
  });

  test("unknown space key is a not_found error", async () => {
    route("/api/v2/spaces", { results: [] });
    const error = await rejection(run(spacePages, { space: "NOPE" }));
    expect(error.code).toBe("space_not_found");
    expect(error.category).toBe("api");
    expect(error.exitCode).toBe(2);
  });
});

const FOOTER_COMMENT = {
  id: "9001",
  status: "current",
  pageId: "123456",
  version: { number: 1, authorId: "acc-1", createdAt: "2026-03-01T10:00:00.000Z" },
  body: { atlas_doc_format: { representation: "atlas_doc_format", value: adf("Looks good") } },
  _links: { webui: "/spaces/ENG/pages/123456/Runbook?focusedCommentId=9001" },
};

const INLINE_COMMENT = {
  id: "9100",
  status: "current",
  pageId: "123456",
  resolutionStatus: "open",
  properties: { inlineMarkerRef: "ref", inlineOriginalSelection: "Hello" },
  version: { number: 2, authorId: "acc-2", createdAt: "2026-03-02T10:00:00.000Z" },
  body: { atlas_doc_format: { representation: "atlas_doc_format", value: adf("Typo?") } },
  _links: { webui: "/spaces/ENG/pages/123456/Runbook?focusedCommentId=9100" },
};

function routeUsers(): void {
  route("/rest/api/user/bulk", {
    results: [
      { accountId: "acc-1", displayName: "Ada Lovelace" },
      { accountId: "acc-2", publicName: "Grace Hopper" },
    ],
  });
}

describe("comment.list", () => {
  test("footer comments use /footer-comments with body-format and a minimal item", async () => {
    routeUsers();
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    const result = await run(commentList, { page: "123456" }, { status: "current" });
    expect(calls[0]?.url.pathname).toEndWith("/pages/123456/footer-comments");
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(calls[0]?.url.searchParams.get("status")).toBe("current");
    expect(itemsOf(result)).toEqual([
      {
        id: "9001",
        author: "Ada Lovelace",
        updated: "2026-03-01T10:00:00Z",
        body: ["Looks good"],
      },
    ]);
    expect(lastQuery().getAll("accountId")).toEqual(["acc-1"]);
  });

  test("--kind inline uses /inline-comments and exposes resolution and selection", async () => {
    routeUsers();
    route("/api/v2/pages/123456/inline-comments", { results: [INLINE_COMMENT] });
    const result = await run(
      commentList,
      { page: "123456" },
      { kind: "inline", resolution: "open" },
    );
    expect(calls[0]?.url.pathname).toEndWith("/pages/123456/inline-comments");
    expect(calls[0]?.url.searchParams.get("resolution-status")).toBe("open");
    expect(itemsOf(result)[0]).toEqual({
      id: "9100",
      author: "Grace Hopper",
      updated: "2026-03-02T10:00:00Z",
      resolutionStatus: "open",
      selection: "Hello",
      body: ["Typo?"],
    });
  });

  test("--resolution without --kind inline is an input error and sends no request", async () => {
    const error = await rejection(run(commentList, { page: "123456" }, { resolution: "open" }));
    expect(error.category).toBe("input");
    expect(calls).toHaveLength(0);
    const all = await rejection(
      run(commentList, { page: "123456" }, { kind: "all", resolution: "open" }),
    );
    expect(all.code).toBe("invalid_flag_combination");
    expect(calls).toHaveLength(0);
  });

  test("--replies nests children fetched per top-level comment", async () => {
    routeUsers();
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    route("/api/v2/footer-comments/9001/children", {
      results: [{ ...FOOTER_COMMENT, id: "9002", parentCommentId: "9001" }],
    });
    route("/api/v2/footer-comments/9002/children", { results: [] });
    const result = await run(commentList, { page: "123456" }, { replies: true, limit: 5 });
    expect(itemsOf(result)).toEqual([
      {
        id: "9001",
        author: "Ada Lovelace",
        updated: "2026-03-01T10:00:00Z",
        body: ["Looks good"],
        replies: [
          {
            id: "9002",
            parentCommentId: "9001",
            author: "Ada Lovelace",
            updated: "2026-03-01T10:00:00Z",
            body: ["Looks good"],
          },
        ],
      },
    ]);
    expect(calls[1]?.url.pathname).toEndWith("/footer-comments/9001/children");
    expect(calls[1]?.url.searchParams.get("limit")).toBe("5");
    expect(calls[2]?.url.pathname).toEndWith("/footer-comments/9002/children");
    expect(calls).toHaveLength(4);
    expect(lastQuery().getAll("accountId")).toEqual(["acc-1"]);
  });

  test("--replies follows a thread to its full depth, not one level", async () => {
    routeUsers();
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    for (const [parent, child] of [
      ["9001", "9002"],
      ["9002", "9003"],
      ["9003", "9004"],
    ]) {
      route(`/api/v2/footer-comments/${parent}/children`, {
        results: [{ ...FOOTER_COMMENT, id: child, parentCommentId: parent }],
      });
    }
    route("/api/v2/footer-comments/9004/children", { results: [] });
    const result = await run(commentList, { page: "123456" }, { replies: true });
    const depth = (node: unknown): string[] => {
      const { id, replies } = asRecord(node);
      return [String(id), ...(Array.isArray(replies) ? depth(replies[0]) : [])];
    };
    expect(depth(itemsOf(result)[0])).toEqual(["9001", "9002", "9003", "9004"]);
  });

  test("--replies reports repliesNextCursor and --full keeps raw comments", async () => {
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    route("/api/v2/footer-comments/9001/children", {
      results: [{ ...FOOTER_COMMENT, id: "9002", parentCommentId: "9001" }],
      _links: { next: "/wiki/api/v2/footer-comments/9001/children?cursor=RC&limit=1" },
    });
    route("/api/v2/footer-comments/9002/children", { results: [] });
    const full = await run(
      commentList,
      { page: "123456" },
      { replies: true, repliesPerComment: 1 },
      ctx({ full: true }),
    );
    expect(itemsOf(full)[0]).toMatchObject({
      id: "9001",
      pageId: "123456",
      replies: [{ id: "9002" }],
      repliesNextCursor: "RC",
    });
    expect(calls.some((call) => call.url.pathname.endsWith("/user/bulk"))).toBe(false);
  });

  test("--replies with --kind inline fetches from the inline children endpoint", async () => {
    route("/api/v2/pages/123456/inline-comments", { results: [INLINE_COMMENT] });
    route("/api/v2/inline-comments/9100/children", { results: [] });
    routeUsers();
    const result = await run(commentList, { page: "123456" }, { kind: "inline", replies: true });
    expect(calls[1]?.url.pathname).toEndWith("/inline-comments/9100/children");
    expect(asRecord(itemsOf(result)[0]).replies).toBeUndefined();
  });

  describe("--kind all", () => {
    const FOOTER_PATH = "/api/v2/pages/123456/footer-comments";
    const INLINE_PATH = "/api/v2/pages/123456/inline-comments";

    test("returns footer then inline in one result, each item tagged with its kind", async () => {
      routeUsers();
      route(FOOTER_PATH, { results: [FOOTER_COMMENT] });
      route(INLINE_PATH, { results: [INLINE_COMMENT] });
      const result = await run(commentList, { page: "123456" }, { kind: "all" });
      expect(itemsOf(result)).toEqual([
        {
          kind: "footer",
          id: "9001",
          author: "Ada Lovelace",
          updated: "2026-03-01T10:00:00Z",
          body: ["Looks good"],
        },
        {
          kind: "inline",
          id: "9100",
          author: "Grace Hopper",
          updated: "2026-03-02T10:00:00Z",
          resolutionStatus: "open",
          selection: "Hello",
          body: ["Typo?"],
        },
      ]);
      expect(asRecord(result).nextCursor).toBeNull();
      expect(calls.filter((call) => call.url.pathname.endsWith("/user/bulk"))).toHaveLength(1);
    });

    test("--replies nests each kind's replies from that kind's children endpoint", async () => {
      routeUsers();
      route(FOOTER_PATH, { results: [FOOTER_COMMENT] });
      route(INLINE_PATH, { results: [INLINE_COMMENT] });
      route("/api/v2/footer-comments/9001/children", {
        results: [{ ...FOOTER_COMMENT, id: "9002", parentCommentId: "9001" }],
      });
      route("/api/v2/footer-comments/9002/children", { results: [] });
      route("/api/v2/inline-comments/9100/children", {
        results: [{ ...INLINE_COMMENT, id: "9101", parentCommentId: "9100" }],
      });
      route("/api/v2/inline-comments/9101/children", { results: [] });
      const result = await run(commentList, { page: "123456" }, { kind: "all", replies: true });
      const [footer, inline] = itemsOf(result).map(asRecord);
      expect(footer).toMatchObject({ kind: "footer", id: "9001", replies: [{ id: "9002" }] });
      expect(inline).toMatchObject({ kind: "inline", id: "9100", replies: [{ id: "9101" }] });
    });

    test("--limit applies to each kind and one cursor resumes only the kinds with more", async () => {
      routeUsers();
      routeBy(FOOTER_PATH, (url) =>
        url.searchParams.has("cursor")
          ? { results: [{ ...FOOTER_COMMENT, id: "9003" }] }
          : {
              results: [FOOTER_COMMENT],
              _links: { next: `/wiki${FOOTER_PATH}?cursor=F2&limit=1` },
            },
      );
      route(INLINE_PATH, { results: [INLINE_COMMENT] });
      const first = await run(commentList, { page: "123456" }, { kind: "all", limit: 1 });
      expect(calls.filter((call) => call.url.pathname.endsWith("-comments"))).toHaveLength(2);
      expect(
        calls.map((call) => call.url.searchParams.get("limit")).filter((limit) => limit !== null),
      ).toEqual(["1", "1"]);
      const cursor = asRecord(first).nextCursor;
      expect(typeof cursor).toBe("string");

      calls = [];
      const second = await run(commentList, { page: "123456" }, { kind: "all", limit: 1, cursor });
      const paged = calls.filter((call) => call.url.pathname.includes("-comments"));
      expect(paged).toHaveLength(1);
      expect(paged[0]?.url.pathname).toEndWith(FOOTER_PATH);
      expect(paged[0]?.url.searchParams.get("cursor")).toBe("F2");
      expect(itemsOf(second).map((item) => asRecord(item).id)).toEqual(["9003"]);
      expect(asRecord(second).nextCursor).toBeNull();
    });

    test("--full tags raw comments and a foreign cursor is an input error", async () => {
      route(FOOTER_PATH, { results: [FOOTER_COMMENT] });
      route(INLINE_PATH, { results: [INLINE_COMMENT] });
      const full = await run(commentList, { page: "123456" }, { kind: "all" }, ctx({ full: true }));
      expect(itemsOf(full)).toEqual([
        { kind: "footer", ...FOOTER_COMMENT },
        { kind: "inline", ...INLINE_COMMENT },
      ]);
      calls = [];
      const error = await rejection(
        run(commentList, { page: "123456" }, { kind: "all", cursor: "bogus" }),
      );
      expect(error.code).toBe("invalid_cursor");
      expect(calls).toHaveLength(0);
    });
  });

  test("blog post refs use /blogposts/", async () => {
    route("/api/v2/blogposts/555/footer-comments", { results: [] });
    await run(commentList, { page: "ari:cloud:confluence::blogpost/555" });
    expect(calls[0]?.url.pathname).toEndWith("/blogposts/555/footer-comments");
  });
});

describe("comment.get / versions", () => {
  test("get resolves focusedCommentId from a page URL and returns the full single view", async () => {
    routeUsers();
    route("/api/v2/footer-comments/9001", FOOTER_COMMENT);
    const result = await run(commentGet, {
      comment:
        "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Runbook?focusedCommentId=9001",
    });
    expect(calls[0]?.url.pathname).toEndWith("/footer-comments/9001");
    expect(result).toEqual({
      id: "9001",
      type: "footer-comment",
      pageId: "123456",
      status: "current",
      version: 1,
      author: "Ada Lovelace",
      authorId: "acc-1",
      updated: "2026-03-01T10:00:00Z",
      body: ["Looks good"],
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456?focusedCommentId=9001",
    });
  });

  test("get --kind inline uses the inline endpoint with --format adf", async () => {
    routeUsers();
    route("/api/v2/inline-comments/9100", INLINE_COMMENT);
    const result = await run(commentGet, { comment: "9100" }, { kind: "inline", format: "adf" });
    expect(calls[0]?.url.pathname).toEndWith("/inline-comments/9100");
    expect(result).toMatchObject({ body: { type: "doc" }, author: "Grace Hopper" });
  });

  test("get without a comment id in the URL is an input error", async () => {
    const error = await rejection(
      run(commentGet, {
        comment: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Runbook",
      }),
    );
    expect(error.code).toBe("invalid_comment_ref");
  });

  test("versions show author names, created, and minorEdit only when true", async () => {
    routeUsers();
    route("/api/v2/footer-comments/9001/versions", {
      results: [
        {
          number: 2,
          message: "typo",
          minorEdit: true,
          authorId: "acc-1",
          createdAt: "2026-03-01T10:00:00.250Z",
          page: {},
        },
        { number: 1, message: "", minorEdit: false, authorId: "acc-9", createdAt: "t" },
      ],
    });
    expect(await run(commentVersions, { comment: "9001" })).toEqual({
      items: [
        {
          number: 2,
          message: "typo",
          minorEdit: true,
          author: "Ada Lovelace",
          created: "2026-03-01T10:00:00Z",
        },
        { number: 1, author: "acc-9", created: "t" },
      ],
      nextCursor: null,
    });
  });

  test("--full returns raw comments and never looks up users", async () => {
    route("/api/v2/footer-comments/9001", FOOTER_COMMENT);
    expect(await run(commentGet, { comment: "9001" }, {}, ctx({ full: true }))).toEqual(
      FOOTER_COMMENT,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("page.versions", () => {
  test("lists versions with display names and short timestamps", async () => {
    routeUsers();
    route("/api/v2/pages/123456/versions", {
      results: [
        {
          number: 3,
          message: "title only",
          minorEdit: false,
          authorId: "acc-1",
          createdAt: "2026-10-21T20:12:07.946Z",
        },
      ],
    });
    expect(await run(pageVersions, { page: "123456" })).toEqual({
      items: [
        {
          number: 3,
          message: "title only",
          author: "Ada Lovelace",
          created: "2026-10-21T20:12:07Z",
        },
      ],
      nextCursor: null,
    });
  });
});

describe("cql", () => {
  const RESULTS = [
    {
      content: { id: "123456", type: "page", space: { key: "ENG" } },
      title: "@@@hl@@@Runbook@@@endhl@@@ for deploys",
      excerpt: "How to @@@hl@@@deploy@@@endhl@@@ the service",
      url: "/spaces/ENG/pages/123456/Runbook",
      lastModified: "2026-02-03T04:05:06.000Z",
      resultGlobalContainer: { title: "Engineering", displayUrl: "/spaces/ENG" },
    },
  ];

  test("cleans highlight markers, builds site URLs and resolves the space key", async () => {
    route("/rest/api/search", { results: RESULTS, size: 1 });
    const result = await run(cql, { query: 'space = ENG AND text ~ "deploy"' });
    expect(lastQuery().get("cql")).toBe('space = ENG AND text ~ "deploy"');
    expect(lastQuery().get("limit")).toBe("25");
    expect(result).toEqual({
      items: [
        {
          id: "123456",
          title: "Runbook for deploys",
          spaceKey: "ENG",
          excerpt: "How to deploy the service",
          lastModified: "2026-02-03T04:05:06Z",
        },
      ],
      nextCursor: null,
    });
  });

  test("unquoted words, as the shell splits them, are sent as one query", async () => {
    route("/rest/api/search", { results: [] });
    const words = ["label", "=", "policy", "AND", "space", "=", "X"];
    await cql.run(ctx(), { args: {}, rest: words, flags: {} });
    expect(lastQuery().get("cql")).toBe("label = policy AND space = X");
  });

  test("excerpts are one line, decoded, and capped at 160 characters", async () => {
    route("/rest/api/search", {
      results: [
        { ...RESULTS[0], excerpt: "Line one\n\n  line &quot;two&quot; \\uD83D\\uDDD3 &amp; more" },
        { ...RESULTS[0], excerpt: `${"word ".repeat(60)}end` },
        { ...RESULTS[0], excerpt: "" },
      ],
    });
    const [decoded, long, empty] = itemsOf(await run(cql, { query: "type = page" })).map(asRecord);
    expect(decoded?.excerpt).toBe('Line one line "two" \u{1F5D3} & more');
    expect(String(long?.excerpt)).toHaveLength(160);
    expect(String(long?.excerpt).endsWith("…")).toBe(true);
    expect(empty?.excerpt).toBeUndefined();
  });

  test("non-page hits keep type and url; blog posts and pages drop url", async () => {
    route("/rest/api/search", {
      results: [
        {
          ...RESULTS[0],
          content: { id: "9", type: "blogpost" },
          url: "/spaces/ENG/blog/2026/01/02/9/Post",
        },
        {
          ...RESULTS[0],
          content: { id: "8", type: "attachment" },
          url: "/download/attachments/1/a.pdf",
        },
      ],
    });
    const [blog, attachment] = itemsOf(await run(cql, { query: "x" })).map(asRecord);
    expect(blog).toMatchObject({ id: "9", type: "blogpost" });
    expect(blog?.url).toBeUndefined();
    expect(attachment).toMatchObject({
      id: "8",
      type: "attachment",
      url: "https://acme.atlassian.net/wiki/download/attachments/1/a.pdf",
    });
  });

  test("falls back to content.space.key", async () => {
    route("/rest/api/search", {
      results: [{ ...RESULTS[0], resultGlobalContainer: undefined }],
    });
    const result = await run(cql, { query: "type = page" });
    expect(itemsOf(result)[0]).toMatchObject({ spaceKey: "ENG" });
  });

  test("caps page size at 50 and reports the next cursor from _links.next", async () => {
    route("/rest/api/search", {
      results: Array.from({ length: 50 }, () => RESULTS[0]),
      _links: { next: "/rest/api/search?cql=type%3Dpage&cursor=NEXTCUR&limit=50" },
    });
    const result = await run(cql, { query: "type=page" }, { limit: 50 });
    expect(lastQuery().get("limit")).toBe("50");
    expect(itemsOf(result)).toHaveLength(50);
    expect(result).toMatchObject({ nextCursor: "NEXTCUR" });
  });

  test("resumes from --cursor", async () => {
    route("/rest/api/search", { results: [] });
    await run(cql, { query: "type=page" }, { cursor: "NEXTCUR" });
    expect(lastQuery().get("cursor")).toBe("NEXTCUR");
  });

  test("hit titles are the stored text, not the HTML-escaped top-level title", async () => {
    route("/rest/api/search", {
      results: [
        {
          ...RESULTS[0],
          content: { id: "1", type: "page", title: 'Say "hi" & it\'s <b>' },
          title: "Say &quot;hi&quot; &amp; it&#39;s &lt;b&gt;",
        },
        { ...RESULTS[0], content: { id: "2", type: "page" }, title: "a &amp; b &#x27;" },
      ],
    });
    const result = await run(cql, { query: "type=page" });
    expect(itemsOf(result).map((item) => asRecord(item).title)).toEqual([
      'Say "hi" & it\'s <b>',
      "a & b '",
    ]);
  });

  test("--all follows the cursor across pages", async () => {
    let page = 0;
    const original = confluenceDeps.fetch;
    confluenceDeps.fetch = (input) => {
      const url = new URL(input);
      calls.push({ url });
      page += 1;
      const body =
        page === 1
          ? { results: RESULTS, _links: { next: "/rest/api/search?cursor=C2&limit=50" } }
          : { results: [{ ...RESULTS[0], content: { id: "2", type: "page" } }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    try {
      const result = await run(cql, { query: "type=page" }, { all: true });
      expect(itemsOf(result).map((item) => asRecord(item).id)).toEqual(["123456", "2"]);
      expect(asRecord(result).nextCursor).toBeNull();
      expect(calls[1]?.url.searchParams.get("cursor")).toBe("C2");
    } finally {
      confluenceDeps.fetch = original;
    }
  });
});

describe("MCP read parity flags", () => {
  test("space.list maps ids, status, labels, favorited-by and sort to repeated v2 params", async () => {
    route("/api/v2/spaces", { results: [] });
    await run(
      spaceList,
      {},
      {
        ids: "1, 2",
        status: "archived",
        labels: "runbooks,ops",
        favoritedBy: "acc-9",
        sort: "-name",
      },
    );
    expect(lastQuery().getAll("ids")).toEqual(["1", "2"]);
    expect(lastQuery().get("status")).toBe("archived");
    expect(lastQuery().getAll("labels")).toEqual(["runbooks", "ops"]);
    expect(lastQuery().get("favorited-by")).toBe("acc-9");
    expect(lastQuery().get("sort")).toBe("-name");
  });

  test("space.list --favourite resolves the caller's account id from /me", async () => {
    route("/me", { account_id: "acc-me" });
    route("/api/v2/spaces", { results: [] });
    await run(spaceList, {}, { favourite: true });
    expect(calls[0]?.url.href).toBe("https://api.atlassian.com/me");
    expect(lastQuery().get("favorited-by")).toBe("acc-me");
  });

  test("space.list rejects --favourite together with --favorited-by", async () => {
    const error = await rejection(run(spaceList, {}, { favourite: true, favoritedBy: "x" }));
    expect(error.code).toBe("invalid_flag_combination");
    expect(calls).toHaveLength(0);
  });

  test("space.pages --type blogpost lists /blogposts with sort and renders bodies on --body", async () => {
    route("/api/v2/spaces/98765/blogposts", {
      results: [
        {
          id: "5",
          title: "Release",
          status: "current",
          body: { atlas_doc_format: { value: adf("Shipped") } },
        },
      ],
    });
    const result = await run(
      spacePages,
      { space: "98765" },
      { type: "blogpost", sort: "-created-date", status: "trashed", body: true, format: "md" },
    );
    expect(calls[0]?.url.pathname).toEndWith("/spaces/98765/blogposts");
    expect(lastQuery().get("sort")).toBe("-created-date");
    expect(lastQuery().get("status")).toBe("trashed");
    expect(lastQuery().get("body-format")).toBe("atlas_doc_format");
    expect(itemsOf(result)[0]).toMatchObject({ id: "5", title: "Release", body: ["Shipped"] });
  });

  test("space.pages omits body-format and bodies without --body", async () => {
    route("/api/v2/spaces/98765/pages", { results: [{ id: "7", title: "Home" }] });
    const result = await run(spacePages, { space: "98765" }, { format: "md" });
    expect(lastQuery().has("body-format")).toBe(false);
    expect(itemsOf(result)[0]).not.toHaveProperty("body");
  });

  test("comment.list passes sort and uses --replies-per-comment for the reply fetch", async () => {
    routeUsers();
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    route("/api/v2/footer-comments/9001/children", { results: [] });
    await run(
      commentList,
      { page: "123456" },
      { sort: "-created-date", replies: true, repliesPerComment: 3, limit: 10 },
    );
    expect(calls[0]?.url.searchParams.get("sort")).toBe("-created-date");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("10");
    expect(calls[1]?.url.searchParams.get("limit")).toBe("3");
    expect(calls[1]?.url.searchParams.get("sort")).toBe("-created-date");
  });

  test("comment.replies passes sort", async () => {
    route("/api/v2/inline-comments/9100/children", { results: [] });
    await run(commentReplies, { comment: "9100" }, { kind: "inline", sort: "modified-date" });
    expect(lastQuery().get("sort")).toBe("modified-date");
    expect(lastQuery().get("body-format")).toBe("atlas_doc_format");
  });

  test("cql passes cqlcontext and expand", async () => {
    route("/rest/api/search", { results: [] });
    await run(
      cql,
      { query: "type = page" },
      { cqlContext: '{"spaceKey":"ENG"}', expand: "content.version" },
    );
    expect(lastQuery().get("cqlcontext")).toBe('{"spaceKey":"ENG"}');
    expect(lastQuery().get("expand")).toBe("content.version");
  });
});

function paragraphs(...texts: string[]): string {
  return JSON.stringify({
    type: "doc",
    version: 1,
    content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  });
}

describe("page.get --version and --format view", () => {
  test("--version requests that version and drops the throwaway url of a historical page", async () => {
    route("/api/v2/pages/123456", {
      ...PAGE,
      status: "historical",
      version: { number: 2, createdAt: "2026-01-03T00:00:00.000Z" },
      _links: {
        webui: "/pages/viewpage.action?pageId=999",
        base: "https://acme.atlassian.net/wiki",
      },
    });
    const result = await run(pageGet, { page: "123456" }, { version: 2 });
    expect(calls[0]?.url.searchParams.get("version")).toBe("2");
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(result).toMatchObject({ version: 2, status: "historical", body: ["Hello world"] });
    expect(asRecord(result).url).toBeUndefined();
  });

  test("no --version sends no version parameter", async () => {
    route("/api/v2/pages/123456", PAGE);
    await run(pageGet, { page: "123456" });
    expect(calls[0]?.url.searchParams.has("version")).toBe(false);
  });

  test("--format view requests body-format=view and returns the rendered HTML as lines", async () => {
    route("/api/v2/pages/123456", {
      ...PAGE,
      body: { view: { representation: "view", value: "<p>Hello <b>world</b></p>" } },
    });
    const result = await run(pageGet, { page: "123456" }, { format: "view" });
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("view");
    expect(result).toMatchObject({ body: ["<p>Hello <b>world</b></p>"] });
  });

  test("--format view on a blog post at a version uses /blogposts/", async () => {
    route("/api/v2/blogposts/555", { ...PAGE, id: "555", body: { view: { value: "<p>x</p>" } } });
    await run(pageGet, { page: "555" }, { format: "view", version: 3, type: "blogpost" });
    expect(calls[0]?.url.pathname).toEndWith("/api/v2/blogposts/555");
    expect(calls[0]?.url.searchParams.get("version")).toBe("3");
  });
});

describe("page.ancestors", () => {
  const SEARCH = {
    results: [
      {
        content: {
          id: "123456",
          ancestors: [
            { id: "1", type: "page", title: "Home" },
            { id: "2", type: "folder", title: "Docs" },
            { id: "3", type: "page", title: "Parent" },
          ],
        },
      },
    ],
  };

  test("expands content.ancestors through CQL and lists root first", async () => {
    route("/rest/api/search", SEARCH);
    const result = await run(pageAncestors, { page: "123456" });
    expect(lastQuery().get("cql")).toBe("id = 123456");
    expect(lastQuery().get("expand")).toBe("content.ancestors");
    expect(result).toEqual({
      items: [
        { id: "1", title: "Home" },
        { id: "2", title: "Docs", type: "folder" },
        { id: "3", title: "Parent" },
      ],
    });
  });

  test("--limit keeps the nearest ancestors", async () => {
    route("/rest/api/search", SEARCH);
    const result = await run(pageAncestors, { page: "123456" }, { limit: 2 });
    expect(itemsOf(result)).toEqual([
      { id: "2", title: "Docs", type: "folder" },
      { id: "3", title: "Parent" },
    ]);
  });

  test("a top-level page has no items", async () => {
    route("/rest/api/search", { results: [{ content: { id: "123456" } }] });
    expect(await run(pageAncestors, { page: "123456" })).toEqual({ items: [] });
  });

  test("an unknown page is page_not_found", async () => {
    route("/rest/api/search", { results: [] });
    const error = await rejection(run(pageAncestors, { page: "123456" }));
    expect(error.code).toBe("page_not_found");
  });

  test("a non-numeric id is rejected before any request", async () => {
    const error = await rejection(run(pageAncestors, { page: "ari:cloud:confluence::page/abc" }));
    expect(error.category).toBe("input");
    expect(calls).toEqual([]);
  });

  test("blog posts are rejected before any request", async () => {
    const error = await rejection(
      run(pageAncestors, {
        page: "https://acme.atlassian.net/wiki/spaces/ENG/blog/2026/01/02/555/T",
      }),
    );
    expect(error.code).toBe("unsupported_for_blogpost");
    expect(calls).toEqual([]);
  });

  test("--full returns the raw search response", async () => {
    route("/rest/api/search", SEARCH);
    expect(await run(pageAncestors, { page: "123456" }, {}, ctx({ full: true }))).toEqual(SEARCH);
  });
});

function versions(
  bodies: Record<number, string>,
  current: number,
  storage: Record<number, string> = {},
): void {
  routeBy("/api/v2/pages/123456", (url) => {
    const requested = url.searchParams.get("version");
    const number = requested === null ? current : Number(requested);
    return {
      ...PAGE,
      status: requested === null ? "current" : "historical",
      version: { number },
      body: { atlas_doc_format: { value: bodies[number] }, storage: { value: storage[number] } },
    };
  });
}

describe("page.diff", () => {
  test("defaults to the previous version against the current one", async () => {
    versions(
      { 2: paragraphs("alpha", "beta", "gamma"), 3: paragraphs("alpha", "BETA", "gamma") },
      3,
    );
    const result = await run(pageDiff, { page: "123456" });
    expect(calls.map((c) => c.url.searchParams.get("version"))).toEqual([null, "2", "2", null]);
    expect(result).toEqual({
      id: "123456",
      title: "Runbook",
      from: 2,
      to: 3,
      added: 1,
      removed: 1,
      diff: ["@@ -1,5 +1,5 @@", " alpha", " ", "-beta", "+BETA", " ", " gamma"],
    });
  });

  test("--from and --to pick versions; --context 0 leaves only the changes", async () => {
    versions(
      {
        1: paragraphs("one", "two", "three", "four"),
        4: paragraphs("one", "2", "three", "four", "five"),
      },
      9,
    );
    const result = await run(pageDiff, { page: "123456" }, { from: 1, to: 4, context: 0 });
    expect(calls.map((c) => c.url.searchParams.get("version"))).toEqual(["4", "1", "1", "4"]);
    expect(result).toMatchObject({ from: 1, to: 4, added: 3, removed: 1 });
    expect(asRecord(result).diff).toEqual([
      "@@ -3,1 +3,1 @@",
      "-two",
      "+2",
      "@@ -7,0 +8,2 @@",
      "+",
      "+five",
    ]);
  });

  test("identical versions give counts and no diff", async () => {
    versions({ 1: paragraphs("same"), 2: paragraphs("same") }, 2);
    const result = await run(pageDiff, { page: "123456" });
    expect(result).toMatchObject({ added: 0, removed: 0 });
    expect(asRecord(result).diff).toEqual([]);
  });

  test("version 1 has nothing to diff against", async () => {
    versions({ 1: paragraphs("only") }, 1);
    const error = await rejection(run(pageDiff, { page: "123456" }));
    expect(error.code).toBe("no_previous_version");
    expect(calls).toHaveLength(1);
  });

  test("--format storage diffs the XHTML", async () => {
    routeBy("/api/v2/pages/123456", (url) => {
      const first = url.searchParams.get("version") === "1";
      return {
        ...PAGE,
        version: { number: first ? 1 : 2 },
        body: { storage: { value: first ? "<p>a</p>" : "<p>b</p>" } },
      };
    });
    const result = await run(pageDiff, { page: "123456" }, { format: "storage" });
    expect(lastQuery().get("body-format")).toBe("storage");
    expect(asRecord(result).diff).toEqual(["@@ -1,1 +1,1 @@", "-<p>a</p>", "+<p>b</p>"]);
  });

  test("a long changed line is wrapped and every piece keeps its marker", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    versions({ 1: paragraphs("start"), 2: paragraphs("start", long) }, 2);
    const rows = asRecord(await run(pageDiff, { page: "123456" })).diff;
    if (!Array.isArray(rows)) {
      throw new Error("expected diff rows");
    }
    expect(rows.filter((row) => String(row).startsWith("+word")).length).toBeGreaterThan(1);
    expect(rows.every((row) => Buffer.byteLength(JSON.stringify(row)) <= 610)).toBe(true);
  });

  test("a rewrite beyond the exact-search budget is one deletion block and one insertion block", async () => {
    const before = Array.from({ length: 2500 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 2500 }, (_, i) => `new ${i}`);
    versions({ 1: paragraphs(...before), 2: paragraphs(...after) }, 2);
    const result = await run(pageDiff, { page: "123456" }, { context: 0 });
    expect(result).toMatchObject({ added: 4999, removed: 4999 });
  });

  test("--full returns both raw page versions", async () => {
    versions({ 1: paragraphs("a"), 2: paragraphs("b") }, 2);
    const result = asRecord(await run(pageDiff, { page: "123456" }, {}, ctx({ full: true })));
    expect(asRecord(result.from).version).toEqual({ number: 1 });
    expect(asRecord(result.to).version).toEqual({ number: 2 });
    expect(calls).toHaveLength(2);
  });

  describe("inventory", () => {
    const BEFORE =
      '<h2>Rich ADF</h2><ac:structured-macro ac:name="note" ac:schema-version="1" ac:macro-id="67da668e-defb-4574-8fed-5a4522a98607"><ac:rich-text-body><p>Panel body</p></ac:rich-text-body></ac:structured-macro><p>Mention <ac:link><ri:user ri:account-id="62a219658783e7006f627f3b" /></ac:link> date <time datetime="2026-11-16" /></p><ac:structured-macro ac:name="toc" ac:schema-version="1" ac:macro-id="b7201282-28bb-40c2-945b-da16c75a4c6c" /><p>end</p>';
    const AFTER =
      '<h2>Rich ADF</h2><ac:structured-macro ac:name="note" ac:schema-version="1" ac:macro-id="11111111-defb-4574-8fed-5a4522a98607"><ac:rich-text-body><p>Panel body</p></ac:rich-text-body></ac:structured-macro><p>Mention <ac:link><ri:user ri:account-id="62a219658783e7006f627f3b" /></ac:link> date <time datetime="2026-11-16" /></p><h3>Follow-ups</h3><p>end</p>';

    test("lists the structure that left or arrived between the versions, from storage", async () => {
      versions({ 1: paragraphs("a"), 2: paragraphs("b") }, 2, { 1: BEFORE, 2: AFTER });
      const result = asRecord(await run(pageDiff, { page: "123456" }));
      expect(result.inventory).toEqual({
        removed: { macros: { toc: 1 } },
        added: { headings: { "h3 Follow-ups": 1 } },
      });
      expect(
        calls.map((c) => [
          c.url.searchParams.get("version"),
          c.url.searchParams.get("body-format"),
        ]),
      ).toEqual([
        [null, "atlas_doc_format"],
        ["1", "atlas_doc_format"],
        ["1", "storage"],
        [null, "storage"],
      ]);
    });

    test("--format storage reuses the fetched storage: no extra requests", async () => {
      versions({}, 2, { 1: BEFORE, 2: AFTER });
      const result = asRecord(await run(pageDiff, { page: "123456" }, { format: "storage" }));
      expect(result.inventory).toEqual({
        removed: { macros: { toc: 1 } },
        added: { headings: { "h3 Follow-ups": 1 } },
      });
      expect(calls).toHaveLength(2);
    });

    test("versions with the same structure carry no inventory, whatever their ids", async () => {
      versions({ 1: paragraphs("a"), 2: paragraphs("b") }, 2, {
        1: BEFORE,
        2: BEFORE.replaceAll("67da668e", "99999999"),
      });
      expect(asRecord(await run(pageDiff, { page: "123456" })).inventory).toBeUndefined();
    });
  });
});

describe("page.permissions.list, restriction, operations, properties", () => {
  test("permissions: user grants show display names, groups their id; filters pass through", async () => {
    routeUsers();
    route("/api/v2/pages/123456/permissions", {
      results: [
        { operation: "update", principal: { principalType: "user", principalId: "acc-1" } },
        { operation: "read", principal: { principalType: "group", principalId: "g-1" } },
      ],
    });
    const result = await run(
      pagePermissionsList,
      { page: "123456" },
      { operation: "update", principalType: "user", principalId: "acc-1" },
    );
    expect(calls[0]?.url.searchParams.get("operation")).toBe("update");
    expect(calls[0]?.url.searchParams.get("principal-type")).toBe("user");
    expect(calls[0]?.url.searchParams.get("principal-id")).toBe("acc-1");
    expect(result).toMatchObject({
      items: [
        { operation: "update", user: "Ada Lovelace" },
        { operation: "read", group: "g-1" },
      ],
    });
  });

  test("permissions --full returns the raw grants without a user lookup", async () => {
    const grant = {
      operation: "read",
      principal: { principalType: "user", principalId: "acc-1" },
      createdAt: "2026-01-01T00:00:00Z",
    };
    route("/api/v2/pages/123456/permissions", { results: [grant] });
    const result = await run(pagePermissionsList, { page: "123456" }, {}, ctx({ full: true }));
    expect(itemsOf(result)).toEqual([grant]);
    expect(calls.some((call) => call.url.pathname.endsWith("/user/bulk"))).toBe(false);
  });

  test("permissions on a blog post use /blogposts/", async () => {
    route("/api/v2/blogposts/555/permissions", { results: [] });
    expect(await run(pagePermissionsList, { page: "555" }, { type: "blogpost" })).toMatchObject({
      items: [],
    });
  });

  test("restriction returns the state without _links; --full keeps them", async () => {
    const body = { state: "OPEN", _links: { base: "https://acme.atlassian.net/wiki" } };
    route("/api/v2/pages/123456/restriction-state", body);
    expect(await run(pageRestriction, { page: "123456" })).toEqual({ state: "OPEN" });
    expect(await run(pageRestriction, { page: "123456" }, {}, ctx({ full: true }))).toEqual(body);
  });

  test("operations: own-type operations by name, create and other targets as operation:target", async () => {
    const body = {
      operations: [
        { operation: "read", targetType: "page" },
        { operation: "delete", targetType: "page" },
        { operation: "create", targetType: "page" },
        { operation: "create", targetType: "folder" },
      ],
    };
    route("/api/v2/pages/123456/operations", body);
    expect(await run(pageOperations, { page: "123456" })).toEqual({
      operations: ["read", "delete", "create:page", "create:folder"],
    });
    expect(await run(pageOperations, { page: "123456" }, {}, ctx({ full: true }))).toEqual(body);
  });

  test("operations on a blog post name blogpost operations", async () => {
    route("/api/v2/blogposts/555/operations", {
      operations: [{ operation: "update", targetType: "blogpost" }],
    });
    expect(await run(pageOperations, { page: "555" }, { type: "blogpost" })).toEqual({
      operations: ["update"],
    });
  });

  test("properties: key and value as stored, --key filters server-side", async () => {
    route("/api/v2/pages/123456/properties", {
      results: [
        { id: "1", key: "state", value: { stage: "Review" }, version: { number: 3 } },
        { id: "2", key: "legacy", value: '{"a":1}' },
      ],
    });
    const result = await run(pageProperties, { page: "123456" }, { key: "state" });
    expect(lastQuery().get("key")).toBe("state");
    expect(result).toMatchObject({
      items: [
        { key: "state", value: { stage: "Review" } },
        { key: "legacy", value: '{"a":1}' },
      ],
    });
  });

  test("properties on a blog post, --full, and cursor paging", async () => {
    route("/api/v2/blogposts/555/properties", {
      results: [{ id: "1", key: "k", value: 1 }],
      _links: { next: "/api/v2/blogposts/555/properties?cursor=abc" },
    });
    const compact = asRecord(
      await run(pageProperties, { page: "555" }, { type: "blogpost", limit: 1 }),
    );
    expect(compact.nextCursor).toBe("abc");
    const full = await run(
      pageProperties,
      { page: "555" },
      { type: "blogpost", limit: 1 },
      ctx({ full: true }),
    );
    expect(itemsOf(full)).toEqual([{ id: "1", key: "k", value: 1 }]);
  });
});

describe("attachment.list and attachment.get", () => {
  const ATTACHMENT = {
    id: "att77",
    title: "diagram.png",
    version: { number: 2, when: "2026-01-02T03:04:05.000Z", by: { displayName: "Ada" } },
    container: { id: "123456" },
    extensions: { mediaType: "image/png", fileSize: 1024 },
  };
  const REPORT = {
    id: "att78",
    title: "report.pdf",
    version: { number: 1, when: "2026-01-02T03:04:05.000Z", by: { publicName: "Grace" } },
    extensions: { mediaType: "application/pdf", fileSize: 9, comment: "q3" },
  };

  test("list: CQL scopes to the container; compact items carry type, size, author", async () => {
    route("/rest/api/content/search", { results: [ATTACHMENT, REPORT] });
    const result = await run(attachmentList, { page: "123456" });
    expect(lastQuery().get("cql")).toBe("type = attachment AND container = 123456");
    expect(lastQuery().get("expand")).toBe("extensions,version");
    expect(result).toMatchObject({
      items: [
        {
          id: "att77",
          title: "diagram.png",
          mediaType: "image/png",
          size: 1024,
          version: 2,
          by: "Ada",
          updated: "2026-01-02T03:04:05Z",
        },
        {
          id: "att78",
          title: "report.pdf",
          mediaType: "application/pdf",
          size: 9,
          comment: "q3",
          by: "Grace",
          updated: "2026-01-02T03:04:05Z",
        },
      ],
    });
  });

  test("list: --filename is an exact, quoted title match and --sort becomes order by", async () => {
    route("/rest/api/content/search", { results: [] });
    await run(attachmentList, { page: "123456" }, { filename: 'a "b".png', sort: "-created" });
    expect(lastQuery().get("cql")).toBe(
      'type = attachment AND container = 123456 AND title = "a \\"b\\".png" order by created desc',
    );
  });

  test("list: --media-type keeps attachments whose type starts with it", async () => {
    route("/rest/api/content/search", { results: [ATTACHMENT, REPORT] });
    const result = await run(attachmentList, { page: "123456" }, { mediaType: "image" });
    expect(itemsOf(result)).toMatchObject([{ id: "att77" }]);
  });

  test("list: nextCursor continues the search; --full returns raw objects", async () => {
    route("/rest/api/content/search", {
      results: [ATTACHMENT],
      _links: { next: "/rest/api/content/search?cql=x&cursor=c2&limit=1" },
    });
    const page = asRecord(await run(attachmentList, { page: "123456" }, { limit: 1 }));
    expect(page.nextCursor).toBe("c2");
    await run(attachmentList, { page: "123456" }, { cursor: "c1", limit: 1 });
    expect(lastQuery().get("cursor")).toBe("c1");
    const full = await run(attachmentList, { page: "123456" }, { limit: 1 }, ctx({ full: true }));
    expect(itemsOf(full)).toEqual([ATTACHMENT]);
  });

  test("list: a non-numeric page id is rejected before any request", async () => {
    const error = await rejection(run(attachmentList, { page: "x:y" }));
    expect(error.category).toBe("input");
    expect(calls).toEqual([]);
  });

  test("get: a bare number gets the att prefix and the page id is included", async () => {
    route("/rest/api/content/search", { results: [ATTACHMENT] });
    const result = await run(attachmentGet, { attachment: "77" });
    expect(lastQuery().get("cql")).toBe("type = attachment AND id = att77");
    expect(lastQuery().get("expand")).toBe("extensions,version,container");
    expect(result).toMatchObject({ id: "att77", pageId: "123456", mediaType: "image/png" });
  });

  test("get: unknown id is attachment_not_found; malformed id is rejected locally", async () => {
    route("/rest/api/content/search", { results: [] });
    expect((await rejection(run(attachmentGet, { attachment: "att9" }))).code).toBe(
      "attachment_not_found",
    );
    calls = [];
    expect((await rejection(run(attachmentGet, { attachment: "abc" }))).code).toBe(
      "invalid_attachment_ref",
    );
    expect(calls).toEqual([]);
  });
});

describe("space.get and space.personal", () => {
  const SPACE = {
    id: "98765",
    key: "ENG",
    name: "Engineering",
    type: "global",
    status: "current",
    homepageId: "100",
    spaceOwnerId: "acc-1",
    createdAt: "2026-01-02T03:04:05.000Z",
    description: { plain: { value: "Team space" } },
    labels: {
      results: [
        { id: "1", name: "runbooks", prefix: "global" },
        { id: "2", name: "x", prefix: "team" },
      ],
    },
    operations: {
      results: [
        { operation: "read", targetType: "space" },
        { operation: "create", targetType: "page" },
      ],
    },
    properties: { results: [{ id: "9", key: "k", value: { a: 1 } }] },
    _links: { webui: "/spaces/ENG", base: "https://acme.atlassian.net/wiki" },
  };

  test("get: resolves a key to the id, asks for plain description and the opted-in extras", async () => {
    routeUsers();
    route("/api/v2/spaces", { results: [{ id: "98765" }] });
    route("/api/v2/spaces/98765", SPACE);
    const result = await run(
      spaceGet,
      { space: "ENG" },
      { labels: true, operations: true, properties: true },
    );
    expect(calls[0]?.url.searchParams.get("keys")).toBe("ENG");
    const query = calls[1]?.url.searchParams;
    expect(query?.get("description-format")).toBe("plain");
    expect(query?.get("include-labels")).toBe("true");
    expect(query?.get("include-operations")).toBe("true");
    expect(query?.get("include-properties")).toBe("true");
    expect(result).toEqual({
      id: "98765",
      key: "ENG",
      name: "Engineering",
      homepageId: "100",
      owner: "Ada Lovelace",
      created: "2026-01-02T03:04:05Z",
      description: ["Team space"],
      labels: ["runbooks", "team:x"],
      operations: ["read", "create:page"],
      properties: [{ key: "k", value: { a: 1 } }],
      url: "https://acme.atlassian.net/wiki/spaces/ENG",
    });
  });

  test("get: extras are not requested unless asked; a numeric id skips the key lookup", async () => {
    routeUsers();
    route("/api/v2/spaces/98765", {
      ...SPACE,
      labels: undefined,
      operations: undefined,
      properties: undefined,
    });
    await run(spaceGet, { space: "98765" });
    expect(calls[0]?.url.pathname).toEndWith("/api/v2/spaces/98765");
    expect(calls[0]?.url.searchParams.has("include-labels")).toBe(false);
  });

  test("get: --full returns the raw space", async () => {
    route("/api/v2/spaces/98765", SPACE);
    expect(await run(spaceGet, { space: "98765" }, {}, ctx({ full: true }))).toEqual(SPACE);
  });

  test("personal: defaults to the caller's account and expands personalSpace", async () => {
    route("/me", { account_id: "acc-me" });
    route("/rest/api/user", {
      accountId: "acc-me",
      personalSpace: {
        id: 163842,
        key: "~acc-me",
        name: "Ada",
        _links: { webui: "/spaces/~acc-me" },
      },
    });
    const result = await run(spacePersonal, {});
    expect(lastQuery().get("accountId")).toBe("acc-me");
    expect(lastQuery().get("expand")).toBe("personalSpace");
    expect(result).toEqual({
      id: "163842",
      key: "~acc-me",
      name: "Ada",
      url: "https://acme.atlassian.net/wiki/spaces/~acc-me",
    });
  });

  test("personal: an explicit account id skips /me; no personal space is space_not_found", async () => {
    route("/rest/api/user", { accountId: "acc-9" });
    const error = await rejection(run(spacePersonal, { accountId: "acc-9" }));
    expect(error.code).toBe("space_not_found");
    expect(calls.map((call) => call.url.href)).not.toContain("https://api.atlassian.com/me");
    expect(lastQuery().get("accountId")).toBe("acc-9");
  });
});

const JSON_HEADERS = { "content-type": "application/json" };

function failure(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), { status, headers: JSON_HEADERS });
}

function stringLines(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((line) => typeof line === "string")) {
    throw new Error("expected an array of lines");
  }
  return value;
}

interface GrepRange {
  from: number;
  to: number;
  hits: number[];
  text: string[];
}

function matchesOf(result: unknown): GrepRange[] {
  const { matches } = asRecord(result);
  if (!Array.isArray(matches)) {
    throw new Error("expected a matches array");
  }
  return matches.map((range) => {
    const entry = asRecord(range);
    const from = Number(entry.from);
    return {
      from,
      to: entry.to === undefined ? from : Number(entry.to),
      hits: Array.isArray(entry.hits) ? entry.hits.map(Number) : [from],
      text: stringLines(entry.text),
    };
  });
}

function treeNode(id: string, depth: number, parentId: string) {
  return { id, title: `T${id}`, type: "page", status: "current", parentId, depth };
}

function probedPages(): string[] {
  return calls
    .filter((call) => call.url.pathname.endsWith("/direct-children"))
    .map((call) => call.url.pathname.split("/").at(-2) ?? "")
    .toSorted();
}

function storagePage(value: string) {
  return { ...PAGE, body: { storage: { value } } };
}

describe("page.tree depth and deepest-level markers", () => {
  test("asks for 5 levels when --depth is absent and flags deepest pages that have children", async () => {
    route("/api/v2/pages/123456/descendants", {
      results: [
        treeNode("1", 1, "123456"),
        treeNode("4", 4, "1"),
        treeNode("5a", 5, "4"),
        treeNode("5b", 5, "4"),
      ],
    });
    route("/api/v2/pages/5a/direct-children", { results: [{ id: "6" }] });
    route("/api/v2/pages/5b/direct-children", { results: [] });
    const result = await run(pageTree, { page: "123456" });
    expect(calls[0]?.url.searchParams.get("depth")).toBe("5");
    expect(itemsOf(result).map((item) => asRecord(item).hasChildren)).toEqual([
      undefined,
      undefined,
      true,
      undefined,
    ]);
    expect(probedPages()).toEqual(["5a", "5b"]);
  });

  test("--depth N marks pages at depth N, and only those are checked", async () => {
    route("/api/v2/pages/123456/descendants", {
      results: [treeNode("1", 1, "123456"), treeNode("2a", 2, "1"), treeNode("2b", 2, "1")],
    });
    route("/api/v2/pages/2a/direct-children", { results: [{ id: "3" }] });
    route("/api/v2/pages/2b/direct-children", { results: [{ id: "4" }] });
    const result = await run(pageTree, { page: "123456" }, { depth: 2 });
    expect(calls[0]?.url.searchParams.get("depth")).toBe("2");
    expect(itemsOf(result).map((item) => asRecord(item).hasChildren)).toEqual([
      undefined,
      true,
      true,
    ]);
    expect(probedPages()).toEqual(["2a", "2b"]);
  });
});

describe("bare ids and content-only links may be blog posts", () => {
  test("a bare id that is not a page is read as a blog post", async () => {
    route("/api/v2/blogposts/555", { ...PAGE, id: "555" });
    const result = await run(pageGet, { page: "555" });
    expect(calls.slice(0, 2).map((call) => call.url.pathname.split("/").at(-2))).toEqual([
      "pages",
      "blogposts",
    ]);
    expect(result).toMatchObject({ id: "555", type: "blogpost" });
  });

  test("viewer and tiny links carry only an id, so they probe too; page URLs and --type do not", async () => {
    route("/api/v2/blogposts/555", { ...PAGE, id: "555" });
    const viewer = await run(pageGet, {
      page: "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=555",
    });
    expect(viewer).toMatchObject({ type: "blogpost" });
    calls = [];
    const pageUrl = await rejection(
      run(pageGet, { page: "https://acme.atlassian.net/wiki/spaces/ENG/pages/555/T" }),
    );
    expect(pageUrl.status).toBe(404);
    expect(calls).toHaveLength(1);
    calls = [];
    const typed = await rejection(run(pageGet, { page: "555" }, { type: "page" }));
    expect(typed.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  test("a bare id missing in both collections reports the page 404", async () => {
    const error = await rejection(run(pageGet, { page: "999" }));
    expect(error.status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  test("versions, properties and comment list fall back to the blog post", async () => {
    routeUsers();
    route("/api/v2/blogposts/555/versions", { results: [{ number: 1, authorId: "acc-1" }] });
    route("/api/v2/blogposts/555/properties", { results: [{ key: "k", value: 1 }] });
    route("/api/v2/blogposts/555/footer-comments", { results: [FOOTER_COMMENT] });
    expect(itemsOf(await run(pageVersions, { page: "555" }))).toHaveLength(1);
    expect(itemsOf(await run(pageProperties, { page: "555" }))).toEqual([{ key: "k", value: 1 }]);
    expect(itemsOf(await run(commentList, { page: "555" }))).toHaveLength(1);
  });

  test("comment list retries blog posts after the page collection answers 400", async () => {
    route("/api/v2/pages/555/footer-comments", failure(400, "Invalid input"));
    route("/api/v2/blogposts/555/footer-comments", { results: [FOOTER_COMMENT] });
    routeUsers();
    expect(itemsOf(await run(commentList, { page: "555" }))).toHaveLength(1);
  });

  test("ancestors of a blog post id is an error, never an empty success", async () => {
    route("/rest/api/search", { results: [{ content: { id: "555", type: "blogpost" } }] });
    const error = await rejection(run(pageAncestors, { page: "555" }));
    expect(error.code).toBe("unsupported_for_blogpost");
  });

  test("diff of a blog post keeps --type blogpost in its next hint", async () => {
    route("/api/v2/blogposts/555", { ...PAGE, id: "555", version: { number: 1 } });
    const error = await rejection(run(pageDiff, { page: "555" }));
    expect(error.code).toBe("no_previous_version");
    expect(error.next).toEqual([["atl", "page", "versions", "555", "--type", "blogpost"]]);
  });
});

describe("references: versions, legacy links and sites", () => {
  test("a pageVersion link reads that version; an explicit --version wins", async () => {
    route("/api/v2/pages/123456", PAGE);
    const link = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/T?pageVersion=20";
    await run(pageGet, { page: link });
    expect(calls[0]?.url.searchParams.get("version")).toBe("20");
    calls = [];
    await run(pageGet, { page: link }, { version: 3 });
    expect(calls[0]?.url.searchParams.get("version")).toBe("3");
  });

  test("a /display/ link is resolved through the space's exact-title lookup", async () => {
    route("/api/v2/spaces", { results: [{ id: "98765", key: "ENG" }] });
    route("/api/v2/spaces/98765/pages", { results: [{ id: "123456", title: "My Title" }] });
    route("/api/v2/pages/123456", PAGE);
    const result = await run(pageGet, {
      page: "https://acme.atlassian.net/wiki/display/ENG/My+Title",
    });
    const lookup = calls.find((call) => call.url.pathname.endsWith("/spaces/98765/pages"));
    expect(lookup?.url.searchParams.get("title")).toBe("My Title");
    expect(result).toMatchObject({ id: "123456" });
  });

  test("a /display/ title with no page is a not-found error with the lookup as next", async () => {
    route("/api/v2/spaces", { results: [{ id: "98765", key: "ENG" }] });
    route("/api/v2/spaces/98765/pages", { results: [] });
    const error = await rejection(
      run(pageGet, { page: "https://acme.atlassian.net/wiki/display/ENG/Nope" }),
    );
    expect(error.code).toBe("page_not_found");
    expect(error.exitCode).toBe(2);
    expect(error.next).toEqual([["atl", "space", "pages", "ENG", "--title", "Nope"]]);
  });
});

describe("page titles as references", () => {
  const TITLED = { id: "111", title: "Runbook", spaceId: "1" };
  /** A page without a parent, so a read is one request. */
  const ROOT = { ...PAGE, parentId: undefined };

  test("a unique title resolves to its page without touching the id path", async () => {
    route("/api/v2/pages", { results: [TITLED] });
    route("/api/v2/pages/111", { ...ROOT, id: "111" });
    const result = await run(pageGet, { page: "Runbook" });
    expect(result).toMatchObject({ id: "111" });
    expect(calls[0]?.url.pathname).toEndWith("/api/v2/pages");
    expect(calls[0]?.url.searchParams.get("title")).toBe("Runbook");
    expect(calls.map((call) => call.url.pathname.split("/api/v2")[1])).toEqual([
      "/pages",
      "/pages/111",
    ]);
  });

  test("an exact-case title wins over case variants; a case variant alone still matches", async () => {
    route("/api/v2/pages", {
      results: [
        { id: "222", title: "runbook", spaceId: "1" },
        { id: "111", title: "Runbook", spaceId: "1" },
      ],
    });
    route("/api/v2/pages/111", { ...ROOT, id: "111" });
    expect(await run(pageGet, { page: "Runbook" })).toMatchObject({ id: "111" });
    route("/api/v2/pages", { results: [{ id: "222", title: "runbook", spaceId: "1" }] });
    route("/api/v2/pages/222", { ...ROOT, id: "222" });
    expect(await run(pageGet, { page: "RUNBOOK" })).toMatchObject({ id: "222" });
  });

  test("a title in several spaces is ambiguous_title listing id, space key and title", async () => {
    route("/api/v2/pages", {
      results: [TITLED, { id: "222", title: "Runbook", spaceId: "2" }],
    });
    route("/api/v2/spaces", {
      results: [
        { id: "1", key: "ENG" },
        { id: "2", key: "OPS" },
      ],
    });
    const error = await rejection(
      run(
        pageGet,
        { page: "Runbook" },
        {},
        ctx({ argv: ["page", "get", "Runbook", "--fields", "id"] }),
      ),
    );
    expect(error.code).toBe("ambiguous_title");
    expect(error.category).toBe("input");
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("111  ENG  Runbook");
    expect(error.message).toContain("222  OPS  Runbook");
    expect(error.next).toEqual([
      ["atl", "page", "get", "111", "--fields", "id"],
      ["atl", "page", "get", "222", "--fields", "id"],
    ]);
  });

  test("--space looks the title up inside that space", async () => {
    route("/api/v2/spaces", { results: [{ id: "1", key: "ENG" }] });
    route("/api/v2/spaces/1/pages", { results: [TITLED] });
    route("/api/v2/pages/111", { ...ROOT, id: "111" });
    expect(await run(pageGet, { page: "Runbook" }, { space: "ENG" })).toMatchObject({ id: "111" });
    expect(calls.some((call) => call.url.pathname.endsWith("/spaces/1/pages"))).toBe(true);
  });

  test("no match is not_found (exit 2) with a search hint", async () => {
    route("/api/v2/pages", { results: [] });
    const error = await rejection(run(pageGet, { page: "Nope" }));
    expect(error.code).toBe("not_found");
    expect(error.exitCode).toBe(2);
    expect(error.hint).toContain('atl search "Nope"');
  });

  test("a title with non-breaking spaces says so in the not-found hint", async () => {
    route("/api/v2/pages", { results: [] });
    const error = await rejection(run(pageGet, { page: "Run\u00A0book" }));
    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("non-breaking");
  });

  test("--type blogpost looks the title up among blog posts", async () => {
    route("/api/v2/blogposts", { results: [{ id: "555", title: "Weekly", spaceId: "1" }] });
    route("/api/v2/blogposts/555", { ...ROOT, id: "555" });
    expect(await run(pageGet, { page: "Weekly" }, { type: "blogpost" })).toMatchObject({
      id: "555",
    });
  });

  test("a numeric id is read directly, never looked up by title", async () => {
    route("/api/v2/pages/123456", ROOT);
    await run(pageGet, { page: "123456" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toEndWith("/api/v2/pages/123456");
  });

  test("other page commands take titles too", async () => {
    route("/api/v2/pages", { results: [TITLED] });
    route("/api/v2/pages/111/versions", { results: [] });
    route("/api/v2/pages/111/direct-children", { results: [] });
    await run(pageVersions, { page: "Runbook" });
    await run(pageChildren, { page: "Runbook" });
    expect(calls.map((call) => call.url.pathname.split("/api/v2")[1])).toEqual([
      "/pages",
      "/pages/111/versions",
      "/pages",
      "/pages/111/direct-children",
    ]);
  });
});

describe("references: ARIs of other sites", () => {
  test("an ARI of another site is not read on the default site", async () => {
    route("/oauth/token/accessible-resources", [
      {
        id: "cloud-1",
        url: "https://acme.atlassian.net",
        name: "acme",
        scopes: ["read:page:confluence"],
      },
    ]);
    const error = await rejection(
      run(pageGet, { page: "ari:cloud:confluence:00000000-0000-0000-0000-000000000000:page/1" }),
    );
    expect(error.code).toBe("site_not_accessible");
    expect(calls.some((call) => call.url.pathname.includes("/api/v2/pages/"))).toBe(false);
  });

  test("an ARI of this site is read", async () => {
    route("/api/v2/pages/123456", PAGE);
    await run(pageGet, { page: "ari:cloud:confluence:cloud-1:page/123456" });
    expect(calls[0]?.url.pathname).toBe("/ex/confluence/cloud-1/wiki/api/v2/pages/123456");
  });
});

describe("page.get --grep output bounds", () => {
  test("a long single line shows excerpts around the hits, not the whole line", async () => {
    const line = `${"x".repeat(2500)} needle ${"y".repeat(1500)} needle ${"z".repeat(1000)}`;
    route("/api/v2/pages/123456", storagePage(line));
    const result = asRecord(
      await run(pageGet, { page: "123456" }, { grep: "needle", format: "storage" }),
    );
    const [range] = matchesOf(result);
    expect(result.lines).toBe(1);
    expect(range?.text.length).toBeGreaterThanOrEqual(2);
    expect(range?.text.every((piece) => piece.length < 400)).toBe(true);
    expect(range?.text.filter((piece) => piece.includes("needle"))).toHaveLength(2);
  });

  test("merged adjacent hits are split into ranges of a bounded number of lines", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => `EUR ${i + 1}`).join("\n");
    route("/api/v2/pages/123456", storagePage(rows));
    const result = asRecord(
      await run(pageGet, { page: "123456" }, { grep: "EUR", format: "storage" }),
    );
    const ranges = matchesOf(result);
    expect(ranges).toHaveLength(5);
    expect(ranges.every((range) => range.to - range.from + 1 <= 20)).toBe(true);
    expect(ranges.flatMap((range) => range.hits)).toHaveLength(100);
  });

  test("a pattern hitting thousands of adjacent lines prints 20 ranges and counts the rest", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `EUR ${i + 1}`).join("\n");
    route("/api/v2/pages/123456", storagePage(rows));
    const result = asRecord(
      await run(pageGet, { page: "123456" }, { grep: "EUR", format: "storage" }),
    );
    expect(result.matches).toHaveLength(20);
    expect(result.moreMatches).toBe(30);
  });

  test("a hit's own --context is never cut by the range size", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => (i === 100 ? "needle" : `row ${i}`));
    route("/api/v2/pages/123456", storagePage(rows.join("\n")));
    const result = asRecord(
      await run(pageGet, { page: "123456" }, { grep: "needle", format: "storage", context: 40 }),
    );
    expect(result.matches).toEqual([{ from: 61, to: 141, hits: [101], text: rows.slice(60, 141) }]);
  });

  test("patterns match the text without markdown backslash escapes; the printed line is the original", async () => {
    route("/api/v2/pages/123456", {
      ...PAGE,
      body: { atlas_doc_format: { value: adf("see C:\\Temp and *not italic* here") } },
    });
    for (const pattern of ["C:\\\\Temp", "\\*not italic\\*", "C:.Temp and .not"]) {
      const result = asRecord(await run(pageGet, { page: "123456" }, { grep: pattern }));
      expect(result.matches).toHaveLength(1);
    }
  });

  test("no match keeps an empty matches list visible in compact output", async () => {
    route("/api/v2/pages/123456", PAGE);
    const result = await run(pageGet, { page: "123456" }, { grep: "absent" });
    expect(asRecord(prune(result)).matches).toEqual([]);
  });
});

describe("page.get --format storage body lines", () => {
  test("storage XHTML is printed as lines within the line budget; --output gets the original", async () => {
    const storage = `<p>${"word ".repeat(400)}</p>\n<p>end</p>`;
    route("/api/v2/pages/123456", { ...PAGE, body: { storage: { value: storage } } });
    const result = asRecord(await run(pageGet, { page: "123456" }, { format: "storage" }));
    const lines = stringLines(result.body);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => Buffer.byteLength(JSON.stringify(line)) <= 600)).toBe(true);
    expect(sourceMarkdown(lines)).toBe(storage);
  });
});

describe("page.get / diff with a version that does not exist", () => {
  test("page get --version out of range points at page versions", async () => {
    routeBy("/api/v2/pages/123456", (url) => (url.searchParams.has("version") ? undefined : PAGE));
    const error = await rejection(run(pageGet, { page: "123456" }, { version: 999 }));
    expect(error.status).toBe(404);
    expect(error.hint).toContain("999");
    expect(error.next).toEqual([["atl", "page", "versions", "123456"]]);
  });

  test("page diff --from out of range points at page versions", async () => {
    routeBy("/api/v2/pages/123456", (url) =>
      url.searchParams.get("version") === "50" ? undefined : { ...PAGE, version: { number: 4 } },
    );
    const error = await rejection(run(pageDiff, { page: "123456" }, { from: 50 }));
    expect(error.next).toEqual([["atl", "page", "versions", "123456"]]);
  });
});

describe("page.versions and page.diff titles", () => {
  test("versions carry the title each version had", async () => {
    routeUsers();
    route("/api/v2/pages/123456/versions", {
      results: [
        { number: 2, authorId: "acc-1", page: { id: "123456", title: "Incident Contact Sheet" } },
        { number: 1, authorId: "acc-1", page: { id: "123456", title: "Oncall Contacts (draft)" } },
      ],
    });
    const result = await run(pageVersions, { page: "123456" });
    expect(itemsOf(result).map((item) => asRecord(item).title)).toEqual([
      "Incident Contact Sheet",
      "Oncall Contacts (draft)",
    ]);
  });

  test("a title repeated from the row above is omitted", async () => {
    routeUsers();
    route("/api/v2/pages/123456/versions", {
      results: [
        { number: 3, authorId: "acc-1", page: { id: "123456", title: "A" } },
        { number: 2, authorId: "acc-1", page: { id: "123456", title: "A" } },
        { number: 1, authorId: "acc-1", page: { id: "123456", title: "B" } },
      ],
    });
    const result = await run(pageVersions, { page: "123456" });
    expect(itemsOf(result).map((item) => asRecord(item).title)).toEqual(["A", undefined, "B"]);
  });

  test("a rename shows as {from, to}; an unchanged title does not", async () => {
    const same = paragraphs("same");
    routeBy("/api/v2/pages/123456", (url) => {
      const number = Number(url.searchParams.get("version") ?? 3);
      return {
        ...PAGE,
        title: number === 3 ? "New name" : "Old name",
        version: { number },
        body: { atlas_doc_format: { value: same } },
      };
    });
    const renamed = asRecord(await run(pageDiff, { page: "123456" }));
    expect(renamed).toMatchObject({
      title: "New name",
      renamed: { from: "Old name", to: "New name" },
      added: 0,
      removed: 0,
    });
    const unchanged = asRecord(await run(pageDiff, { page: "123456" }, { from: 3, to: 3 }));
    expect(unchanged.renamed).toBeUndefined();
  });
});

describe("comment reads without a kind", () => {
  test("comment get tries inline when the id is not a footer comment", async () => {
    routeUsers();
    route("/api/v2/inline-comments/9100", INLINE_COMMENT);
    const result = await run(commentGet, { comment: "9100" });
    expect(calls[0]?.url.pathname).toEndWith("/footer-comments/9100");
    expect(calls[1]?.url.pathname).toEndWith("/inline-comments/9100");
    expect(result).toMatchObject({ id: "9100", type: "inline-comment", selection: "Hello" });
  });

  test("an explicit --kind is never retried; a miss in both reports the footer 404", async () => {
    route("/api/v2/inline-comments/9100", INLINE_COMMENT);
    const footer = await rejection(run(commentGet, { comment: "9100" }, { kind: "footer" }));
    expect(footer.status).toBe(404);
    expect(calls).toHaveLength(1);
    calls = [];
    const both = await rejection(run(commentGet, { comment: "1" }));
    expect(both.status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  test("replies and versions use the same kind lookup", async () => {
    routeUsers();
    route("/api/v2/inline-comments/9100/children", { results: [] });
    route("/api/v2/inline-comments/9100/versions", { results: [{ number: 1, authorId: "acc-1" }] });
    await run(commentReplies, { comment: "9100" });
    expect(calls.at(-1)?.url.pathname).toEndWith("/inline-comments/9100/children");
    expect(itemsOf(await run(commentVersions, { comment: "9100" }))).toHaveLength(1);
  });

  test("comment get --version reads that version of the comment", async () => {
    routeUsers();
    route("/api/v2/footer-comments/9001", FOOTER_COMMENT);
    await run(commentGet, { comment: "9001" }, { version: 1 });
    expect(calls[0]?.url.searchParams.get("version")).toBe("1");
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
  });

  test("a comment on a blog post is labelled blogPostId, not pageId", async () => {
    routeUsers();
    route("/api/v2/footer-comments/9005", {
      ...FOOTER_COMMENT,
      id: "9005",
      pageId: undefined,
      blogPostId: "555",
    });
    const result = asRecord(await run(commentGet, { comment: "9005" }));
    expect(result.blogPostId).toBe("555");
    expect(result.pageId).toBeUndefined();
  });
});

describe("cql and space listings", () => {
  test("expanded ancestors stay in the compact result as titles", async () => {
    route("/rest/api/search", {
      results: [
        {
          content: {
            id: "1",
            type: "page",
            space: { key: "ENG" },
            ancestors: [{ title: "Home" }, { title: "Docs" }],
          },
          title: "Page",
        },
      ],
    });
    const result = await run(cql, { query: "id = 1" }, { expand: "content.ancestors" });
    expect(itemsOf(result)[0]).toMatchObject({ id: "1", ancestors: ["Home", "Docs"] });
  });

  test("an attachment hit names the page it belongs to", async () => {
    route("/rest/api/search", {
      results: [
        {
          content: { id: "att7", type: "attachment", title: "a.csv" },
          url: "/pages/viewpageattachments.action?pageId=5603349&preview=%2F5603349%2F7%2Fa.csv",
        },
      ],
    });
    const result = await run(cql, { query: "type = attachment" });
    expect(itemsOf(result)[0]).toMatchObject({ id: "att7", pageId: "5603349" });
  });

  test("a 400 on `title =` points at the exact-title lookup", async () => {
    route("/rest/api/search", failure(400, "illegal request"));
    const error = await rejection(run(cql, { query: 'title = "a \\"b\\""' }));
    expect(error.status).toBe(400);
    expect(error.hint).toContain("space pages");
    const other = await rejection(run(cql, { query: 'text ~ "a \\"b\\""' }));
    expect(other.hint ?? "").not.toContain("space pages");
  });

  test("a deterministic server NullPointerException is an input error, not transient", async () => {
    route(
      "/rest/api/search",
      failure(500, "java.lang.NullPointerException: query parameter is required."),
    );
    const error = await rejection(run(cql, { query: 'text ~ "\\""' }));
    expect(error.code).toBe("invalid_cql");
    expect(error.category).toBe("input");
  });

  test("an unquoted non-ASCII CQL value gets a quoting hint", async () => {
    route("/rest/api/search", failure(400, "BadRequestException: Unrecognised clause at : nzgy"));
    const error = await rejection(run(cql, { query: "label = pénzügy" }));
    expect(error.status).toBe(400);
    expect(error.hint).toContain('label = "pénzügy"');
  });

  test("space pages items always say their type, even when the API omits it", async () => {
    route("/api/v2/spaces/98765/pages", { results: [{ id: "1", title: "A" }] });
    route("/api/v2/spaces/98765/blogposts", { results: [{ id: "2", title: "B" }] });
    expect(itemsOf(await run(spacePages, { space: "98765" }))).toEqual([
      { id: "1", title: "A", type: "page" },
    ]);
    expect(itemsOf(await run(spacePages, { space: "98765" }, { type: "blogpost" }))).toEqual([
      { id: "2", title: "B", type: "blogpost" },
    ]);
  });
});

describe("not-found is one category", () => {
  test("attachment, personal-space and page lookups are api errors (exit 2)", async () => {
    route("/rest/api/content/search", { results: [] });
    const attachment = await rejection(run(attachmentGet, { attachment: "att1" }));
    expect(attachment.category).toBe("api");
    route("/rest/api/user", { accountId: "acc" });
    const personal = await rejection(run(spacePersonal, { accountId: "acc" }));
    expect(personal.exitCode).toBe(2);
    route("/rest/api/search", { results: [] });
    const ancestors = await rejection(run(pageAncestors, { page: "1" }));
    expect(ancestors.exitCode).toBe(2);
  });
});
