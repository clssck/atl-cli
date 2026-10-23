import { Type } from "../core/schema.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { graphql, tokenPage } from "../core/graphql.ts";
import { isRecord } from "../core/guards.ts";
import { paginateJiraToken, type Paged } from "../core/paginate.ts";
import { openSession, type Session } from "../core/session.ts";
import { PAGING_FLAGS, pagePolicy, queryLiteral, shortTs } from "./common.ts";
import {
  approximateCount,
  compactIssue,
  conflictingFlags,
  fetchFields,
  ISSUE_FIELDS_FLAG,
  jiraDeps,
  LIST_ISSUE_FIELDS,
  requestedFields,
  searchJql,
  type FieldRecord,
} from "./jira.ts";

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
function boardAri(session: Session, id: string): string {
  return `ari:cloud:jira-software:${session.site.cloudId}:board/${id}`;
}

const PROJECT_BOARDS_DOCUMENT = `query ProjectBoards($key: String!, $cloudId: ID!) {
  jira { jiraProjectByKey(key: $key, cloudId: $cloudId) {
    key
    boards(first: 50) { edges { node { boardId name boardType } } }
  } }
}`;

/** The board id in a numeric id or board URL, else the project key in a project key or project/browse URL. */
function parseBoardRef(ref: string): { id: string } | { project: string } {
  const text = ref.trim();
  const id = /^\d+$/.test(text) ? text : /\/boards?\/(\d+)/.exec(text)?.[1];
  if (id !== undefined) {
    return { id };
  }
  const project = /^[A-Za-z][A-Za-z0-9_]*$/.test(text)
    ? text
    : /\/(?:projects|browse)\/([A-Za-z][A-Za-z0-9_]*)/.exec(text)?.[1];
  if (project === undefined) {
    throw new AtlError(`Not a board id, board URL or project key: ${ref}`, {
      code: "invalid_board",
      category: "input",
      hint: "Pass the numeric board id, a board URL, or a project key such as NMS (see `atl board list`).",
      next: [["atl", "board", "list"]],
    });
  }
  return { project: project.toUpperCase() };
}

/** The one board of a project, through the gateway's `jiraProjectByKey` (an experimental field). */
async function projectBoardId(session: Session, project: string): Promise<string> {
  let data: Record<string, unknown> = {};
  try {
    ({ data } = await graphql(session.http, {
      operationName: "ProjectBoards",
      query: PROJECT_BOARDS_DOCUMENT,
      variables: { key: project, cloudId: session.site.cloudId },
      experimental: ["JiraProject"],
    }));
  } catch (error) {
    // The gateway answers an unknown project key with a 404 error and no data.
    if (!(error instanceof AtlError) || error.code !== "http_404") {
      throw error;
    }
  }
  const jira = isRecord(data.jira) ? data.jira : {};
  const found = isRecord(jira.jiraProjectByKey) ? jira.jiraProjectByKey : undefined;
  const boards = (isRecord(found?.boards) ? found.boards : {}) as Connection<BoardNode>;
  const nodes = (boards.edges ?? []).flatMap((edge) =>
    edge.node?.boardId === undefined ? [] : [edge.node],
  );
  const [only, ...others] = nodes;
  if (only === undefined) {
    throw new AtlError(
      found === undefined ? `Project ${project} not found` : `Project ${project} has no board`,
      {
        code: "board_not_found",
        category: "api",
        hint: "Check the project key with `atl project list`, or pass a numeric board id.",
        next: [["atl", "project", "list"]],
      },
    );
  }
  if (others.length > 0) {
    throw new AtlError(`Project ${project} has several boards`, {
      code: "ambiguous_board",
      category: "input",
      hint: `Pass one board id: ${nodes.map((node) => `${node.boardId} "${node.name}" (${node.boardType})`).join(", ")}.`,
      next: nodes.map((node) => ["atl", "board", "get", String(node.boardId)]),
    });
  }
  return String(only.boardId);
}

