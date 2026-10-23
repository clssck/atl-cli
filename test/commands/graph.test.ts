import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphCommands, graphDeps } from "../../src/commands/graph.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { prune } from "../../src/core/output.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const SITE_ARI = `ari:cloud:platform::site/${CLOUD}`;
const GRAPHQL = "https://api.atlassian.com/graphql";
const JIRA = `/ex/jira/${CLOUD}`;
const CONFLUENCE = `/ex/confluence/${CLOUD}/wiki`;
const PAGE_ARI = `ari:cloud:confluence:${CLOUD}:page/196802`;
const ISSUE_ARI = `ari:cloud:jira:${CLOUD}:issue/10000`;
const USER_ARI = "ari:cloud:identity::user/62a219658783e7006f627f3b";

interface Node {
  typename: string;
  fields: Record<string, unknown>;
}

interface GraphqlCall {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
}

interface RestCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

let root: string;
let env: NodeJS.ProcessEnv;
let graphqlCalls: GraphqlCall[];
let restCalls: RestCall[];
/** Nodes the fake Cypher endpoint knows, keyed by ARI. */
let nodes: Map<string, Node>;
/** `<relationship>:<outgoing|incoming>` to the ARIs on the far end, newest first. */
let edges: Map<string, string[]>;
/** Relationship labels the gateway refuses (the real one rejects third-party nodes). */
let refused: Set<string>;
/** REST replies keyed `METHOD /path` relative to the site's Jira or Confluence base. */
let rest: Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hydrationRow(ari: string, node: Node) {
  return {
    node: {
      columns: [
        {
          key: "n",
          value: {
            __typename: "GraphStoreCypherQueryV2AriNode",
            id: ari,
            data: {
              __typename: node.typename,
              ...Object.fromEntries(
                Object.entries(node.fields).map(([field, value]) => [
                  `${node.typename}__${field}`,
                  value,
                ]),
              ),
            },
          },
        },
      ],
    },
  };
}

interface EdgeQuery {
  label: string;
  direction: "outgoing" | "incoming";
  count: boolean;
  skip: number;
  query: string;
}

function parseEdgeQuery(query: string): EdgeQuery {
  const match = /(-\[r:(\w+)\]->|<-\[r:(\w+)\]-)/.exec(query);
  return {
    label: match?.[2] ?? match?.[3] ?? "",
    direction: match?.[2] === undefined ? "incoming" : "outgoing",
    count: query.includes("count(m)"),
    skip: Number(/SKIP (\d+)/.exec(query)?.[1] ?? 0),
    query,
  };
}

function edgeResult(request: { query: string; first: number }) {
  const parsed = parseEdgeQuery(request.query);
  const far = edges.get(`${parsed.label}:${parsed.direction}`) ?? [];
  if (parsed.count) {
    return {
      pageInfo: { hasNextPage: false },
      edges: [
        {
          node: {
            columns: [
              {
                key: "c",
                value: { __typename: "GraphStoreCypherQueryV2BatchIntObject", i: far.length },
              },
            ],
          },
        },
      ],
    };
  }
  const page = far.slice(parsed.skip, parsed.skip + request.first);
  return {
    pageInfo: { hasNextPage: parsed.skip + page.length < far.length },
    edges: page.map((ari, index) => ({
      node: {
        columns: [
          {
            key: "m",
            value: {
              __typename: "GraphStoreCypherQueryV2BatchAriNode",
              id: ari,
              data: { __typename: nodes.get(ari)?.typename ?? "JiraIssue" },
            },
          },
          {
            key: "updated",
            value: {
              __typename: "GraphStoreCypherQueryV2BatchTimestampObject",
              t: Date.parse("2026-10-21T20:00:00Z") - (parsed.skip + index) * 1000,
            },
          },
        ],
      },
    })),
  };
}

