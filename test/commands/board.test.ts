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

function graphqlCalls(name: string): typeof calls {
  return calls.filter((c) => isRecord(c.body) && c.body.operationName === name);
}

/** `jiraProjectByKey` answer listing the project's boards. */
function projectBoards(nodes: unknown[]): unknown {
  return {
    data: {
      jira: {
        jiraProjectByKey: { key: "KAN", boards: { edges: nodes.map((node) => ({ node })) } },
      },
    },
  };
}

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

  test("a value that is neither an id, a URL nor a project key is an input error before any request", async () => {
    const error = await run("board.get", { board: "not a board!" }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "invalid_board",
      hint: expect.stringContaining("project key"),
    });
    expect(calls).toHaveLength(0);
  });

  describe("by project key", () => {
    test("a key, a lowercase key and a browse URL resolve the project's only board", async () => {
      gql.ProjectBoards = projectBoards([{ boardId: 1, name: "KAN board", boardType: "KANBAN" }]);
      gql.BoardGet = BOARD;
      for (const board of ["KAN", "kan", "https://acme.atlassian.net/browse/KAN-7"]) {
        await run("board.get", { board });
      }
      expect(graphqlCalls("ProjectBoards").map((c) => c.body)).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ variables: { key: "KAN", cloudId: CLOUD } }),
        ),
      );
      expect(graphqlCalls("BoardGet").map((c) => c.body)).toEqual(
        Array.from({ length: 3 }, () => expect.objectContaining({ variables: { id: BOARD_ARI } })),
      );
    });

    test("a board id or board URL never looks the project up", async () => {
      gql.BoardGet = BOARD;
      await run("board.get", { board: "1" });
      await run("board.get", {
        board: "https://acme.atlassian.net/jira/software/projects/KAN/boards/1",
      });
      expect(graphqlCalls("ProjectBoards")).toHaveLength(0);
    });

    test("several boards are ambiguous and list id, name and type", async () => {
      gql.ProjectBoards = projectBoards([
        { boardId: 1, name: "KAN board", boardType: "KANBAN" },
        { boardId: 9, name: "KAN sprints", boardType: "SCRUM" },
      ]);
      const error = await run("board.get", { board: "KAN" }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "ambiguous_board",
        hint: expect.stringContaining('9 "KAN sprints" (SCRUM)'),
      });
    });

    test("a project without boards or an unknown project is board_not_found", async () => {
      gql.ProjectBoards = projectBoards([]);
      const none = await run("board.get", { board: "KAN" }).catch((e: unknown) => e);
      expect(none).toMatchObject({ code: "board_not_found", message: "Project KAN has no board" });
      gql.ProjectBoards = {
        errors: [{ message: "no such key", extensions: { statusCode: 404 } }],
        data: null,
      };
      const unknown = await run("board.get", { board: "ZZZ" }).catch((e: unknown) => e);
      expect(unknown).toMatchObject({ code: "board_not_found", message: "Project ZZZ not found" });
    });
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

  test("the default item fields are the same list jql uses", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    await run("board.issues", { board: "1" });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("fields")).toBe(
      "summary,status,issuetype,priority,assignee,updated",
    );
  });

  test("--issue-fields requests the named fields in place of the default list", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = {
      issues: [
        {
          id: "10001",
          key: "KAN-1",
          fields: { summary: "One", labels: ["nm-duplicate"], issuelinks: [] },
        },
      ],
      isLast: true,
    };
    const result = await run("board.issues", { board: "1" }, { issueFields: "summary,labels" });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("fields")).toBe(
      "summary,labels",
    );
    expect(result).toEqual({ items: [{ key: "KAN-1", summary: "One", labels: ["nm-duplicate"] }] });
  });

  test("--issue-fields resolves display names and shows them under that name", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/field"] = [
      { id: "customfield_10016", name: "Story point estimate", custom: true },
    ];
    rest["GET /rest/api/3/search/jql"] = {
      issues: [{ id: "10001", key: "KAN-1", fields: { customfield_10016: 5 } }],
      isLast: true,
    };
    const result = await run(
      "board.issues",
      { board: "1" },
      { issueFields: "Story point estimate" },
    );
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("fields")).toBe(
      "customfield_10016",
    );
    expect(result).toEqual({ items: [{ key: "KAN-1", "Story point estimate": 5 }] });
  });

  test("--issue-fields description renders the description", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = {
      issues: [
        {
          id: "10001",
          key: "KAN-1",
          fields: {
            description: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
            },
          },
        },
      ],
      isLast: true,
    };
    const result = await run("board.issues", { board: "1" }, { issueFields: "description" });
    expect(result).toEqual({ items: [{ key: "KAN-1", description: ["Body"] }] });
  });

  test("--count cannot be combined with --issue-fields and fails before any request", async () => {
    const error = await run(
      "board.issues",
      { board: "1" },
      { count: true, issueFields: "summary" },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "conflicting_flags",
      message: "--count cannot be combined with --issue-fields",
    });
    expect(calls).toEqual([]);
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

  test("--sprint maps an id, a state and a name onto the sprint JQL clause", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    for (const sprint of ["4", "active", "Closed", 'Sprint "Q1"']) {
      await run("board.issues", { board: "1" }, { sprint });
    }
    expect(
      calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => c.query.get("jql")),
    ).toEqual([
      '(project = "KAN") AND sprint = 4 ORDER BY Rank ASC',
      '(project = "KAN") AND sprint in openSprints() ORDER BY Rank ASC',
      '(project = "KAN") AND sprint in closedSprints() ORDER BY Rank ASC',
      '(project = "KAN") AND sprint = "Sprint \\"Q1\\"" ORDER BY Rank ASC',
    ]);
  });

  test("--sprint contradicts the backlog dataset and is refused before any search", async () => {
    gql.BoardGet = BOARD;
    const error = await run(
      "board.issues",
      { board: "1" },
      { sprint: "4", dataset: "backlog" },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_flags" });
    expect(calls.some((c) => c.path === "/rest/api/3/search/jql")).toBe(false);
  });

  describe("a company-managed scrum board", () => {
    const SCRUM = {
      data: {
        jira: {
          jiraBoard: {
            ...BOARD.data.jira.jiraBoard,
            boardId: 2,
            boardType: "SCRUM",
            boardUrl: "https://acme.atlassian.net/jira/software/c/projects/NMS/boards/2",
          },
        },
      },
    };

    test("leaves epics out of the board's issues", async () => {
      gql.BoardGet = SCRUM;
      rest["GET /rest/api/3/search/jql"] = ISSUES;
      await run("board.issues", { board: "2" });
      expect(
        calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => c.query.get("jql")),
      ).toEqual(['(project = "NMS") AND hierarchyLevel != 1 ORDER BY Rank ASC']);
    });

    test("the backlog is unfinished work outside open and future sprints, without epics", async () => {
      gql.BoardGet = SCRUM;
      rest["POST /rest/api/3/search/approximate-count"] = { count: 15 };
      await run("board.issues", { board: "2" }, { dataset: "backlog", count: true });
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("approximate-count"))?.body,
      ).toEqual({
        jql: '(project = "NMS") AND hierarchyLevel != 1 AND (sprint is EMPTY OR sprint not in (openSprints(), futureSprints())) AND statusCategory != Done',
      });
    });
  });

  test("a team-managed scrum board keeps its epics but its backlog still omits them", async () => {
    gql.BoardGet = {
      data: {
        jira: { jiraBoard: { ...BOARD.data.jira.jiraBoard, boardType: "SCRUM" } },
      },
    };
    rest["GET /rest/api/3/search/jql"] = ISSUES;
    await run("board.issues", { board: "1" });
    await run("board.issues", { board: "1" }, { dataset: "backlog" });
    expect(
      calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => c.query.get("jql")),
    ).toEqual([
      '(project = "KAN") ORDER BY Rank ASC',
      '(project = "KAN") AND hierarchyLevel != 1 AND (sprint is EMPTY OR sprint not in (openSprints(), futureSprints())) AND statusCategory != Done ORDER BY Rank ASC',
    ]);
  });
});