async function loadBoard(session: Session, board: string): Promise<BoardNode & { id: string }> {
  const ref = parseBoardRef(board);
  const id = "id" in ref ? ref.id : await projectBoardId(session, ref.project);
  const { data } = await graphql(session.http, {
    operationName: "BoardGet",
    query: BOARD_DOCUMENT,
    variables: { id: boardAri(session, id) },
  });
  const jira = isRecord(data.jira) ? data.jira : {};
  const result = isRecord(jira.jiraBoard) ? jira.jiraBoard : undefined;
  if (result === undefined || result.__typename !== "JiraBoard") {
    const message =
      result !== undefined && typeof result.message === "string" ? result.message : "not found";
    throw new AtlError(`Board ${id}: ${message}`, {
      code: "not_found",
      category: "api",
      hint: "Check the board id with `atl board list` (only boards you have opened are listed), or pass a project key such as NMS.",
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
  description:
    "Board id (see `atl board list`), board URL, or project key (NMS) when it has one board",
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
  examples: ["atl board get 1", "atl board get NMS"],
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

const SPRINT_STATES: Readonly<Record<string, string>> = {
  active: "openSprints()",
  open: "openSprints()",
  future: "futureSprints()",
  closed: "closedSprints()",
};

/** `--sprint` value as a JQL clause: a sprint id, a state (active, future, closed), or a sprint name. */
function sprintClause(value: string): string {
  const text = value.trim();
  const state = SPRINT_STATES[text.toLowerCase()];
  if (state !== undefined) {
    return `sprint in ${state}`;
  }
  return /^\d+$/.test(text) ? `sprint = ${text}` : `sprint = ${queryLiteral(text)}`;
}

const DATASETS = ["board", "backlog", "all"] as const;

async function searchIssues(
  ctx: CommandContext,
  session: Session,
  jql: string,
  flags: {
    issueFields?: string | undefined;
    limit?: number | undefined;
    all?: boolean | undefined;
    cursor?: string | undefined;
  },
): Promise<Paged<unknown>> {
  const { fields, names } = await requestedFields(session, flags.issueFields, LIST_ISSUE_FIELDS);
  const paged = await searchJql(
    session,
    pagePolicy(flags, { defaultLimit: 25, maxPageSize: 100 }),
    jql,
    fields.join(","),
  );
  const withDescription = fields.includes("description") || fields.includes("*all");
  return {
    ...paged,
    items: paged.items.map((issue) =>
      ctx.full ? issue : compactIssue(session, issue, undefined, withDescription, true, names),
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

const NO_EPICS = "hierarchyLevel != 1";
const BACKLOG_SPRINTS = "(sprint is EMPTY OR sprint not in (openSprints(), futureSprints()))";

const boardIssues = defineCommand({
  name: "board.issues",
  summary:
    "Issues on a board (its filter, or its project when the filter is hidden), its backlog, or both; optional extra JQL. A company-managed scrum board omits epics, as Jira does. The scrum backlog is what Jira's backlog lists: not in an open or future sprint, not Done, no epics (a kanban board's backlog is issues in no sprint)",
  mcpTools: ["getJiraBoardIssueData"],
  args: [BOARD_ARG],
  flags: Type.Object({
    dataset: Type.Optional(
      Type.Union(
        DATASETS.map((name) => Type.Literal(name)),
        {
          description:
            "board (default), backlog (scrum: unfinished issues in no open or future sprint, no epics), or all",
        },
      ),
    ),
    jql: Type.Optional(
      Type.String({
        description:
          "Extra JQL ANDed with the board's filter; a trailing ORDER BY replaces the default Rank ordering",
      }),
    ),
    sprint: Type.Optional(
      Type.String({
        description:
          "Only issues in this sprint: a sprint id (see `atl board sprints`), a sprint name, or active | future | closed",
      }),
    ),
    count: Type.Optional(Type.Boolean({ description: "Return only the approximate count" })),
    issueFields: ISSUE_FIELDS_FLAG,
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl board issues 1",
    'atl board issues 1 --jql "statusCategory != Done" --limit 50',
    "atl board issues 1 --dataset backlog --count",
    "atl board issues 2 --sprint active",
    "atl board issues NMS --dataset backlog",
    "atl board issues 1 --issue-fields summary,labels,issuelinks",
  ],
  async run(ctx, input) {
    if (input.flags.count === true) {
      conflictingFlags("--count", input.flags, ["issueFields"]);
    }
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const board = await loadBoard(session, input.args.board ?? "");
    const clauses = [`(${boardJql(board)})`];
    const scrum = board.boardType === "SCRUM";
    const backlog = input.flags.dataset === "backlog";
    // A company-managed scrum board (`/software/c/` URL) does not list epics (they live in the epic
    // panel), and no scrum backlog lists them.
    if (scrum && (backlog || (board.boardUrl ?? "").includes("/software/c/"))) {
      clauses.push(NO_EPICS);
    }
    if (backlog) {
      if (input.flags.sprint !== undefined) {
        throw new AtlError("--sprint cannot be combined with --dataset backlog (no sprint)", {
          code: "invalid_flags",
          category: "input",
          hint: "Drop --dataset backlog, or drop --sprint.",
        });
      }
      clauses.push(...(scrum ? [BACKLOG_SPRINTS, "statusCategory != Done"] : ["sprint is EMPTY"]));
    }
    if (input.flags.sprint !== undefined) {
      clauses.push(sprintClause(input.flags.sprint));
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

/** Status category buckets, keyed by Jira's language-independent category key (status names are localized). */
type Bucket = "todo" | "inProgress" | "done";
const BUCKETS: Readonly<Record<string, Bucket>> = {
  new: "todo",
  indeterminate: "inProgress",
  done: "done",
};
const STORY_POINT_NAMES = ["story point estimate", "story points"];

interface IssueFacts {
  bucket: Bucket;
  points: number | undefined;
  subtask: boolean;
}

interface SprintSummary {
  byStatus: Record<Bucket, number>;
  points: Record<Bucket | "total" | "remaining", number>;
  velocity: number | undefined;
  unestimated: string[];
  carriedIn: string[];
  carriedOut: string[];
}

/**
 * The estimation field: the Jira Software story-point field by its schema type (sites can also carry a
 * look-alike "Story Points" float field), else a field with a story-point name.
 */
function storyPointField(fields: readonly FieldRecord[]): string | undefined {
  const typed = fields.find((field) => field.schema?.custom?.endsWith(":jsw-story-points"))?.id;
  if (typed !== undefined) {
    return typed;
  }
  for (const name of STORY_POINT_NAMES) {
    const match = fields.find((field) => field.name?.toLowerCase() === name)?.id;
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function issueFacts(fields: Record<string, unknown>, pointsField: string | undefined): IssueFacts {
  const status = isRecord(fields.status) ? fields.status : {};
  const category = isRecord(status.statusCategory) ? status.statusCategory.key : undefined;
  const points = pointsField === undefined ? undefined : fields[pointsField];
  return {
    bucket: (typeof category === "string" ? BUCKETS[category] : undefined) ?? "todo",
    points: typeof points === "number" ? points : undefined,
    subtask: isRecord(fields.issuetype) && fields.issuetype.subtask === true,
  };
}

/**
 * Per-sprint workload. Sprints are ordered by id (creation order): an issue also in a lower-id sprint was
 * carried in, one also in a higher-id sprint was carried out (unfinished work moves on; done work stays
 * behind). Velocity (closed sprints) is the points of issues that finished and were not carried out.
 * Subtasks are never reported as unestimated: they inherit their parent's estimate by convention.
 */
function summarize(
  sprint: Sprint,
  keys: readonly string[],
  memberships: ReadonlyMap<string, readonly number[]>,
  facts: ReadonlyMap<string, IssueFacts>,
): SprintSummary {
  const id = sprint.id ?? 0;
  const byStatus: Record<Bucket, number> = { todo: 0, inProgress: 0, done: 0 };
  const points: Record<Bucket, number> = { todo: 0, inProgress: 0, done: 0 };
  const unestimated: string[] = [];
  const carriedIn: string[] = [];
  const carriedOut: string[] = [];
  let velocity = 0;
  for (const key of keys) {
    const fact = facts.get(key);
    if (fact === undefined) {
      continue;
    }
    const sprintIds = memberships.get(key) ?? [];
    const out = sprintIds.some((other) => other > id);
    if (sprintIds.some((other) => other < id)) {
      carriedIn.push(key);
    }
    if (out) {
      carriedOut.push(key);
    }
    byStatus[fact.bucket]++;
    if (fact.points === undefined) {
      if (!fact.subtask) {
        unestimated.push(key);
      }
      continue;
    }
    points[fact.bucket] += fact.points;
    if (fact.bucket === "done" && !out) {
      velocity += fact.points;
    }
  }
  const remaining = points.todo + points.inProgress;
  return {
    byStatus,
    points: { ...points, remaining, total: remaining + points.done },
    velocity: (sprint.state ?? "").toLowerCase() === "closed" ? velocity : undefined,
    unestimated,
    carriedIn,
    carriedOut,
  };
}

const boardSprints = defineCommand({
  name: "board.sprints",
  summary:
    "Sprints seen on a board's issues (active, future, closed), read from the Sprint field; the sprint list itself is not exposed to OAuth tokens. --summary adds issue and story-point totals by status category, carried-over issues and velocity",
  mcpTools: ["getJiraBoardSprintData"],
  args: [BOARD_ARG],
  flags: Type.Object({
    state: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("future"), Type.Literal("closed")], {
        description: "Only sprints in this state",
      }),
    ),
    issues: Type.Optional(Type.Boolean({ description: "Include the issue keys in each sprint" })),
    summary: Type.Optional(
      Type.Boolean({
        description:
          "Per sprint: byStatus (issue counts) and points by status category (points.remaining = not done), velocity (closed sprints), unestimated issues, carriedIn (also in an earlier sprint) and carriedOut (also in a later sprint)",
      }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl board sprints 2",
    "atl board sprints 2 --state active --issues",
    "atl board sprints 2 --state active --summary",
    "atl board sprints 2 --state closed --summary",
    "atl board sprints NMS --summary",
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const [board, fields] = await Promise.all([
      loadBoard(session, input.args.board ?? ""),
      fetchFields(session),
    ]);
    const sprintField = fields.find((field) => field.schema?.custom?.endsWith(":gh-sprint"))?.id;
    if (sprintField === undefined) {
      return { items: [] };
    }
    const summary = input.flags.summary === true;
    const pointsField = summary ? storyPointField(fields) : undefined;
    const requested = summary
      ? [sprintField, "status", "issuetype", ...(pointsField === undefined ? [] : [pointsField])]
      : [sprintField];
    const jql = `(${boardJql(board)}) AND sprint is not EMPTY`;
    const sprints = new Map<number, Sprint & { issues: string[] }>();
    const memberships = new Map<string, number[]>();
    const facts = new Map<string, IssueFacts>();
    const paged = await searchJql<{ key: string; fields?: Record<string, unknown> }>(
      session,
      { all: true, defaultLimit: 1000, maxPageSize: 100 },
      jql,
      requested.join(","),
    );
    for (const issue of paged.items) {
      const issueFields = issue.fields ?? {};
      facts.set(issue.key, issueFacts(issueFields, pointsField));
      const values = issueFields[sprintField];
      for (const value of Array.isArray(values) ? values : []) {
        if (!isRecord(value) || typeof value.id !== "number") {
          continue;
        }
        const entry = sprints.get(value.id) ?? { ...(value as Sprint), issues: [] };
        entry.issues.push(issue.key);
        sprints.set(value.id, entry);
        memberships.set(issue.key, [...(memberships.get(issue.key) ?? []), value.id]);
      }
    }
    const wanted = input.flags.state?.toLowerCase();
    const selected = [...sprints.values()]
      .filter((sprint) => wanted === undefined || (sprint.state ?? "").toLowerCase() === wanted)
      .toSorted((a, b) => (a.id ?? 0) - (b.id ?? 0));
    const truncated = paged.truncated === true ? { truncated: true } : {};
    if (ctx.full) {
      const items = selected.map((sprint) =>
        Object.assign({}, sprint, {
          summary: summary ? summarize(sprint, sprint.issues, memberships, facts) : undefined,
        }),
      );
      return { items, nextCursor: null, ...truncated };
    }
    return {
      items: selected.map((sprint) =>
        Object.assign(
          {
            id: sprint.id,
            name: sprint.name,
            state: sprint.state,
            goal: sprint.goal,
            start: shortTs(sprint.startDate),
            end: shortTs(sprint.endDate),
            completed: shortTs(sprint.completeDate),
            issueCount: sprint.issues.length,
            issues: input.flags.issues === true ? sprint.issues : undefined,
          },
          summary ? summarize(sprint, sprint.issues, memberships, facts) : {},
        ),
      ),
      ...truncated,
    };
  },
});

export const boardCommands: readonly CommandSpec[] = [
  boardList,
  boardGet,
  boardIssues,
  boardSprints,
];
