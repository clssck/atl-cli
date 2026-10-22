import { Type } from "../core/schema.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { graphql, tokenPage } from "../core/graphql.ts";
import { isRecord } from "../core/guards.ts";
import { paginateJiraToken, type Paged } from "../core/paginate.ts";
import { openSession, type Session } from "../core/session.ts";
import { PAGING_FLAGS, pagePolicy, queryLiteral, shortTs } from "./common.ts";
import { approximateCount, compactIssue, fetchFields, jiraDeps, searchJql } from "./jira.ts";

export const boardGroups: Readonly<Record<string, string>> = {
  board:
    "Jira boards through the GraphQL gateway (agile REST is not reachable with the OAuth token)",
};

/**
 * Boards are read through the GraphQL `jira` root: `recentBoards` enumerates the boards the user has
 * opened, `jiraBoard` reads one. Fields such as `sprintSearch` and `JiraBoard.statusDurations` are
 * blocked for third-party OAuth clients, so board filters, columns and sprints come from REST instead.
 */
const BOARDS_DOCUMENT = `query BoardList($cloudId: ID!, $first: Int, $after: String) {
  jira { recentBoards(cloudId: $cloudId, first: $first, after: $after) {
    edges { node { boardId name boardUrl lastViewedTimestamp } }
    pageInfo { hasNextPage endCursor }
  } }
}`;

const BOARD_DOCUMENT = `query BoardGet($id: ID!) {
  jira { jiraBoard(id: $id) {
    __typename
    ... on JiraBoard {
      boardId name boardType baseJql boardUrl canEdit
      favouriteValue { isFavourite }
      customFilters(first: 50) { edges { node { __typename } } }
    }
    ... on QueryError { message extensions { statusCode } }
  } }
}`;

interface BoardNode {
  boardId?: number;
  name?: string;
  boardType?: string;
  baseJql?: string | null;
  boardUrl?: string;
  canEdit?: boolean;
  lastViewedTimestamp?: number;
  favouriteValue?: { isFavourite?: boolean } | null;
}