/** A sprint-field issue as the search returns it; customfield_10042 is a look-alike points field. */
function sprintIssue(
  key: string,
  category: string,
  points: number | undefined,
  sprints: unknown[],
  subtask = false,
): { key: string; fields: Record<string, unknown> } {
  return {
    key,
    fields: {
      customfield_10020: sprints,
      status: { name: "localized", statusCategory: { key: category } },
      issuetype: { subtask },
      customfield_10016: points,
      customfield_10042: 99,
    },
  };
}

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

  test("the field catalog is requested while the board is still loading", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/field"] = [{ id: "summary" }];
    const served = jiraDeps.fetch;
    const { promise: fieldsRequested, resolve: release } = Promise.withResolvers<void>();
    // The board answers only once the field request has arrived: a sequential command never sends
    // it, so the board never loads and the test times out.
    jiraDeps.fetch = async (input, init) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/rest/api/3/field")) {
        release();
      } else if (path.endsWith("/graphql")) {
        await fieldsRequested;
      }
      if (served === undefined) {
        throw new Error("no fetch stub");
      }
      return served(input, init);
    };
    expect(await run("board.sprints", { board: "1" })).toEqual({ items: [] });
  });

  test("--summary totals points by status category, reports carry-over and velocity", async () => {
    gql.BoardGet = BOARD;
    rest["GET /rest/api/3/field"] = [
      ...FIELDS,
      {
        id: "customfield_10042",
        name: "Story Points",
        schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
      },
      {
        id: "customfield_10016",
        name: "Story point estimate",
        schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
      },
    ];
    const s1 = { id: 7, name: "S1", state: "closed" };
    const s2 = { id: 8, name: "S2", state: "closed" };
    const s3 = { id: 9, name: "S3", state: "active" };
    rest["GET /rest/api/3/search/jql"] = {
      issues: [
        sprintIssue("KAN-1", "done", 5, [s1]),
        sprintIssue("KAN-2", "indeterminate", 8, [s1, s2, s3]),
        sprintIssue("KAN-3", "done", 3, [s2, s3]),
        sprintIssue("KAN-4", "new", undefined, [s3]),
        sprintIssue("KAN-5", "indeterminate", undefined, [s3], true),
      ],
      isLast: true,
    };
    const result = await run("board.sprints", { board: "1" }, { summary: true });
    expect(calls.find((c) => c.path === "/rest/api/3/search/jql")?.query.get("fields")).toBe(
      "customfield_10020,status,issuetype,customfield_10016",
    );
    expect(result).toEqual({
      items: [
        {
          id: 7,
          name: "S1",
          state: "closed",
          issueCount: 2,
          byStatus: { todo: 0, inProgress: 1, done: 1 },
          points: { todo: 0, inProgress: 8, done: 5, remaining: 8, total: 13 },
          velocity: 5,
          carriedOut: ["KAN-2"],
        },
        {
          id: 8,
          name: "S2",
          state: "closed",
          issueCount: 2,
          byStatus: { todo: 0, inProgress: 1, done: 1 },
          points: { todo: 0, inProgress: 8, done: 3, remaining: 8, total: 11 },
          velocity: 0,
          carriedIn: ["KAN-2"],
          carriedOut: ["KAN-2", "KAN-3"],
        },
        {
          id: 9,
          name: "S3",
          state: "active",
          issueCount: 4,
          byStatus: { todo: 1, inProgress: 2, done: 1 },
          points: { todo: 0, inProgress: 8, done: 3, remaining: 8, total: 11 },
          unestimated: ["KAN-4"],
          carriedIn: ["KAN-2", "KAN-3"],
        },
      ],
    });
  });
});
