import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchCommands, searchDeps } from "../../src/commands/search.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { prune } from "../../src/core/output.ts";
import { makeContext } from "../helpers/context.ts";
import { withDiagnostics } from "../helpers/stderr.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const CONFLUENCE_SEARCH = `/ex/confluence/${CLOUD}/wiki/rest/api/search`;
const JIRA_SEARCH = `/ex/jira/${CLOUD}/rest/api/3/search/jql`;
const USER_PICKER = `/ex/jira/${CLOUD}/rest/api/3/groupuserpicker`;

interface Call {
  path: string;
  query: URLSearchParams;
}

let root: string;
let ctx: CommandContext;
let calls: Call[];

type Responder = (query: URLSearchParams) => unknown;

function isResponder(value: unknown): value is Responder {
  return typeof value === "function";
}

/** Serve `routes[path]` as JSON; a function route is called with the request's query. */
function respond(routes: Record<string, unknown>): void {
  searchDeps.fetch = (input) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, query: url.searchParams });
    const route = routes[url.pathname];
    if (route === undefined) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    const payload = isResponder(route) ? route(url.searchParams) : route;
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function command(name: string): CommandSpec {
  const spec = searchCommands.find((c) => c.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

async function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  overrides: Partial<CommandContext> = {},
  rest: string[] = [],
): Promise<unknown> {
  const context = { ...ctx, ...overrides };
  const result = await command(name).run(context, { args, rest, flags });
  return context.full ? result : prune(result);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected an object result");
  }
  return value;
}

function itemsOf(value: unknown): Record<string, unknown>[] {
  const items = recordOf(value).items;
  if (!Array.isArray(items)) {
    throw new Error("expected a result with an items array");
  }
  return items.map((item: unknown) => recordOf(item));
}

async function failure(promise: Promise<unknown>): Promise<AtlError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AtlError)) {
    throw new Error("expected an AtlError rejection");
  }
  return error;
}

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const pageHit = (id: string, title: string) => ({
  content: { id, type: "page" },
  title: `@@@hl@@@${title}@@@endhl@@@`,
  excerpt: "  first   line\nsecond @@@hl@@@line@@@endhl@@@ ",
  url: `/spaces/ENG/pages/${id}/x`,
  lastModified: "2026-10-01T10:00:00.000Z",
});

