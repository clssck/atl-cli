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
const ISSUE_ARI = `ari:cloud:jira:${CLOUD}:issue/10000`;

interface Call {
  variables: Record<string, unknown>;
  query: string;
}

let root: string;
let env: NodeJS.ProcessEnv;
let calls: Call[];
/** Connection replies served in order, one per request. */
let pages: unknown[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-cypher-test-"));
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
  pages = [];
  graphDeps.fetch = (_input, init) => {
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (!isRecord(body) || !isRecord(body.variables)) {
      throw new Error("unexpected GraphQL request body");
    }
    calls.push({ variables: body.variables, query: String(body.query) });
    const connection = pages[Math.min(calls.length - 1, pages.length - 1)];
    return Promise.resolve(
      new Response(JSON.stringify({ data: { graphStore_cypherQueryV2: connection } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
});

afterEach(async () => {
  graphDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

const spec: CommandSpec | undefined = graphCommands.find((c) => c.name === "graph.cypher");

async function run(
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  ctx: Partial<CommandContext> = {},
): Promise<unknown> {
  if (spec === undefined) {
    throw new Error("missing graph.cypher");
  }
  const result = await spec.run(makeContext(env, ctx), { args, rest: [], flags });
  return ctx.full === true ? result : prune(result);
}

const row = (columns: Record<string, unknown>) => ({
  node: { columns: Object.entries(columns).map(([key, value]) => ({ key, value })) },
});

const page = (id: string, next?: string) => ({
  edges: [row({ i: { __typename: "GraphStoreCypherQueryV2IntObject", i: Number(id) } })],
  pageInfo: next === undefined ? { hasNextPage: false } : { hasNextPage: true, endCursor: next },
});

describe("graph.cypher", () => {
  test("sends query, params from --params-file and the site context; flattens column values", async () => {
    const paramsFile = join(root, "params.json");
    await Bun.write(paramsFile, JSON.stringify({ ari: ISSUE_ARI }));
    pages = [
      {
        edges: [
          row({
            n: {
              __typename: "GraphStoreCypherQueryV2AriNode",
              id: ISSUE_ARI,
              data: { __typename: "JiraWorkItem" },
            },
            c: { __typename: "GraphStoreCypherQueryV2IntObject", i: 3 },
            s: { __typename: "GraphStoreCypherQueryV2StringObject", s: "text" },
            tags: { __typename: "GraphStoreCypherQueryV2StringListObject", sl: ["a", "b"] },
          }),
        ],
        pageInfo: { hasNextPage: false },
      },
    ];
    const result = await run({ query: "MATCH (n) WHERE n.ari = $ari RETURN n" }, { paramsFile });
    expect(calls[0]?.variables).toMatchObject({
      query: "MATCH (n) WHERE n.ari = $ari RETURN n",
      params: { ari: ISSUE_ARI },
      context: `ari:cloud:platform::site/${CLOUD}`,
      first: 50,
    });
    expect(result).toEqual({
      items: [
        {
          n: { ari: ISSUE_ARI, type: "JiraWorkItem" },
          c: 3,
          s: "text",
          tags: ["a", "b"],
        },
      ],
    });
  });

  test("follows endCursor with --all and returns nextCursor under --limit", async () => {
    pages = [page("1", "c1"), page("2")];
    expect(await run({ query: "MATCH (n) RETURN 1 AS i" }, { all: true })).toEqual({
      items: [{ i: 1 }, { i: 2 }],
    });
    expect(calls.map((c) => c.variables.after)).toEqual([undefined, "c1"]);

    calls = [];
    pages = [page("1", "c1")];
    expect(await run({ query: "MATCH (n) RETURN 1 AS i" }, { limit: 1 })).toEqual({
      items: [{ i: 1 }],
      nextCursor: "c1",
    });
  });

  test("--full returns the raw connections untouched", async () => {
    pages = [
      {
        edges: [row({ i: { __typename: "GraphStoreCypherQueryV2IntObject", i: 5 } })],
        pageInfo: { hasNextPage: false },
      },
    ];
    const result = await run({ query: "RETURN 5 AS i" }, {}, { full: true });
    expect(result).toMatchObject({
      data: [{ edges: [{ node: { columns: [{ key: "i", value: { i: 5 } }] } }] }],
    });
  });

  test("an unreadable or non-object params file is an input error before any request", async () => {
    const bad = join(root, "bad.json");
    await Bun.write(bad, "[1,2]");
    const notObject = await run({ query: "RETURN 1" }, { paramsFile: bad }).catch(
      (e: unknown) => e,
    );
    expect(notObject).toBeInstanceOf(AtlError);
    expect(notObject).toMatchObject({ code: "invalid_params" });
    const missing = await run({ query: "RETURN 1" }, { paramsFile: join(root, "none.json") }).catch(
      (e: unknown) => e,
    );
    expect(missing).toMatchObject({ code: "file_not_found" });
    expect(calls).toHaveLength(0);
  });
});
