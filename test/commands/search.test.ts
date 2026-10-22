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
): Promise<unknown> {
  const context = { ...ctx, ...overrides };
  const result = await command(name).run(context, { args, rest: [], flags });
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
});