const issueHit = (id: string, key: string) => ({
  id,
  key,
  fields: {
    summary: `Issue ${key}`,
    updated: "2026-10-02T10:00:00.000+0000",
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    project: { key: "ABC", name: "Alpha" },
    description: adf(`Details of ${key}`),
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-search-test-"));
  const env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
  await saveConfig(
    {
      sites: {
        "acme.atlassian.net": {
          cloudId: CLOUD,
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["read:jira-work"],
          cachedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
    env,
  );
  ctx = makeContext(env);
  calls = [];
});

afterEach(async () => {
  searchDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("user.find", () => {
  const PICKER = {
    users: {
      users: [
        {
          accountId: "acc-1",
          accountType: "atlassian",
          displayName: "Ada Lovelace",
          html: "<strong>Ada</strong> Lovelace - <strong>ada</strong>@example.com",
          avatarUrl: "https://avatar.example/ada.png",
        },
        {
          accountId: "acc-2",
          accountType: "app",
          displayName: "Bot",
          html: "<strong>Bot</strong>",
        },
      ],
      total: 2,
    },
    groups: { groups: [{ name: "jira-users" }], total: 1 },
  };

  test("queries the user picker and compacts users, parsing the email from html", async () => {
    respond({ [USER_PICKER]: PICKER });
    const result = await run("user.find", { query: "ada" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("query")).toBe("ada");
    expect(calls[0]?.query.get("maxResults")).toBe("10");
    expect(calls[0]?.query.has("showAvatar")).toBe(false);
    expect(result).toEqual({
      items: [
        {
          accountId: "acc-1",
          displayName: "Ada Lovelace",
          email: "ada@example.com",
          accountType: "atlassian",
        },
        { accountId: "acc-2", displayName: "Bot", accountType: "app" },
      ],
    });
  });

  test("--avatar requests and returns avatar URLs; --limit sets maxResults", async () => {
    respond({ [USER_PICKER]: PICKER });
    const items = itemsOf(await run("user.find", { query: "ada" }, { avatar: true, limit: 3 }));

    expect(calls[0]?.query.get("showAvatar")).toBe("true");
    expect(calls[0]?.query.get("maxResults")).toBe("3");
    expect(items[0]?.avatarUrl).toBe("https://avatar.example/ada.png");
    expect(items[1]).not.toHaveProperty("avatarUrl");
  });

  test("--full returns the raw picker users", async () => {
    respond({ [USER_PICKER]: PICKER });
    const result = recordOf(await run("user.find", { query: "ada" }, {}, { full: true }));
    expect(result.items).toEqual(PICKER.users.users);
  });

  test("an empty query is an input error", async () => {
    respond({});
    const error = await failure(run("user.find", { query: "  " }));
    expect(error.code).toBe("empty_query");
    expect(calls).toHaveLength(0);
  });
});

/** Run `search` and return its stdout value plus the JSONL diagnostics it wrote to stderr. */
async function searchWithStderr(
  flags: Record<string, unknown>,
): Promise<{ result: unknown; diagnostics: unknown[] }> {
  return withDiagnostics(() => run("search", { query: "ghost" }, flags));
}

describe("search", () => {
  test("searches both products with text queries and compacts hits, interleaved", async () => {
    respond({
      [CONFLUENCE_SEARCH]: { results: [pageHit("1", "Alpha"), pageHit("2", "Beta")] },
      [JIRA_SEARCH]: { issues: [issueHit("10", "ABC-1"), issueHit("11", "ABC-2")], isLast: true },
    });
    const result = await run("search", { query: 'say "hi"' }, { limit: 4 });

    const confluence = calls.find((call) => call.path === CONFLUENCE_SEARCH);
    const jira = calls.find((call) => call.path === JIRA_SEARCH);
    expect(confluence?.query.get("cql")).toBe('text ~ "say \\"hi\\""');
    expect(confluence?.query.get("limit")).toBe("2");
    expect(jira?.query.get("jql")).toBe('text ~ "say \\"hi\\""');
    expect(jira?.query.get("maxResults")).toBe("2");
    expect(jira?.query.get("fields")).toContain("description");

    expect(itemsOf(result)).toEqual([
      {
        id: "1",
        type: "page",
        title: "Alpha",
        text: "first line second line",
        lastModified: "2026-10-01T10:00:00Z",
      },
      {
        key: "ABC-1",
        type: "issue",
        title: "Issue ABC-1",
        text: "Details of ABC-1",
        lastModified: "2026-10-02T10:00:00+0000",
        status: "In Progress",
      },
      expect.objectContaining({ id: "2" }),
      expect.objectContaining({ key: "ABC-2" }),
    ]);
    expect(recordOf(result).nextCursor).toBeUndefined();
  });

  test("hits that id and type cannot rebuild keep a short url", async () => {
    respond({
      [CONFLUENCE_SEARCH]: {
        results: [
          {
            content: { id: "7", type: "attachment" },
            title: "report.pdf",
            url: "/spaces/ENG/pages/1/Title?preview=%2F1%2F7%2Freport.pdf",
            lastModified: "2026-10-01T10:00:00.000Z",
          },
        ],
      },
    });
    const items = itemsOf(await run("search", { query: "q" }, { product: "confluence" }));
    expect(items).toEqual([
      {
        id: "7",
        type: "attachment",
        title: "report.pdf",
        lastModified: "2026-10-01T10:00:00Z",
        url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1?preview=%2F1%2F7%2Freport.pdf",
      },
    ]);
  });

  test("--type issue searches only Jira; --type page adds a CQL type clause", async () => {
    respond({
      [CONFLUENCE_SEARCH]: { results: [pageHit("1", "Alpha")] },
      [JIRA_SEARCH]: { issues: [issueHit("10", "ABC-1")], isLast: true },
    });

    await run("search", { query: "q" }, { type: "issue" });
    expect(calls.map((call) => call.path)).toEqual([JIRA_SEARCH]);

    calls.length = 0;
    await run("search", { query: "q" }, { type: "page" });
    expect(calls.map((call) => call.path)).toEqual([CONFLUENCE_SEARCH]);
    expect(calls[0]?.query.get("cql")).toBe('text ~ "q" AND type = page');
  });

  test("--product limits to one product and rejects a contradicting --type", async () => {
    respond({ [JIRA_SEARCH]: { issues: [issueHit("10", "ABC-1")], isLast: true } });
    const items = itemsOf(await run("search", { query: "q" }, { product: "jira" }));
    expect(items).toHaveLength(1);
    expect(calls.map((call) => call.path)).toEqual([JIRA_SEARCH]);

    const error = await failure(run("search", { query: "q" }, { product: "jira", type: "page" }));
    expect(error.code).toBe("conflicting_filters");
  });

  test("--limit 1 alternates products and resumes from nextCursor without repeats", async () => {
    const confluencePages = new Map([
      [
        undefined,
        { results: [pageHit("1", "Alpha")], _links: { next: "/rest/api/search?cursor=c2" } },
      ],
      ["c2", { results: [pageHit("2", "Beta")] }],
    ]);
    const jiraPages = new Map([
      [undefined, { issues: [issueHit("10", "ABC-1")], nextPageToken: "j2" }],
      ["j2", { issues: [issueHit("11", "ABC-2")], isLast: true }],
    ]);
    respond({
      [CONFLUENCE_SEARCH]: (query: URLSearchParams) =>
        confluencePages.get(query.get("cursor") ?? undefined),
      [JIRA_SEARCH]: (query: URLSearchParams) =>
        jiraPages.get(query.get("nextPageToken") ?? undefined),
    });

    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      const result = recordOf(await run("search", { query: "q" }, { limit: 1, cursor }));
      const items = itemsOf(result);
      expect(items.length).toBeLessThanOrEqual(1);
      seen.push(...items.map((item) => item.id ?? item.key));
      const next = result.nextCursor;
      if (typeof next !== "string") {
        expect(next).toBeUndefined();
        break;
      }
      cursor = next;
    }

    expect(seen).toEqual(["1", "ABC-1", "2", "ABC-2"]);
    const resumedConfluence = calls.findLast((call) => call.path === CONFLUENCE_SEARCH);
    expect(resumedConfluence?.query.get("cursor")).toBe("c2");
    const resumedJira = calls.findLast((call) => call.path === JIRA_SEARCH);
    expect(resumedJira?.query.get("nextPageToken")).toBe("j2");
  });

  test("tops up from the remaining product when one is exhausted", async () => {
    respond({
      [CONFLUENCE_SEARCH]: { results: [pageHit("1", "Alpha")] },
      [JIRA_SEARCH]: (query: URLSearchParams) =>
        query.get("maxResults") === "2"
          ? { issues: [issueHit("10", "ABC-1"), issueHit("11", "ABC-2")], nextPageToken: "j2" }
          : { issues: [issueHit("12", "ABC-3")], isLast: true },
    });
    const result = recordOf(await run("search", { query: "q" }, { limit: 4 }));
    expect(itemsOf(result)).toHaveLength(4);
    expect(result.nextCursor).toBeUndefined();
    const jiraTakes = calls
      .filter((call) => call.path === JIRA_SEARCH)
      .map((call) => call.query.get("maxResults"));
    expect(jiraTakes).toEqual(["2", "1"]);
  });

  test("--full returns raw hits", async () => {
    const hit = pageHit("1", "Alpha");
    respond({ [CONFLUENCE_SEARCH]: { results: [hit] } });
    const result = await run("search", { query: "q" }, { product: "confluence" }, { full: true });
    expect(recordOf(result).items).toEqual([hit]);
  });

  test("rejects an empty query and a foreign cursor before any request", async () => {
    respond({});
    expect((await failure(run("search", { query: " " }))).code).toBe("empty_query");
    expect((await failure(run("search", { query: "q" }, { cursor: "bogus" }))).code).toBe(
      "invalid_cursor",
    );
    expect(calls).toHaveLength(0);
  });

  describe("empty results", () => {
    test("zero items hint title and summary queries, which differ from the text query that ran", async () => {
      respond({
        [CONFLUENCE_SEARCH]: { results: [] },
        [JIRA_SEARCH]: { issues: [], isLast: true },
      });
      const { result, diagnostics } = await searchWithStderr({});
      expect(itemsOf(result)).toEqual([]);
      expect(diagnostics).toEqual([
        {
          type: "hint",
          code: "empty_search",
          hint: expect.stringContaining("alternate terms"),
          next: [
            ["atl", "cql", 'title ~ "ghost"'],
            ["atl", "jql", 'summary ~ "ghost"'],
          ],
        },
      ]);
      for (const call of calls) {
        for (const suggested of ['title ~ "ghost"', 'summary ~ "ghost"']) {
          expect([call.query.get("cql"), call.query.get("jql")]).not.toContain(suggested);
        }
      }
    });

    test("the hint follows --product and --type", async () => {
      respond({
        [CONFLUENCE_SEARCH]: { results: [] },
        [JIRA_SEARCH]: { issues: [], isLast: true },
      });
      const confluence = await searchWithStderr({ product: "confluence", type: "page" });
      expect(recordOf(confluence.diagnostics[0]).next).toEqual([
        ["atl", "cql", 'title ~ "ghost" AND type = page'],
      ]);
      const jira = await searchWithStderr({ product: "jira" });
      expect(recordOf(jira.diagnostics[0]).next).toEqual([["atl", "jql", 'summary ~ "ghost"']]);
    });

    test("an empty Confluence answer is retried once before the search reports no hits", async () => {
      let attempts = 0;
      respond({
        [CONFLUENCE_SEARCH]: () => {
          attempts += 1;
          return attempts === 1 ? { results: [] } : { results: [pageHit("1", "Alpha")] };
        },
      });
      const { result, diagnostics } = await searchWithStderr({ product: "confluence" });
      expect(attempts).toBe(2);
      expect(itemsOf(result)).toHaveLength(1);
      expect(diagnostics).toEqual([]);
    });

    test("results, or an empty continuation page, write no hint", async () => {
      respond({
        [CONFLUENCE_SEARCH]: (query: URLSearchParams) =>
          query.has("cursor")
            ? { results: [] }
            : { results: [pageHit("1", "Alpha")], _links: { next: "/x?cursor=C2" } },
      });
      const first = await searchWithStderr({ product: "confluence", limit: 1 });
      expect(itemsOf(first.result)).toHaveLength(1);
      expect(first.diagnostics).toEqual([]);
      const cursor = recordOf(first.result).nextCursor;
      const next = await searchWithStderr({ product: "confluence", limit: 1, cursor });
      expect(itemsOf(next.result)).toEqual([]);
      expect(next.diagnostics).toEqual([]);
    });
  });

  test("Confluence hits carry spaceKey and the parent page title", async () => {
    respond({
      [CONFLUENCE_SEARCH]: {
        results: [
          {
            content: {
              id: "7",
              type: "page",
              ancestors: [{ title: "Root" }, { title: "Runbooks" }],
            },
            resultGlobalContainer: { title: "Engineering", displayUrl: "/spaces/ENG" },
            title: "Restart Procedure",
            url: "/spaces/ENG/pages/7/x",
          },
        ],
      },
    });
    const items = itemsOf(await run("search", { query: "restart" }, { product: "confluence" }));
    expect(items).toEqual([
      { id: "7", type: "page", title: "Restart Procedure", spaceKey: "ENG", parent: "Runbooks" },
    ]);
    expect(calls[0]?.query.get("expand")).toBe("content.ancestors");
  });

  test("upper-case AND/OR/NOT and a leading dash in the text are literal in CQL and JQL", async () => {
    respond({
      [CONFLUENCE_SEARCH]: { results: [pageHit("1", "A")] },
      [JIRA_SEARCH]: { issues: [issueHit("10", "ABC-1")], isLast: true },
    });
    await run("search", { query: "NOT ANDROID AND OR -draft a-b BRAND" });
    const literal = 'text ~ "not ANDROID and or \\\\-draft a-b BRAND"';
    expect(calls.find((call) => call.path === CONFLUENCE_SEARCH)?.query.get("cql")).toBe(literal);
    expect(calls.find((call) => call.path === JIRA_SEARCH)?.query.get("jql")).toBe(literal);
  });
});

describe("user.get", () => {
  const BULK = `/ex/confluence/${CLOUD}/wiki/rest/api/user/bulk`;
  const ADA = {
    type: "known",
    accountId: "acc-1",
    accountType: "atlassian",
    accountStatus: "active",
    displayName: "Ada",
    email: "ada@example.com",
    locale: "en_US",
    profilePicture: { path: "/x" },
  };

  test("looks up every id in one bulk call and reports unknown ids", async () => {
    respond({ [BULK]: { results: [ADA] } });
    const result = await run("user.get", {}, {}, {}, ["acc-1", "acc-1", "gone"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.getAll("accountId")).toEqual(["acc-1", "gone"]);
    expect(result).toEqual({
      items: [{ accountId: "acc-1", name: "Ada", email: "ada@example.com", locale: "en_US" }],
      missing: ["gone"],
    });
  });

  test("shows account type and status only when unusual", async () => {
    respond({
      [BULK]: {
        results: [
          { accountId: "app-1", accountType: "app", accountStatus: "inactive", displayName: "Bot" },
        ],
      },
    });
    expect(await run("user.get", {}, {}, {}, ["app-1"])).toEqual({
      items: [{ accountId: "app-1", name: "Bot", type: "app", status: "inactive" }],
    });
  });

  test("splits more than 200 ids across requests; --full is raw", async () => {
    respond({ [BULK]: { results: [ADA] } });
    const ids = Array.from({ length: 201 }, (_, i) => `acc-${i}`);
    await run("user.get", {}, {}, {}, ids);
    expect(calls.map((c) => c.query.getAll("accountId").length)).toEqual([200, 1]);

    respond({ [BULK]: { results: [ADA] } });
    const full = await run("user.get", {}, {}, { full: true }, ["acc-1"]);
    expect(recordOf(full).items).toEqual([ADA]);
  });
});