function answerGraphql(call: GraphqlCall): Response {
  const { variables } = call;
  if (call.operationName === "GraphHydrate") {
    const params = isRecord(variables.params) ? variables.params : {};
    const aris = Array.isArray(params.aris) ? params.aris.map(String) : [];
    const found = aris.flatMap((ari) => {
      const node = nodes.get(ari);
      return node === undefined ? [] : [hydrationRow(ari, node)];
    });
    return json({ data: { graphStore_cypherQueryV2: { edges: found } } });
  }
  const queries = Array.isArray(variables.queries) ? variables.queries : [];
  const requests = queries.flatMap((entry) =>
    isRecord(entry) && typeof entry.query === "string" && typeof entry.first === "number"
      ? [{ query: entry.query, first: entry.first }]
      : [],
  );
  if (requests.some((request) => refused.has(parseEdgeQuery(request.query).label))) {
    return json({
      errors: [
        {
          message: "Cannot return m as it is a third-party node",
          extensions: { statusCode: 400 },
        },
      ],
      data: null,
    });
  }
  return json({ data: { graphStore_cypherQueryV2Batch: { results: requests.map(edgeResult) } } });
}

function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
  if (input === GRAPHQL) {
    const call = isRecord(body)
      ? {
          operationName: String(body.operationName),
          query: String(body.query),
          variables: isRecord(body.variables) ? body.variables : {},
        }
      : { operationName: "", query: "", variables: {} };
    graphqlCalls.push(call);
    return Promise.resolve(answerGraphql(call));
  }
  restCalls.push({ method, path: url.pathname, query: url.searchParams, body });
  const route = `${method} ${url.pathname.replace(JIRA, "").replace(CONFLUENCE, "wiki:")}`;
  const reply = rest[route];
  return Promise.resolve(
    reply === undefined ? json({ errorMessages: [`no route ${route}`] }, 404) : json(reply),
  );
}

function command(name: string): CommandSpec {
  const spec = graphCommands.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

async function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  options: { rest?: string[]; ctx?: Partial<CommandContext> } = {},
): Promise<unknown> {
  const context = makeContext(env, options.ctx);
  const result = await command(name).run(context, {
    args,
    rest: options.rest ?? [],
    flags,
  });
  return context.full ? result : prune(result);
}

async function failure(promise: Promise<unknown>): Promise<AtlError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof AtlError)) {
    throw new Error("expected an AtlError rejection");
  }
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected an object");
  }
  return value;
}

function itemsOf(value: unknown, key = "items"): Record<string, unknown>[] {
  const list = asRecord(value)[key];
  if (!Array.isArray(list)) {
    throw new Error(`expected ${key}`);
  }
  return list.map(asRecord);
}

/** ARIs of every target in a full-detail context result, in order. */
function targetAris(value: unknown): unknown[] {
  return itemsOf(value).flatMap((item) => itemsOf(item, "targets").map((target) => target.ari));
}

/** Edge queries of a call: the batch requests it carried. */
function batchQueries(call: GraphqlCall | undefined): { query: string; first: number }[] {
  const queries = call?.variables.queries;
  if (!Array.isArray(queries)) {
    return [];
  }
  return queries.flatMap((entry) =>
    isRecord(entry) && typeof entry.query === "string" && typeof entry.first === "number"
      ? [{ query: entry.query, first: entry.first }]
      : [],
  );
}

const edgeCalls = () => graphqlCalls.filter((call) => call.operationName === "GraphEdges");
const hydrateCalls = () => graphqlCalls.filter((call) => call.operationName === "GraphHydrate");
const writes = () => restCalls.filter((call) => call.method !== "GET");

const PAGE: Node = {
  typename: "ConfluencePage",
  fields: {
    id: PAGE_ARI,
    pageId: "196802",
    title: "Weekly status",
    status: "CURRENT",
    links: { webUi: "/spaces/ENG/pages/196802/Weekly+status" },
  },
};
const ISSUE: Node = {
  typename: "JiraIssue",
  fields: {
    id: ISSUE_ARI,
    key: "ENG-1",
    summary: "First issue",
    webUrl: "https://acme.atlassian.net/browse/ENG-1",
  },
};
const USER: Node = {
  typename: "AtlassianAccountUser",
  fields: { id: USER_ARI, accountId: "62a219658783e7006f627f3b", name: "Ada" },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-graph-test-"));
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
  graphqlCalls = [];
  restCalls = [];
  nodes = new Map([
    [PAGE_ARI, PAGE],
    [ISSUE_ARI, ISSUE],
    [USER_ARI, USER],
  ]);
  edges = new Map();
  refused = new Set();
  rest = {};
  graphDeps.fetch = fakeFetch;
});