interface Connection<T> {
  edges?: { node?: T }[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}

/** `ari:cloud:jira-software:<cloudId>:board/<id>`; the gateway takes the ARI, users pass the number. */
function boardAri(session: Session, board: string): { ari: string; id: string } {
  const id = /^\d+$/.test(board.trim())
    ? board.trim()
    : (/board\/(\d+)/.exec(board)?.[1] ?? /boards\/(\d+)/.exec(board)?.[1]);
  if (id === undefined) {
    throw new AtlError(`Not a board id or URL: ${board}`, {
      code: "invalid_board",
      category: "input",
      hint: "Pass the numeric board id (see `atl board list`) or a board URL.",
      next: [["atl", "board", "list"]],
    });
  }
  return { ari: `ari:cloud:jira-software:${session.site.cloudId}:board/${id}`, id };
}

async function loadBoard(session: Session, board: string): Promise<BoardNode & { id: string }> {
  const { ari, id } = boardAri(session, board);
  const { data } = await graphql(session.http, {
    operationName: "BoardGet",
    query: BOARD_DOCUMENT,
    variables: { id: ari },
  });
  const jira = isRecord(data.jira) ? data.jira : {};
  const result = isRecord(jira.jiraBoard) ? jira.jiraBoard : undefined;
  if (result === undefined || result.__typename !== "JiraBoard") {
    const message =
      result !== undefined && typeof result.message === "string" ? result.message : "not found";
    throw new AtlError(`Board ${id}: ${message}`, {
      code: "not_found",
      category: "api",
      hint: "Check the board id with `atl board list` (only boards you have opened are listed).",
      next: [["atl", "board", "list"]],
    });
  }
  return { ...(result as BoardNode), id };
}

/** Project key from a board URL `/projects/<KEY>/boards/<id>`. */
const projectKeyOf = (url: string | undefined): string | undefined =>
  /\/projects\/([^/]+)\/boards\//.exec(url ?? "")?.[1];

/**
 * JQL that selects the board's issues: its filter when the gateway exposes one, else the whole
 * project the board URL names (team-managed boards carry no separate filter).
 */
function boardJql(board: BoardNode & { id: string }): string {
  const base = board.baseJql?.trim();
  if (base !== undefined && base !== "") {
    return base;
  }
  const project = projectKeyOf(board.boardUrl);
  if (project === undefined) {
    throw new AtlError(`Board ${board.id} exposes no filter or project to derive its issues from`, {
      code: "board_jql_unavailable",
      category: "api",
      hint: "Query the issues directly with `atl jql`.",
    });
  }
  return `project = ${queryLiteral(project)}`;
}

const boardList = defineCommand({
  name: "board.list",
  summary: "List Jira boards you have opened recently (the gateway cannot enumerate others)",
  mcpTools: ["listJiraBoards"],
  args: [],
  flags: Type.Object({
    name: Type.Optional(Type.String({ description: "Only boards whose name contains this text" })),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: ["atl board list", "atl board list --name kanban"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const wanted = input.flags.name?.toLowerCase();
    const paged = await paginateJiraToken(
      pagePolicy(input.flags, { defaultLimit: 50, maxPageSize: 50 }),
      (page: { nodes: BoardNode[]; nextPageToken?: string; isLast: boolean }) =>
        wanted === undefined
          ? page.nodes
          : page.nodes.filter((node) => (node.name ?? "").toLowerCase().includes(wanted)),
      async ({ cursor, pageSize }) => {
        const { data } = await graphql(session.http, {
          operationName: "BoardList",
          query: BOARDS_DOCUMENT,
          variables: {
            cloudId: session.site.cloudId,
            first: pageSize,
            ...(cursor === undefined ? {} : { after: cursor }),
          },
        });
        const jira = isRecord(data.jira) ? data.jira : {};
        const boards = (
          isRecord(jira.recentBoards) ? jira.recentBoards : {}
        ) as Connection<BoardNode>;
        return {
          nodes: (boards.edges ?? []).flatMap((edge) =>
            edge.node === undefined ? [] : [edge.node],
          ),
          ...tokenPage(boards.pageInfo),
        };
      },
    );
    return ctx.full
      ? paged
      : {
          ...paged,
          items: paged.items.map((board) => ({
            id: board.boardId,
            name: board.name,
            type: board.boardType,
            url: board.boardUrl,
            lastViewed:
              board.lastViewedTimestamp === undefined
                ? undefined
                : shortTs(new Date(board.lastViewedTimestamp).toISOString()),
          })),
        };
  },
});

const BOARD_ARG = {
  name: "board",
  description: "Board id (see `atl board list`) or board URL",
  required: true,
};

const boardGet = defineCommand({
  name: "board.get",
  summary:
    "Show a board: name, type, filter JQL (or its project), favourite flag. Column layout and status mapping are not exposed to OAuth tokens",
  mcpTools: ["getJiraBoardConfig"],
  args: [BOARD_ARG],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl board get 1"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const board = await loadBoard(session, input.args.board ?? "");
    if (ctx.full) {
      return board;
    }
    return {
      id: board.boardId ?? board.id,
      name: board.name,
      type: board.boardType,
      jql: board.baseJql ?? undefined,
      project: projectKeyOf(board.boardUrl),
      favourite: board.favouriteValue?.isFavourite === true ? true : undefined,
      readOnly: board.canEdit === false ? true : undefined,
      url: board.boardUrl,
    };
  },
});

const ISSUE_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];

const DATASETS = ["board", "backlog", "all"] as const;

async function searchIssues(
  ctx: CommandContext,
  session: Session,
  jql: string,
  flags: { limit?: number | undefined; all?: boolean | undefined; cursor?: string | undefined },
): Promise<Paged<unknown>> {
  const paged = await searchJql(
    session,
    pagePolicy(flags, { defaultLimit: 25, maxPageSize: 100 }),
    jql,
    ISSUE_FIELDS.join(","),
  );
  return {
    ...paged,
    items: paged.items.map((issue) =>
      ctx.full ? issue : compactIssue(session, issue, undefined, false, true),
    ),
  };
}

/** A trailing `ORDER BY` cannot sit inside the parenthesised filter, so it is split off (outside string literals). */
function splitOrderBy(jql: string): { where: string; order: string | undefined } {
  const orderBy = /\border\s+by\b/iy;
  let quote: string | undefined;
  for (let i = 0; i < jql.length; i++) {
    const char = jql[i];
    if (quote !== undefined) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else {
      orderBy.lastIndex = i;
      if (orderBy.test(jql)) {
        return { where: jql.slice(0, i).trim(), order: jql.slice(i).trim() };
      }
    }
  }
  return { where: jql.trim(), order: undefined };
}

const boardIssues = defineCommand({
  name: "board.issues",
  summary:
    "Issues on a board (its filter, or its project when the filter is hidden), its backlog (no sprint), or both; optional extra JQL",
  mcpTools: ["getJiraBoardIssueData"],
  args: [BOARD_ARG],
  flags: Type.Object({
    dataset: Type.Optional(
      Type.Union(
        DATASETS.map((name) => Type.Literal(name)),
        { description: "board (default), backlog (issues in no sprint), or all" },
      ),
    ),
    jql: Type.Optional(
      Type.String({
        description:
          "Extra JQL ANDed with the board's filter; a trailing ORDER BY replaces the default Rank ordering",
      }),
    ),
    count: Type.Optional(Type.Boolean({ description: "Return only the approximate count" })),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl board issues 1",
    'atl board issues 1 --jql "statusCategory != Done" --limit 50',
    "atl board issues 1 --dataset backlog --count",
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const board = await loadBoard(session, input.args.board ?? "");
    const clauses = [`(${boardJql(board)})`];
    if (input.flags.dataset === "backlog") {
      clauses.push("sprint is EMPTY");
    }
    let order: string | undefined;
    if (input.flags.jql !== undefined) {
      const split = splitOrderBy(input.flags.jql);
      order = split.order;
      if (split.where !== "") {
        clauses.push(`(${split.where})`);
      }
    }
    const jql = `${clauses.join(" AND ")} ${order ?? "ORDER BY Rank ASC"}`;
    if (input.flags.count === true) {
      return { count: await approximateCount(session, clauses.join(" AND ")) };
    }
    return searchIssues(ctx, session, jql, input.flags);
  },
});

interface Sprint {
  id?: number;
  name?: string;
  state?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  boardId?: number;
}

const boardSprints = defineCommand({
  name: "board.sprints",
  summary:
    "Sprints seen on a board's issues (active, future, closed), read from the Sprint field; the sprint list itself is not exposed to OAuth tokens",
  mcpTools: ["getJiraBoardSprintData"],
  args: [BOARD_ARG],
  flags: Type.Object({
    state: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("future"), Type.Literal("closed")], {
        description: "Only sprints in this state",
      }),
    ),
    issues: Type.Optional(Type.Boolean({ description: "Include the issue keys in each sprint" })),
  }),
  sideEffects: "none",
  examples: ["atl board sprints 2", "atl board sprints 2 --state active --issues"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const board = await loadBoard(session, input.args.board ?? "");
    const fields = await fetchFields(session);
    const sprintField = fields.find((field) => field.schema?.custom?.endsWith(":gh-sprint"))?.id;
    if (sprintField === undefined) {
      return { items: [] };
    }
    const jql = `(${boardJql(board)}) AND sprint is not EMPTY`;
    const sprints = new Map<number, Sprint & { issues: string[] }>();
    const paged = await searchJql<{ key: string; fields?: Record<string, unknown> }>(
      session,
      { all: true, defaultLimit: 1000, maxPageSize: 100 },
      jql,
      sprintField,
    );
    for (const issue of paged.items) {
      const values = issue.fields?.[sprintField];
      for (const value of Array.isArray(values) ? values : []) {
        if (!isRecord(value) || typeof value.id !== "number") {
          continue;
        }
        const entry = sprints.get(value.id) ?? { ...(value as Sprint), issues: [] };
        entry.issues.push(issue.key);
        sprints.set(value.id, entry);
      }
    }
    const wanted = input.flags.state?.toLowerCase();
    const items = [...sprints.values()]
      .filter((sprint) => wanted === undefined || (sprint.state ?? "").toLowerCase() === wanted)
      .toSorted((a, b) => (a.id ?? 0) - (b.id ?? 0));
    if (ctx.full) {
      return { items, nextCursor: null };
    }
    return {
      items: items.map((sprint) => ({
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        goal: sprint.goal,
        start: shortTs(sprint.startDate),
        end: shortTs(sprint.endDate),
        completed: shortTs(sprint.completeDate),
        issueCount: sprint.issues.length,
        issues: input.flags.issues === true ? sprint.issues : undefined,
      })),
    };
  },
});

export const boardCommands: readonly CommandSpec[] = [
  boardList,
  boardGet,
  boardIssues,
  boardSprints,
];
