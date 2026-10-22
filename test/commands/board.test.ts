import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardCommands } from "../../src/commands/board.ts";
import { jiraDeps } from "../../src/commands/jira.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { prune } from "../../src/core/output.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const PREFIX = `/ex/jira/${CLOUD}`;
const BOARD_ARI = `ari:cloud:jira-software:${CLOUD}:board/1`;

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

let root: string;
let env: NodeJS.ProcessEnv;
let calls: Call[];
/** GraphQL replies by operation name; REST replies by `METHOD /path`. */
let gql: Record<string, unknown>;
let rest: Record<string, unknown>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-board-test-"));
  env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
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
  calls = [];
  gql = {};
  rest = {};
  jiraDeps.fetch = (input, init) => {
    const url = new URL(input);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? "GET";
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    calls.push({ method, path, query: url.searchParams, body });
    if (path === "/graphql") {
      const operation = isRecord(body) ? String(body.operationName) : "";
      return Promise.resolve(json(gql[operation] ?? { errors: [{ message: "no op" }] }));
    }
    const reply = rest[`${method} ${path}`];
    return Promise.resolve(
      reply === undefined
        ? new Response(JSON.stringify({ errorMessages: ["no route"] }), { status: 404 })
        : json(reply),
    );
  };
});

afterEach(async () => {
  jiraDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

function command(name: string): CommandSpec {
  const spec = boardCommands.find((c) => c.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

async function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  ctx: Partial<CommandContext> = {},
): Promise<unknown> {
  const result = await command(name).run(makeContext(env, ctx), { args, rest: [], flags });
  return ctx.full === true ? result : prune(result);
}

const BOARD = {
  data: {
    jira: {
      jiraBoard: {
        __typename: "JiraBoard",
        boardId: 1,
        name: "KAN board",
        boardType: "KANBAN",
        baseJql: null,
        boardUrl: "https://acme.atlassian.net/jira/software/projects/KAN/boards/1",
        canEdit: true,
        favouriteValue: { isFavourite: false },
      },
    },
  },
};

describe("board.list", () => {
  test("pages recentBoards by endCursor and returns compact items", async () => {
    gql.BoardList = {
      data: {
        jira: {
          recentBoards: {
            edges: [
              {
                node: {
                  boardId: 1,
                  name: "KAN board",
                  boardUrl: "https://acme.atlassian.net/jira/software/projects/KAN/boards/1",
                  lastViewedTimestamp: 1792612999918,
                },
              },
              { node: { boardId: 2, name: "Ops", boardUrl: "https://acme.atlassian.net/b/2" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: "x" },
          },
        },
      },
    };
    const result = await run("board.list", {});
    expect(calls[0]?.body).toMatchObject({
      operationName: "BoardList",
      variables: { cloudId: CLOUD, first: 50 },
    });
    expect(result).toEqual({
      items: [
        {
          id: 1,
          name: "KAN board",
          url: "https://acme.atlassian.net/jira/software/projects/KAN/boards/1",
          lastViewed: "2026-10-21T20:03:19Z",
        },
        { id: 2, name: "Ops", url: "https://acme.atlassian.net/b/2" },
      ],
    });
  });

  test("--name filters client-side and an open page returns nextCursor", async () => {
    gql.BoardList = {
      data: {
        jira: {
          recentBoards: {
            edges: [
              { node: { boardId: 1, name: "KAN board" } },
              { node: { boardId: 2, name: "Ops" } },
            ],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
      },
    };
    const result = await run("board.list", {}, { name: "ops", limit: 1 });
    expect(result).toEqual({ items: [{ id: 2, name: "Ops" }], nextCursor: "c1" });
  });
});

describe("board.get", () => {
  test("queries the board ARI and drops default booleans", async () => {
    gql.BoardGet = BOARD;
    const result = await run("board.get", { board: "1" });
    expect(calls[0]?.body).toMatchObject({ variables: { id: BOARD_ARI } });
    expect(result).toEqual({
      id: 1,
      name: "KAN board",
      type: "KANBAN",
      project: "KAN",
      url: "https://acme.atlassian.net/jira/software/projects/KAN/boards/1",
    });
  });

  test("accepts a board URL and --full returns the raw node", async () => {
    gql.BoardGet = BOARD;
    const result = await run(
      "board.get",
      { board: "https://acme.atlassian.net/jira/software/projects/KAN/boards/1" },
      {},
      { full: true },
    );
    expect(calls[0]?.body).toMatchObject({ variables: { id: BOARD_ARI } });
    expect(result).toMatchObject({ boardId: 1, baseJql: null, canEdit: true });
  });

  test("a QueryError result becomes not_found with the board list as next step", async () => {
    gql.BoardGet = {
      data: { jira: { jiraBoard: { __typename: "QueryError", message: "no such board" } } },
    };
    const error = await run("board.get", { board: "9" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code: "not_found", next: [["atl", "board", "list"]] });
  });

  test("a non-numeric board is an input error before any request", async () => {
    const error = await run("board.get", { board: "kanban" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_board" });
    expect(calls).toHaveLength(0);
  });
});

describe("board.issues", () => {
  const ISSUES = {
    issues: [
      {
        id: "10001",
        key: "KAN-1",
        fields: { summary: "One", status: { name: "To Do" }, issuetype: { name: "Task" } },
      },
    ],
    isLast: true,
  };

  test("falls back to the project of a filterless board and orders by rank", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    const result = await run("board.issues", { board: "1" });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("jql")).toBe(
      '(project = "KAN") ORDER BY Rank ASC',
    );
    expect(result).toEqual({
      items: [{ key: "KAN-1", summary: "One", status: "To Do", type: "Task" }],
    });
  });

  test("uses the board filter, adds backlog and extra JQL clauses", async () => {
    gql.BoardGet = {
      data: {
        jira: {
          jiraBoard: { ...BOARD.data.jira.jiraBoard, baseJql: "project = KAN AND type = Bug" },
        },
      },
    };
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    await run("board.issues", { board: "1" }, { dataset: "backlog", jql: "labels = x" });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("jql")).toBe(
      "(project = KAN AND type = Bug) AND sprint is EMPTY AND (labels = x) ORDER BY Rank ASC",
    );
  });

  test("a trailing ORDER BY in --jql replaces the default order instead of landing inside the parentheses", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    await run("board.issues", { board: "1" }, { jql: "labels = x ORDER BY key ASC" });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("jql")).toBe(
      '(project = "KAN") AND (labels = x) ORDER BY key ASC',
    );
  });

  test("--jql that is only an ORDER BY adds no clause, and an ORDER BY inside a string is not split", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    await run("board.issues", { board: "1" }, { jql: "order by created DESC" });
    await run("board.issues", { board: "1" }, { jql: 'summary ~ "order by x"' });
    const sent = calls
      .filter((c) => c.path === "/rest/api/3/search/jql")
      .map((c) => c.query.get("jql"));
    expect(sent).toEqual([
      '(project = "KAN") order by created DESC',
      '(project = "KAN") AND (summary ~ "order by x") ORDER BY Rank ASC',
    ]);
  });

  test("--count ignores the ORDER BY", async () => {
    gql.BoardGet = BOARD;
    rest["POST /rest/api/3/search/approximate-count"] = { count: 3 };
    await run("board.issues", { board: "1" }, { count: true, jql: "labels = x ORDER BY key" });
    expect(
      calls.find((c) => c.method === "POST" && c.path.endsWith("approximate-count"))?.body,
    ).toEqual({ jql: '(project = "KAN") AND (labels = x)' });
  });

  test("--count posts the same clauses to approximate-count", async () => {
    gql.BoardGet = BOARD;
    rest["POST /rest/api/3/search/approximate-count"] = { count: 182 };
    const result = await run("board.issues", { board: "1" }, { count: true, dataset: "backlog" });
    expect(
      calls.find((c) => c.method === "POST" && c.path.endsWith("approximate-count"))?.body,
    ).toEqual({
      jql: '(project = "KAN") AND sprint is EMPTY',
    });
    expect(result).toEqual({ count: 182 });
  });
});

describe("board.sprints", () => {
  const FIELDS = [
    { id: "summary" },
    { id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
  ];

  test("aggregates sprints from the Sprint field and filters by state", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/field"] = FIELDS;
    rest["GET /rest/api/3/search/jql"] = {
      issues: [
        {
          key: "KAN-1",
          fields: {
            customfield_10020: [
              { id: 7, name: "S1", state: "closed", startDate: "2026-10-01T10:00:00.000Z" },
              { id: 8, name: "S2", state: "active", goal: "Ship" },
            ],
          },
        },
        { key: "KAN-2", fields: { customfield_10020: [{ id: 8, name: "S2", state: "active" }] } },
      ],
      isLast: true,
    };
    const all = await run("board.sprints", { board: "1" }, { issues: true });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("fields")).toBe(
      "customfield_10020",
    );
    expect(all).toEqual({
      items: [
        {
          id: 7,
          name: "S1",
          state: "closed",
          start: "2026-10-01T10:00:00Z",
          issueCount: 1,
          issues: ["KAN-1"],
        },
        {
          id: 8,
          name: "S2",
          state: "active",
          goal: "Ship",
          issueCount: 2,
          issues: ["KAN-1", "KAN-2"],
        },
      ],
    });
    const active = await run("board.sprints", { board: "1" }, { state: "active" });
    expect(active).toEqual({
      items: [{ id: 8, name: "S2", state: "active", goal: "Ship", issueCount: 2 }],
    });
  });

  test("a site without a Sprint field has no sprints", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/field"] = [{ id: "summary" }];
    expect(await run("board.sprints", { board: "1" })).toEqual({ items: [] });
    expect(calls.some((c) => c.path === "/rest/api/3/search/jql")).toBe(false);
  });
});
