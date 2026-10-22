import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compassCommands, compassDeps } from "../../src/commands/compass.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { prune } from "../../src/core/output.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const GRAPHQL = "https://api.atlassian.com/graphql";

interface Sent {
  url: string;
  operationName: unknown;
  query: string;
  variables: Record<string, unknown>;
  bodyText: string;
}

let root: string;
let env: NodeJS.ProcessEnv;
let sent: Sent[];

/** Every GraphQL POST is recorded and answered with `reply` (the full response body). */
function serve(reply: unknown): void {
  compassDeps.fetch = (input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body: unknown = JSON.parse(bodyText);
    if (!isRecord(body) || !isRecord(body.variables) || typeof body.query !== "string") {
      throw new Error("unexpected GraphQL request body");
    }
    sent.push({
      url: input,
      operationName: body.operationName,
      query: body.query,
      variables: body.variables,
      bodyText,
    });
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function command(name: string): CommandSpec {
  const spec = compassCommands.find((c) => c.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

async function run(
  name: string,
  args: Record<string, string> = {},
  flags: Record<string, unknown> = {},
  ctx: Partial<CommandContext> = {},
): Promise<unknown> {
  const context = makeContext(env, ctx);
  const result = await command(name).run(context, { args, rest: [], flags });
  return context.full ? result : prune(result);
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

async function file(name: string, content: unknown): Promise<string> {
  const path = join(root, name);
  await Bun.write(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function only(): Sent {
  const [request] = sent;
  if (request === undefined || sent.length !== 1) {
    throw new Error(`expected exactly one request, saw ${sent.length}`);
  }
  return request;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const ORDERS = {
  id: "ari:cloud:compass:site:component/site/orders",
  name: "orders",
  typeId: "SERVICE",
  description: "Order service",
  ownerId: "ari:cloud:teams::team/t1",
  url: "https://acme.atlassian.net/compass/component/orders",
  labels: [{ name: "backend" }, { name: "tier-1" }],
};

const ORDERS_COMPACT = {
  id: ORDERS.id,
  name: "orders",
  typeId: "SERVICE",
  description: "Order service",
  ownerId: "ari:cloud:teams::team/t1",
  labels: ["backend", "tier-1"],
  url: ORDERS.url,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-compass-test-"));
  env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
  await saveConfig(
    {
      sites: {
        "acme.atlassian.net": {
          cloudId: CLOUD,
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["read:component:compass"],
          cachedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
    env,
  );
  sent = [];
});

afterEach(async () => {
  compassDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("compass.components", () => {
  const page = {
    data: {
      compass: {
        searchComponents: {
          __typename: "CompassSearchComponentConnection",
          nodes: [
            { link: "https://acme.atlassian.net/compass/c/orders", component: ORDERS },
            { link: null, component: { id: "c2", name: "bare", typeId: "LIBRARY", labels: null } },
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
        },
      },
    },
  };

  test("sends cloudId, query text, page size and cursor; compacts the page", async () => {
    serve(page);
    const result = await run(
      "compass.components",
      {},
      { query: "ord", limit: 5, after: "cursor-1" },
    );
    const request = only();
    expect(request.url).toBe(GRAPHQL);
    expect(request.operationName).toBe("CompassComponents");
    expect(request.variables).toEqual({
      cloudId: CLOUD,
      query: { query: "ord", first: 5, after: "cursor-1" },
    });
    expect(result).toEqual({
      items: [
        { ...ORDERS_COMPACT, url: "https://acme.atlassian.net/compass/c/orders" },
        { id: "c2", name: "bare", typeId: "LIBRARY" },
      ],
      nextCursor: "cursor-2",
    });
  });

  test("defaults to 10 items and no cursor on the last page", async () => {
    serve({
      data: {
        compass: {
          searchComponents: {
            __typename: "CompassSearchComponentConnection",
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: "ignored" },
          },
        },
      },
    });
    const result = await run("compass.components");
    expect(only().variables).toEqual({ cloudId: CLOUD, query: { first: 10 } });
    expect(result).toEqual({ items: [] });
  });

  test("--filters-file maps types, labels and repositories to fieldFilters", async () => {
    serve(page);
    const filters = await file("filters.json", {
      types: ["SERVICE", "LIBRARY"],
      labels: ["backend"],
      repositories: ["https://bitbucket.org/w/r"],
    });
    await run("compass.components", {}, { filtersFile: filters });
    expect(only().variables.query).toEqual({
      first: 10,
      fieldFilters: [
        { name: "type", filter: { in: ["SERVICE", "LIBRARY"] } },
        { name: "labels", filter: { in: ["backend"] } },
        { name: "repositories", filter: { in: ["https://bitbucket.org/w/r"] } },
      ],
    });
  });

  test("rejects a filters file with unknown keys or non-string lists", async () => {
    serve(page);
    for (const content of [{ owners: ["x"] }, { types: [1] }]) {
      const error = await failure(
        run("compass.components", {}, { filtersFile: await file("bad.json", content) }),
      );
      expect(error.code).toBe("invalid_filters_file");
    }
    expect(
      (await failure(run("compass.components", {}, { filtersFile: join(root, "nope.json") }))).code,
    ).toBe("input_file_unreadable");
    expect(sent).toHaveLength(0);
  });

  test("--full returns the raw response data", async () => {
    serve(page);
    const result = await run("compass.components", {}, {}, { full: true });
    expect(result).toEqual(page.data);
  });

  test("a QueryError member is classified by its extension status code", async () => {
    serve({
      data: {
        compass: {
          searchComponents: {
            __typename: "QueryError",
            message: "Forbidden",
            extensions: [{ statusCode: 403, errorType: "AUTH" }],
          },
        },
      },
    });
    const error = await failure(run("compass.components"));
    expect(error.code).toBe("http_403");
    expect(error.category).toBe("auth");
  });

  test("a QueryError without a status code keeps its message", async () => {
    serve({
      data: {
        compass: {
          searchComponents: { __typename: "QueryError", message: "Bad filter", extensions: [] },
        },
      },
    });
    const error = await failure(run("compass.components"));
    expect(error.code).toBe("compass_query_error");
    expect(error.message).toContain("Bad filter");
  });

  test("a gateway error that nulled the field is classified by graphql(), also under --full", async () => {
    serve({
      errors: [
        {
          message: "Unable to find active workspace",
          path: ["compass", "searchComponents"],
          extensions: { statusCode: 403, reason: "ProductNotFound" },
        },
      ],
      data: { compass: { searchComponents: null } },
    });
    const error = await failure(run("compass.components", {}, {}, { full: true }));
    expect(error.code).toBe("http_403");
    expect(error.category).toBe("auth");
    expect(error.message).toContain("Unable to find active workspace");
  });
});

describe("compass.component", () => {
  const detail = {
    data: {
      compass: {
        component: {
          __typename: "CompassComponent",
          ...ORDERS,
          customFields: [
            {
              __typename: "CompassCustomTextField",
              definition: {
                __typename: "CompassCustomTextFieldDefinition",
                id: "d1",
                name: "Runbook",
              },
              textValue: "wiki",
            },
            {
              __typename: "CompassCustomMultiSelectField",
              definition: {
                __typename: "CompassCustomMultiSelectFieldDefinition",
                id: "d2",
                name: "Regions",
              },
              options: [
                { id: "o1", value: "eu" },
                { id: "o2", value: "us" },
              ],
            },
            {
              __typename: "CompassCustomSingleSelectField",
              definition: {
                __typename: "CompassCustomSingleSelectFieldDefinition",
                id: "d3",
                name: "Tier",
              },
              option: { id: "o3", value: "gold" },
            },
            {
              __typename: "CompassCustomBooleanField",
              definition: {
                __typename: "CompassCustomBooleanFieldDefinition",
                id: "d4",
                name: "PCI",
              },
              booleanValue: false,
            },
          ],
          links: [{ id: "l1", type: "REPOSITORY", url: "https://git/x", name: "repo" }],
          dependsOn: {
            __typename: "CompassRelationshipConnection",
            nodes: [
              {
                relationshipType: "DEPENDS_ON",
                startNode: { id: "a", name: "A" },
                endNode: { id: "db", name: "db" },
              },
            ],
          },
          dependencyOf: {
            __typename: "CompassRelationshipConnection",
            nodes: [
              {
                relationshipType: "DEPENDS_ON",
                startNode: { id: "web", name: "web" },
                endNode: { id: "a", name: "A" },
              },
            ],
          },
          parents: { __typename: "CompassRelationshipConnection", nodes: [] },
          children: {
            __typename: "CompassRelationshipConnection",
            nodes: [
              {
                relationshipType: "CHILD_OF",
                startNode: { id: "kid", name: "kid" },
                endNode: { id: "a", name: "A" },
              },
            ],
          },
        },
      },
    },
  };

  test("defaults include custom fields and links, exclude relationships", async () => {
    serve(detail);
    await run("compass.component", { id: ORDERS.id });
    const request = only();
    expect(request.operationName).toBe("CompassComponent");
    expect(request.variables).toEqual({
      id: ORDERS.id,
      customFields: true,
      links: true,
      relationships: false,
    });
    expect(request.query).toContain('@optIn(to: "compass-beta")');
  });

  test("flags map to the include variables", async () => {
    serve(detail);
    await run(
      "compass.component",
      { id: "x" },
      { customFields: false, relatedLinks: false, relatedComponents: true },
    );
    expect(only().variables).toEqual({
      id: "x",
      customFields: false,
      links: false,
      relationships: true,
    });
  });

  test("compacts the component with custom fields, links and relationships", async () => {
    serve(detail);
    const result = await run("compass.component", { id: ORDERS.id }, { relatedComponents: true });
    expect(result).toEqual({
      ...ORDERS_COMPACT,
      customFields: [
        { id: "d1", name: "Runbook", type: "TEXT", value: "wiki" },
        { id: "d2", name: "Regions", type: "MULTI_SELECT", value: ["eu", "us"] },
        { id: "d3", name: "Tier", type: "SINGLE_SELECT", value: "gold" },
        { id: "d4", name: "PCI", type: "BOOLEAN", value: false },
      ],
      links: [{ id: "l1", type: "REPOSITORY", name: "repo", url: "https://git/x" }],
      relationships: [
        { type: "DEPENDS_ON", direction: "OUTWARD", component: { id: "db", name: "db" } },
        { type: "DEPENDS_ON", direction: "INWARD", component: { id: "web", name: "web" } },
        { type: "CHILD_OF", direction: "INWARD", component: { id: "kid", name: "kid" } },
      ],
    });
  });

  test("omits sections that were not requested", async () => {
    serve({ data: { compass: { component: { __typename: "CompassComponent", ...ORDERS } } } });
    const result = await run(
      "compass.component",
      { id: ORDERS.id },
      { customFields: false, relatedLinks: false },
    );
    expect(result).toEqual(ORDERS_COMPACT);
  });

  test("a QueryError becomes an AtlError", async () => {
    serve({
      data: {
        compass: {
          component: {
            __typename: "QueryError",
            message: "no such component",
            extensions: [{ statusCode: 404 }],
          },
        },
      },
    });
    const error = await failure(run("compass.component", { id: "missing" }));
    expect(error.code).toBe("http_404");
  });
});

describe("compass.fields", () => {
  test("queries by cloudId and compacts definitions with their type", async () => {
    serve({
      data: {
        compass: {
          customFieldDefinitions: {
            __typename: "CompassCustomFieldDefinitionsConnection",
            nodes: [
              {
                __typename: "CompassCustomTextFieldDefinition",
                id: "d1",
                name: "Runbook",
                description: "Where",
              },
              {
                __typename: "CompassCustomUserFieldDefinition",
                id: "d2",
                name: "Lead",
                description: null,
              },
              { __typename: "CompassCustomNumberFieldDefinition", id: "d3", name: "SLO" },
            ],
          },
        },
      },
    });
    const result = await run("compass.fields");
    const request = only();
    expect(request.operationName).toBe("CompassCustomFieldDefinitions");
    expect(request.variables).toEqual({ query: { cloudId: CLOUD } });
    expect(result).toEqual({
      items: [
        { id: "d1", name: "Runbook", type: "TEXT", description: "Where" },
        { id: "d2", name: "Lead", type: "USER" },
        { id: "d3", name: "SLO", type: "NUMBER" },
      ],
    });
  });
});

/** Run a write once as a plan and once for real; return both with the request actually sent. */
async function planAndSend(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown>,
  reply: unknown,
) {
  serve(reply);
  const plan = await run(name, args, flags, {
    plan: true,
    argv: [...name.split("."), "--x", "--plan"],
  });
  const sentWhilePlanning = sent.length;
  const result = await run(name, args, flags);
  return { plan, sentWhilePlanning, result, request: only() };
}

describe("compass.create", () => {
  const created = {
    data: {
      compass: { createComponent: { success: true, errors: null, componentDetails: ORDERS } },
    },
  };
  const flags = {
    name: "orders",
    typeId: "SERVICE",
    description: "Order service",
    ownerId: "ari:cloud:teams::team/t1",
    label: ["backend", "tier-1"],
  };

  test("sends the component input and compacts the created component", async () => {
    const { request, result } = await planAndSend("compass.create", {}, flags, created);
    expect(request.operationName).toBe("CompassCreateComponent");
    expect(request.variables).toEqual({
      cloudId: CLOUD,
      input: {
        name: "orders",
        typeId: "SERVICE",
        description: "Order service",
        ownerId: "ari:cloud:teams::team/t1",
        labels: ["backend", "tier-1"],
      },
    });
    expect(result).toEqual(ORDERS_COMPACT);
  });

  test("--plan describes the exact request and sends nothing", async () => {
    const { plan, sentWhilePlanning, request } = await planAndSend(
      "compass.create",
      {},
      flags,
      created,
    );
    expect(sentWhilePlanning).toBe(0);
    expect(plan).toEqual({
      type: "plan",
      method: "POST",
      url: GRAPHQL,
      body: {
        sha256: sha(request.bodyText),
        bytes: Buffer.byteLength(request.bodyText),
        preview: request.bodyText.slice(0, 500),
      },
      next: [["atl", "compass", "create", "--x"]],
    });
  });

  test("omits optional input fields that were not given", async () => {
    serve(created);
    await run("compass.create", {}, { name: "n", typeId: "SERVICE" });
    expect(only().variables.input).toEqual({ name: "n", typeId: "SERVICE" });
  });

  test("success:false becomes an AtlError with the server message", async () => {
    serve({
      data: {
        compass: {
          createComponent: {
            success: false,
            errors: [{ message: "name already exists", extensions: { statusCode: 400 } }],
            componentDetails: null,
          },
        },
      },
    });
    const error = await failure(run("compass.create", {}, { name: "n", typeId: "SERVICE" }));
    expect(error.message).toContain("name already exists");
    expect(error.status).toBe(400);
  });
});

describe("compass.relate", () => {
  const related = {
    data: {
      compass: {
        createRelationship: {
          success: true,
          errors: null,
          createdCompassRelationship: {
            relationshipType: "DEPENDS_ON",
            startNode: { id: "ari:a", name: "A" },
            endNode: { id: "ari:b", name: "B" },
          },
        },
      },
    },
  };

  test("DEPENDS_ON sends from as the start node", async () => {
    const { request, result } = await planAndSend(
      "compass.relate",
      { from: "ari:a", to: "ari:b" },
      { type: "DEPENDS_ON" },
      related,
    );
    expect(request.operationName).toBe("CompassCreateRelationship");
    expect(request.variables).toEqual({
      input: { relationshipType: "DEPENDS_ON", startNodeId: "ari:a", endNodeId: "ari:b" },
    });
    expect(result).toEqual({
      type: "DEPENDS_ON",
      from: { id: "ari:a", name: "A" },
      to: { id: "ari:b", name: "B" },
    });
  });

  test("DEPENDENCY_OF swaps the nodes of the stored DEPENDS_ON relationship", async () => {
    serve(related);
    await run("compass.relate", { from: "ari:a", to: "ari:b" }, { type: "DEPENDENCY_OF" });
    expect(only().variables).toEqual({
      input: { relationshipType: "DEPENDS_ON", startNodeId: "ari:b", endNodeId: "ari:a" },
    });
  });

  test("--plan describes the exact request and sends nothing", async () => {
    const { plan, sentWhilePlanning, request } = await planAndSend(
      "compass.relate",
      { from: "ari:a", to: "ari:b" },
      { type: "DEPENDS_ON" },
      related,
    );
    expect(sentWhilePlanning).toBe(0);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: GRAPHQL,
      body: { sha256: sha(request.bodyText) },
      next: [["atl", "compass", "relate", "--x"]],
    });
  });
});

describe("compass.field-create", () => {
  const created = {
    data: {
      compass: {
        createCustomFieldDefinition: {
          success: true,
          errors: null,
          customFieldDefinition: {
            __typename: "CompassCustomTextFieldDefinition",
            id: "d9",
            name: "Runbook",
            description: "Where",
          },
        },
      },
    },
  };

  test("maps the type to its definition input and compacts the result", async () => {
    const input = await file("field.json", { name: "Runbook", type: "TEXT", description: "Where" });
    const { request, result } = await planAndSend(
      "compass.field-create",
      {},
      { inputFile: input },
      created,
    );
    expect(request.operationName).toBe("CompassCreateCustomFieldDefinition");
    expect(request.variables).toEqual({
      input: { textFieldDefinition: { cloudId: CLOUD, name: "Runbook", description: "Where" } },
    });
    expect(result).toEqual({ id: "d9", name: "Runbook", type: "TEXT", description: "Where" });
  });

  test.each([
    ["NUMBER", "numberFieldDefinition"],
    ["BOOLEAN", "booleanFieldDefinition"],
    ["USER", "userFieldDefinition"],
  ])("%s uses %s", async (type, key) => {
    serve(created);
    await run("compass.field-create", {}, { inputFile: await file("f.json", { name: "F", type }) });
    expect(only().variables).toEqual({ input: { [key]: { cloudId: CLOUD, name: "F" } } });
  });

  test("--plan describes the exact request and sends nothing", async () => {
    const input = await file("field.json", { name: "Runbook", type: "TEXT" });
    const { plan, sentWhilePlanning, request } = await planAndSend(
      "compass.field-create",
      {},
      { inputFile: input },
      created,
    );
    expect(sentWhilePlanning).toBe(0);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: GRAPHQL,
      body: { sha256: sha(request.bodyText), bytes: Buffer.byteLength(request.bodyText) },
      next: [["atl", "compass", "field-create", "--x"]],
    });
  });

  test("rejects what Compass GraphQL cannot express before any request", async () => {
    const date = await failure(
      run(
        "compass.field-create",
        {},
        { inputFile: await file("d.json", { name: "D", type: "DATE" }) },
      ),
    );
    expect(date.code).toBe("unsupported_field_type");
    const required = await failure(
      run(
        "compass.field-create",
        {},
        { inputFile: await file("r.json", { name: "R", type: "TEXT", isRequired: true }) },
      ),
    );
    expect(required.code).toBe("unsupported_field_option");
    const shape = await failure(
      run("compass.field-create", {}, { inputFile: await file("s.json", { type: "TEXT" }) }),
    );
    expect(shape.code).toBe("invalid_field_input");
    const notJson = await failure(
      run("compass.field-create", {}, { inputFile: await file("n.json", "{") }),
    );
    expect(notJson.code).toBe("invalid_json_file");
    expect(sent).toHaveLength(0);
  });
});
