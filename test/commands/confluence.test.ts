import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confluenceCommands,
  confluenceDeps,
  commentGet,
  commentReplies,
  commentList,
  commentVersions,
  cql,
  pageChildren,
  pageGet,
  pageVersions,
  pageLabels,
  pageTree,
  spaceList,
  spacePages,
} from "../../src/commands/confluence.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { makeContext } from "../helpers/context.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";

interface Call {
  url: URL;
}

let configDir: string;
let calls: Call[] = [];
let routes: Map<string, unknown> = new Map();

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
    const body = routes.get(path);
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
  return spec.run(context, { args, rest: [], flags });
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
    const result = await run(pageGet, { page: "123456" });
    expect(lastQuery().get("body-format")).toBe("atlas_doc_format");
    expect(result).toEqual({
      id: "123456",
      type: "page",
      title: "Runbook",
      spaceId: "98765",
      parentId: "100",
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
    expect(lastQuery().get("body-format")).toBe("storage");
    expect(result).toMatchObject({ body: "<p>Hello <b>world</b></p>" });
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
    expect(result).toEqual({ items: [{ id: "7", title: "Home" }], nextCursor: null });
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
    expect(error.category).toBe("input");
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

  test("--inline uses /inline-comments and exposes resolution and selection", async () => {
    routeUsers();
    route("/api/v2/pages/123456/inline-comments", { results: [INLINE_COMMENT] });
    const result = await run(commentList, { page: "123456" }, { inline: true, resolution: "open" });
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

  test("--resolution without --inline is an input error and sends no request", async () => {
    const error = await rejection(run(commentList, { page: "123456" }, { resolution: "open" }));
    expect(error.category).toBe("input");
    expect(calls).toHaveLength(0);
  });

  test("--replies nests children fetched per top-level comment", async () => {
    routeUsers();
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    route("/api/v2/footer-comments/9001/children", {
      results: [{ ...FOOTER_COMMENT, id: "9002", parentCommentId: "9001" }],
    });
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
    expect(calls).toHaveLength(3);
    expect(lastQuery().getAll("accountId")).toEqual(["acc-1"]);
  });

  test("--replies reports repliesNextCursor and --full keeps raw comments", async () => {
    route("/api/v2/pages/123456/footer-comments", { results: [FOOTER_COMMENT] });
    route("/api/v2/footer-comments/9001/children", {
      results: [{ ...FOOTER_COMMENT, id: "9002", parentCommentId: "9001" }],
      _links: { next: "/wiki/api/v2/footer-comments/9001/children?cursor=RC&limit=1" },
    });
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

  test("--replies with --inline fetches from the inline children endpoint", async () => {
    route("/api/v2/pages/123456/inline-comments", { results: [INLINE_COMMENT] });
    route("/api/v2/inline-comments/9100/children", { results: [] });
    routeUsers();
    const result = await run(commentList, { page: "123456" }, { inline: true, replies: true });
    expect(calls[1]?.url.pathname).toEndWith("/inline-comments/9100/children");
    expect(asRecord(itemsOf(result)[0]).replies).toBeUndefined();
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

  test("get --inline uses the inline endpoint with --format adf", async () => {
    routeUsers();
    route("/api/v2/inline-comments/9100", INLINE_COMMENT);
    const result = await run(commentGet, { comment: "9100" }, { inline: true, format: "adf" });
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
  test("read commands declare the MCP tools they replace", () => {
    const mapped = Object.fromEntries(
      confluenceCommands.map((spec) => [spec.name, spec.mcpTools ?? []]),
    );
    expect(mapped).toMatchObject({
      "page.get": ["getConfluencePage"],
      "page.tree": ["getConfluencePageDescendants"],
      "space.list": ["getConfluenceSpaces"],
      "space.pages": ["getPagesInConfluenceSpace"],
      "comment.list": ["getConfluencePageFooterComments", "getConfluencePageInlineComments"],
      "comment.replies": ["getConfluenceCommentChildren"],
      cql: ["searchConfluenceUsingCql"],
    });
  });

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
    await run(commentReplies, { comment: "9100" }, { inline: true, sort: "modified-date" });
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