afterEach(async () => {
  graphDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("graph.object", () => {
  test("hydrates ARIs, issue keys and page URLs in one Cypher query and unprefixes the fields", async () => {
    rest["GET /rest/api/3/issue/ENG-1"] = { id: "10000", key: "ENG-1" };
    const result = await run(
      "graph.object",
      {},
      {},
      {
        rest: [
          USER_ARI,
          "ENG-1",
          "https://acme.atlassian.net/wiki/spaces/ENG/pages/196802/Weekly+status",
        ],
      },
    );

    expect(hydrateCalls()).toHaveLength(1);
    const call = hydrateCalls()[0];
    expect(call?.query).toContain('@optIn(to: "GraphStoreCypherQueryV2")');
    expect(call?.variables).toMatchObject({
      query: "MATCH (n) WHERE n.ari IN $aris RETURN n",
      params: { aris: [USER_ARI, ISSUE_ARI, PAGE_ARI] },
      context: SITE_ARI,
    });
    expect(restCalls.map((entry) => entry.path)).toEqual([`${JIRA}/rest/api/3/issue/ENG-1`]);
    expect(result).toEqual({
      items: [
        {
          ari: USER_ARI,
          type: "AtlassianUser",
          raw: { accountId: "62a219658783e7006f627f3b", name: "Ada" },
        },
        { ari: ISSUE_ARI, type: "JiraWorkItem", raw: { key: "ENG-1", summary: "First issue" } },
        {
          ari: PAGE_ARI,
          type: "ConfluencePage",
          raw: {
            title: "Weekly status",
            status: "CURRENT",
            links: { webUi: "/spaces/ENG/pages/196802/Weekly+status" },
          },
        },
      ],
    });
  });

  test("compacts hydrated fields: markdown bodies, person refs, label names, short timestamps", async () => {
    const ari = `ari:cloud:jira:${CLOUD}:issue/10001`;
    nodes.set(ari, {
      typename: "JiraIssue",
      fields: {
        id: ari,
        issueId: "10001",
        key: "ENG-2",
        webUrl: "https://acme.atlassian.net/browse/ENG-2",
        created: "2026-10-21T20:11:37.452Z",
        reporter: { id: USER_ARI, user: { accountId: "acc-1", name: "Ada" } },
        labels: { edges: [{ node: { name: "a" } }, { node: { name: "b" } }] },
        dueDate: null,
        description: {
          adfValue: {
            json: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
            },
          },
        },
      },
    });
    const result = asRecord(await run("graph.object", {}, {}, { rest: [ari] }));
    expect(itemsOf(result)).toEqual([
      {
        ari,
        type: "JiraWorkItem",
        raw: {
          key: "ENG-2",
          created: "2026-10-21T20:11:37Z",
          reporter: { accountId: "acc-1", name: "Ada" },
          labels: ["a", "b"],
          description: ["Hello"],
        },
      },
    ]);
  });

  test("reports identifiers that do not resolve next to the ones that do", async () => {
    const missing = `ari:cloud:jira:${CLOUD}:issue/99999`;
    const result = asRecord(
      await run("graph.object", {}, {}, { rest: [USER_ARI, missing, "not a reference"] }),
    );

    expect(itemsOf(result).map((item) => item.ari)).toEqual([USER_ARI]);
    expect(result.errors).toEqual([
      "not a reference: Unrecognized reference: not a reference",
      `${missing}: no object with ARI ${missing} is readable with this token`,
    ]);
  });

  test("fails with not_found when nothing hydrates and invalid_ari when nothing parses", async () => {
    const missing = `ari:cloud:jira:${CLOUD}:issue/99999`;
    expect((await failure(run("graph.object", {}, {}, { rest: [missing] }))).code).toBe(
      "not_found",
    );
    expect((await failure(run("graph.object", {}, {}, { rest: ["nonsense"] }))).code).toBe(
      "invalid_ari",
    );
    expect(
      (
        await failure(
          run("graph.object", {}, {}, { rest: Array.from({ length: 26 }, () => USER_ARI) }),
        )
      ).code,
    ).toBe("too_many_objects");
  });

  test("--full returns the gateway payload instead of the compact items", async () => {
    const result = asRecord(
      await run("graph.object", {}, {}, { rest: [USER_ARI], ctx: { full: true } }),
    );

    expect(Object.keys(result).toSorted()).toEqual(["data", "partialErrors"]);
    expect(asRecord(result.data).edges).toHaveLength(1);
  });
});

describe("graph.context summary", () => {
  test("counts each applicable relationship in batches of ten and drops the empty ones", async () => {
    edges.set("atlassian_user_owns_confluence_page:incoming", [USER_ARI]);
    edges.set("confluence_space_has_confluence_page:incoming", [
      `ari:cloud:confluence:${CLOUD}:space/1`,
    ]);
    nodes.set(`ari:cloud:confluence:${CLOUD}:space/1`, { typename: "ConfluenceSpace", fields: {} });

    const result = asRecord(
      await run("graph.context", { objectType: "ConfluencePage", objectIdentifier: PAGE_ARI }),
    );

    expect(result.object).toEqual({
      ari: PAGE_ARI,
      type: "ConfluencePage",
      title: "Weekly status",
      webUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/196802",
    });
    expect(itemsOf(result)).toEqual([
      {
        relationshipName: "atlassian_user_owns_confluence_page",
        direction: "incoming",
        targetObjectTypes: ["AtlassianUser"],
        countsByTargetType: { AtlassianUser: 1 },
        totalCount: 1,
      },
      {
        relationshipName: "confluence_space_has_confluence_page",
        direction: "incoming",
        targetObjectTypes: ["ConfluenceSpace"],
        countsByTargetType: { ConfluenceSpace: 1 },
        totalCount: 1,
      },
    ]);
    expect(result.nextCursor).toBeUndefined();

    const calls = edgeCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(batchQueries(call).length).toBeLessThanOrEqual(10);
      expect(call.variables.context).toBe(SITE_ARI);
    }
    const queries = calls.flatMap((call) => batchQueries(call).map((entry) => entry.query));
    expect(queries).toContain(
      "MATCH (n {ari: $ari})<-[r:atlassian_user_owns_confluence_page]-(m) RETURN count(m) AS c",
    );
    // A page is never the source of the user-owns-page relationship.
    expect(
      queries.some((query) => query.includes("-[r:atlassian_user_owns_confluence_page]->")),
    ).toBe(false);
    const params = calls.flatMap((call) =>
      Array.isArray(call.variables.params) ? call.variables.params : [],
    );
    expect(params.every((entry) => isRecord(entry) && entry.ari === PAGE_ARI)).toBe(true);
  });

  test("splits a relationship across its far-end types only when it has hits", async () => {
    edges.set("atlassian_user_viewed_documents:outgoing", [
      PAGE_ARI,
      `ari:cloud:confluence:${CLOUD}:blogpost/5`,
    ]);
    nodes.set(`ari:cloud:confluence:${CLOUD}:blogpost/5`, {
      typename: "ConfluenceBlogPost",
      fields: {},
    });

    const result = await run(
      "graph.context",
      { objectType: "AtlassianUser", objectIdentifier: USER_ARI },
      { relationshipTypes: ["atlassian-user-viewed-documents"] },
    );

    const [item] = itemsOf(result);
    expect(item).toMatchObject({
      relationshipName: "atlassian_user_viewed_documents",
      direction: "outgoing",
      totalCount: 2,
    });
    const queries = edgeCalls().flatMap((call) => batchQueries(call).map((entry) => entry.query));
    expect(queries.filter((query) => query.includes("(m:ConfluenceBlogPost)"))).toHaveLength(1);
  });

  test("--target-object-types labels the far end and --time-range bounds r.lastUpdated", async () => {
    await run(
      "graph.context",
      { objectType: "JiraWorkItem", objectIdentifier: ISSUE_ARI },
      {
        relationshipTypes: ["atlassian_user_created_jira_work_item"],
        targetObjectTypes: ["AtlassianUser"],
        timeRange: "2026-01-01T00:00:00Z..2026-02-01T00:00:00Z",
      },
    );

    const [call] = edgeCalls();
    expect(batchQueries(call)).toEqual([
      {
        query:
          "MATCH (n {ari: $ari})<-[r:atlassian_user_created_jira_work_item]-(m:AtlassianUser) WHERE r.lastUpdated >= $from AND r.lastUpdated <= $to RETURN count(m) AS c",
        first: 1,
      },
    ]);
    expect(call?.variables.params).toEqual([
      {
        ari: ISSUE_ARI,
        from: Date.parse("2026-01-01T00:00:00Z"),
        to: Date.parse("2026-02-01T00:00:00Z"),
      },
    ]);
  });

  test("a refused relationship is reported while the others still count", async () => {
    edges.set("atlassian_user_created_jira_work_item:incoming", [USER_ARI]);
    refused.add("atlassian_user_created_work_items");

    const result = asRecord(
      await run("graph.context", { objectType: "JiraWorkItem", objectIdentifier: ISSUE_ARI }),
    );

    expect(itemsOf(result).map((item) => item.relationshipName)).toEqual([
      "atlassian_user_created_jira_work_item",
    ]);
    expect(result.errors).toEqual([expect.stringContaining("atlassian_user_created_work_items")]);
  });

  test("pages the summary with --first and an offset cursor", async () => {
    edges.set("atlassian_user_assigned_jira_work_item:outgoing", [ISSUE_ARI]);
    edges.set("atlassian_user_created_jira_work_item:outgoing", [ISSUE_ARI]);
    edges.set("atlassian_user_owns_confluence_page:outgoing", [PAGE_ARI]);
    const args = { objectType: "AtlassianUser", objectIdentifier: USER_ARI };

    const first = asRecord(await run("graph.context", args, { first: 2 }));
    expect(itemsOf(first).map((item) => item.relationshipName)).toEqual([
      "atlassian_user_assigned_jira_work_item",
      "atlassian_user_created_jira_work_item",
    ]);
    expect(typeof first.nextCursor).toBe("string");

    const second = asRecord(
      await run("graph.context", args, { first: 2, after: String(first.nextCursor) }),
    );
    expect(itemsOf(second).map((item) => item.relationshipName)).toEqual([
      "atlassian_user_owns_confluence_page",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("graph.context full", () => {
  const PEOPLE = Array.from({ length: 3 }, (_, index) => `ari:cloud:identity::user/u${index}`);

  beforeEach(() => {
    for (const [index, ari] of PEOPLE.entries()) {
      nodes.set(ari, {
        typename: "AtlassianAccountUser",
        fields: { id: ari, name: `User ${index}` },
      });
    }
    edges.set("atlassian_user_owns_confluence_page:incoming", PEOPLE);
  });

  const ARGS = { objectType: "ConfluencePage", objectIdentifier: PAGE_ARI };
  const FLAGS = { detailLevel: "full", relationshipTypes: ["atlassian_user_owns_confluence_page"] };

  test("lists hydrated targets grouped per relationship, newest first", async () => {
    const result = asRecord(await run("graph.context", ARGS, FLAGS));

    expect(itemsOf(result)).toEqual([
      {
        relationshipName: "atlassian_user_owns_confluence_page",
        direction: "incoming",
        targetObjectType: "AtlassianUser",
        targets: [
          {
            ari: PEOPLE[0],
            type: "AtlassianUser",
            title: "User 0",
            updatedAt: "2026-10-21T20:00:00Z",
          },
          {
            ari: PEOPLE[1],
            type: "AtlassianUser",
            title: "User 1",
            updatedAt: "2026-10-21T19:59:59Z",
          },
          {
            ari: PEOPLE[2],
            type: "AtlassianUser",
            title: "User 2",
            updatedAt: "2026-10-21T19:59:58Z",
          },
        ],
      },
    ]);
    expect(result.nextCursor).toBeUndefined();
    const [call] = edgeCalls();
    expect(batchQueries(call)).toEqual([
      {
        query:
          "MATCH (n {ari: $ari})<-[r:atlassian_user_owns_confluence_page]-(m) RETURN m, r.lastUpdated AS updated ORDER BY r.lastUpdated DESC",
        first: 51,
      },
    ]);
    // Source first, then every target in a second hydration call.
    expect(hydrateCalls().map((entry) => asRecord(entry.variables.params).aris)).toEqual([
      [PAGE_ARI],
      PEOPLE,
    ]);
  });

  test("--first caps the page and the cursor resumes with SKIP", async () => {
    const first = asRecord(await run("graph.context", ARGS, { ...FLAGS, first: 2 }));
    expect(targetAris(first)).toEqual([PEOPLE[0], PEOPLE[1]]);
    expect(typeof first.nextCursor).toBe("string");

    const second = asRecord(
      await run("graph.context", ARGS, { ...FLAGS, first: 2, after: String(first.nextCursor) }),
    );
    expect(targetAris(second)).toEqual([PEOPLE[2]]);
    expect(second.nextCursor).toBeUndefined();
    expect(batchQueries(edgeCalls()[1])[0]?.query).toContain("SKIP 2");
  });

  test("a cursor from different flags is rejected", async () => {
    const first = asRecord(await run("graph.context", ARGS, { ...FLAGS, first: 2 }));
    const error = await failure(
      run("graph.context", ARGS, {
        detailLevel: "full",
        first: 2,
        after: String(first.nextCursor),
      }),
    );
    expect(error.code).toBe("invalid_cursor");
    expect((await failure(run("graph.context", ARGS, { ...FLAGS, after: "!!" }))).code).toBe(
      "invalid_cursor",
    );
  });

  test("--full returns hydrated targets with their raw fields", async () => {
    const result = asRecord(await run("graph.context", ARGS, FLAGS, { ctx: { full: true } }));

    expect(asRecord(result.object)).toMatchObject({ ari: PAGE_ARI, type: "ConfluencePage" });
    const targets = itemsOf(result, "targets");
    expect(targets).toHaveLength(3);
    expect(targets[0]).toMatchObject({
      relationshipName: "atlassian_user_owns_confluence_page",
      direction: "incoming",
      object: { ari: PEOPLE[0], type: "AtlassianUser", raw: { name: "User 0" } },
    });
  });

  test("a relationship the gateway refuses lands in errors and does not hide the rest", async () => {
    refused.add("atlassian_user_created_confluence_page");
    edges.set("space_has_documents:incoming", [`ari:cloud:confluence:${CLOUD}:space/1`]);
    nodes.set(`ari:cloud:confluence:${CLOUD}:space/1`, {
      typename: "ConfluenceSpace",
      fields: { name: "Eng" },
    });

    const result = asRecord(
      await run("graph.context", ARGS, {
        detailLevel: "full",
        relationshipTypes: ["atlassian_user_created_confluence_page", "space_has_documents"],
      }),
    );

    expect(itemsOf(result).map((item) => item.relationshipName)).toEqual(["space_has_documents"]);
    expect(result.errors).toEqual([
      expect.stringContaining("atlassian_user_created_confluence_page"),
    ]);
  });
});

describe("graph.context identifiers and validation", () => {
  test("resolves a work item key through REST and a bare account id to an identity ARI", async () => {
    rest["GET /rest/api/3/issue/ENG-1"] = { id: "10000", key: "ENG-1" };
    const issue = asRecord(
      await run("graph.context", { objectType: "JiraWorkItem", objectIdentifier: "ENG-1" }),
    );
    expect(asRecord(issue.object)).toMatchObject({
      ari: ISSUE_ARI,
      key: "ENG-1",
      type: "JiraWorkItem",
    });

    const user = asRecord(
      await run("graph.context", {
        objectType: "AtlassianUser",
        objectIdentifier: "62a219658783e7006f627f3b",
      }),
    );
    expect(asRecord(user.object).ari).toBe(USER_ARI);
  });

  test("turns a Confluence URL into a page ARI on the session's cloud", async () => {
    const result = asRecord(
      await run("graph.context", {
        objectType: "ConfluencePage",
        objectIdentifier: "https://acme.atlassian.net/wiki/spaces/ENG/pages/196802/Weekly+status",
      }),
    );
    expect(asRecord(result.object).ari).toBe(PAGE_ARI);
  });

  test("types without a human identifier demand an ARI", async () => {
    const error = await failure(
      run("graph.context", { objectType: "CompassComponent", objectIdentifier: "web" }),
    );
    expect(error.code).toBe("ari_required");
  });

  test("rejects unknown object types, relationship types and time ranges with a suggestion", async () => {
    const type = await failure(
      run("graph.context", { objectType: "JiraWorkItm", objectIdentifier: "ENG-1" }),
    );
    expect(type.code).toBe("unknown_object_type");
    expect(type.hint).toBe("Did you mean JiraWorkItem?");

    const relationship = await failure(
      run(
        "graph.context",
        { objectType: "JiraWorkItem", objectIdentifier: ISSUE_ARI },
        { relationshipTypes: ["jira-work-item-blocks-jira-work-itm"] },
      ),
    );
    expect(relationship.code).toBe("unknown_relationship_type");

    const range = await failure(
      run(
        "graph.context",
        { objectType: "JiraWorkItem", objectIdentifier: ISSUE_ARI },
        { timeRange: "yesterday" },
      ),
    );
    expect(range.code).toBe("invalid_time_range");
    expect(graphqlCalls).toHaveLength(0);
  });

  test("an object that does not hydrate is not_found before any relationship is queried", async () => {
    const error = await failure(
      run("graph.context", {
        objectType: "ConfluencePage",
        objectIdentifier: `ari:cloud:confluence:${CLOUD}:page/1`,
      }),
    );
    expect(error.code).toBe("not_found");
    expect(edgeCalls()).toHaveLength(0);
  });

  test("a relationship that does not apply to the object type is a warning, not a query", async () => {
    const result = asRecord(
      await run(
        "graph.context",
        { objectType: "JiraWorkItem", objectIdentifier: ISSUE_ARI },
        { relationshipTypes: ["atlassian_user_owns_confluence_page"] },
      ),
    );
    expect(result.warnings).toEqual([
      "atlassian_user_owns_confluence_page does not apply to JiraWorkItem",
    ]);
    expect(edgeCalls()).toHaveLength(0);
  });
});

describe("graph.add", () => {
  const LINK_TYPES = {
    issueLinkTypes: [
      { id: "10000", name: "Blocks" },
      { id: "10003", name: "Relates" },
    ],
  };

  test("remote link to a Confluence page POSTs the page URL and the --title", async () => {
    rest["GET wiki:/api/v2/pages/196802"] = {
      title: "Weekly status",
      _links: { webui: "/spaces/ENG/pages/196802/Weekly+status" },
    };
    rest["POST /rest/api/3/issue/ENG-3/remotelink"] = { id: 10001, self: "x" };

    const result = await run(
      "graph.add",
      {
        relationshipType: "jira-work-item-links-jira-work-item-remote-link",
        objectIdentifier: "ENG-3",
        targetObjectIdentifier: PAGE_ARI,
      },
      { title: "atl smoke linked page" },
    );

    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body).toEqual({
      object: {
        url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/196802",
        title: "atl smoke linked page",
      },
    });
    expect(result).toEqual({
      relationshipType: "jira-work-item-links-jira-work-item-remote-link",
      object: "ENG-3",
      target: "https://acme.atlassian.net/wiki/spaces/ENG/pages/196802",
      title: "atl smoke linked page",
      remoteLinkId: "10001",
      next: [["atl", "issue", "links", "ENG-3"]],
    });
  });

  test("remote link defaults the title from the page and takes foreign URLs verbatim", async () => {
    rest["GET wiki:/api/v2/pages/196802"] = {
      title: "Weekly status",
      _links: { webui: "/spaces/ENG/pages/196802" },
    };
    rest["POST /rest/api/3/issue/ENG-3/remotelink"] = { id: 1 };
    const args = {
      relationshipType: "jira-work-item-links-jira-work-item-remote-link",
      objectIdentifier: "ENG-3",
    };

    await run("graph.add", { ...args, targetObjectIdentifier: "196802" });
    await run("graph.add", { ...args, targetObjectIdentifier: "https://example.com/spec" });

    expect(writes().map((call) => call.body)).toEqual([
      {
        object: {
          url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/196802",
          title: "Weekly status",
        },
      },
      { object: { url: "https://example.com/spec", title: "https://example.com/spec" } },
    ]);
  });

  test("--plan describes the remote link write and sends nothing", async () => {
    const result = asRecord(
      await run(
        "graph.add",
        {
          relationshipType: "jira-work-item-links-jira-work-item-remote-link",
          objectIdentifier: "ENG-3",
          targetObjectIdentifier: "https://example.com/spec",
        },
        { title: "Spec" },
        {
          ctx: {
            plan: true,
            argv: [
              "graph",
              "add",
              "jira-work-item-links-jira-work-item-remote-link",
              "ENG-3",
              "https://example.com/spec",
              "--title",
              "Spec",
              "--plan",
            ],
          },
        },
      ),
    );

    expect(writes()).toHaveLength(0);
    expect(result).toMatchObject({
      type: "plan",
      method: "POST",
      url: `https://api.atlassian.com${JIRA}/rest/api/3/issue/ENG-3/remotelink`,
      next: [
        [
          "atl",
          "graph",
          "add",
          "jira-work-item-links-jira-work-item-remote-link",
          "ENG-3",
          "https://example.com/spec",
          "--title",
          "Spec",
        ],
      ],
    });
  });

  test("blocks creates a Blocks link with the source as the blocking (inward) issue", async () => {
    rest["GET /rest/api/3/issueLinkType"] = LINK_TYPES;
    rest["POST /rest/api/3/issueLink"] = {};

    const result = await run("graph.add", {
      relationshipType: "jira-work-item-blocks-jira-work-item",
      objectIdentifier: "ENG-1",
      targetObjectIdentifier: "https://acme.atlassian.net/browse/ENG-2",
    });

    expect(writes()[0]?.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "ENG-1" },
      outwardIssue: { key: "ENG-2" },
    });
    expect(result).toEqual({
      relationshipType: "jira-work-item-blocks-jira-work-item",
      object: "ENG-1",
      target: "ENG-2",
      linkType: "Blocks",
      next: [["atl", "issue", "links", "ENG-1"]],
    });
  });

  test("links uses the Relates type and numeric ids from ARIs", async () => {
    rest["GET /rest/api/3/issueLinkType"] = LINK_TYPES;
    rest["POST /rest/api/3/issueLink"] = {};

    await run("graph.add", {
      relationshipType: "jira_work_item_links_jira_work_item",
      objectIdentifier: ISSUE_ARI,
      targetObjectIdentifier: "ENG-2",
    });

    expect(writes()[0]?.body).toEqual({
      type: { name: "Relates" },
      inwardIssue: { id: "10000" },
      outwardIssue: { key: "ENG-2" },
    });
  });

  test("--plan on a work item link reads the link types but does not write", async () => {
    rest["GET /rest/api/3/issueLinkType"] = LINK_TYPES;
    const result = asRecord(
      await run(
        "graph.add",
        {
          relationshipType: "jira-work-item-blocks-jira-work-item",
          objectIdentifier: "ENG-1",
          targetObjectIdentifier: "ENG-2",
        },
        {},
        {
          ctx: {
            plan: true,
            argv: [
              "graph",
              "add",
              "jira-work-item-blocks-jira-work-item",
              "ENG-1",
              "ENG-2",
              "--plan",
            ],
          },
        },
      ),
    );

    expect(writes()).toHaveLength(0);
    expect(result).toMatchObject({
      type: "plan",
      url: `https://api.atlassian.com${JIRA}/rest/api/3/issueLink`,
    });
  });

  test("a site without the link type fails with unknown_link_type", async () => {
    rest["GET /rest/api/3/issueLinkType"] = { issueLinkTypes: [{ id: "1", name: "Duplicate" }] };
    const error = await failure(
      run("graph.add", {
        relationshipType: "jira-work-item-blocks-jira-work-item",
        objectIdentifier: "ENG-1",
        targetObjectIdentifier: "ENG-2",
      }),
    );
    expect(error.code).toBe("unknown_link_type");
    expect(writes()).toHaveLength(0);
  });

  test("Atlas relationships fail before any request: the token has no Townsquare write scope", async () => {
    for (const [relationshipType, scope] of [
      ["jira-work-item-tracks-atlassian-project", "write:project:projects"],
      ["jira-work-item-contributes-to-atlassian-goal", "write:goal:goals"],
    ] as const) {
      const error = await failure(
        run("graph.add", {
          relationshipType,
          objectIdentifier: "ENG-1",
          targetObjectIdentifier: "ATLAS-1",
        }),
      );
      expect(error.code).toBe("missing_scope");
      expect(error.hint).toContain(scope);
    }
    expect(restCalls).toHaveLength(0);
    expect(graphqlCalls).toHaveLength(0);
  });

  test("unknown relationship types list the supported ones", async () => {
    const error = await failure(
      run("graph.add", {
        relationshipType: "jira-work-item-blocks-jira-work-itm",
        objectIdentifier: "ENG-1",
        targetObjectIdentifier: "ENG-2",
      }),
    );
    expect(error.code).toBe("unsupported_relationship_type");
    expect(error.hint).toBe("Did you mean jira-work-item-blocks-jira-work-item?");
  });
});
