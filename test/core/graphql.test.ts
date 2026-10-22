import { describe, expect, test } from "bun:test";
import { AtlError, type ErrorCategory } from "../../src/core/errors.ts";
import { GRAPHQL_URL, graphql, type GraphqlRequest } from "../../src/core/graphql.ts";
import { HttpClient } from "../../src/core/http.ts";
import { isRecord } from "../../src/core/guards.ts";

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A client whose single GraphQL call is answered with HTTP 200 and `body`. */
function harness(body: unknown): { client: HttpClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = new HttpClient({
    getToken: () => Promise.resolve("tok"),
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    timeoutMs: 1000,
    sleep: () => Promise.resolve(),
  });
  return { client, calls };
}

const REQUEST: GraphqlRequest = {
  operationName: "Probe",
  query: "query Probe { compass { x } }",
  variables: { a: 1 },
};

async function failure(body: unknown): Promise<AtlError> {
  const { client } = harness(body);
  const error = await graphql(client, REQUEST).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AtlError)) {
    throw new Error("expected an AtlError rejection");
  }
  return error;
}

/** `statusCode: null` models a gateway error without a status in its extensions. */
const gatewayError = (statusCode: number | null, path: (string | number)[] = []) => ({
  message: `gateway said ${statusCode ?? "nothing"}`,
  path,
  extensions: statusCode === null ? {} : { statusCode },
});

function sentBody(call: Recorded | undefined): unknown {
  return typeof call?.init.body === "string" ? JSON.parse(call.init.body) : undefined;
}

describe("graphql", () => {
  test.each<[number, string, ErrorCategory]>([
    [403, "http_403", "auth"],
    [404, "http_404", "api"],
    [429, "http_429", "transient"],
  ])("no data with statusCode %d maps to %s (%s)", async (status, code, category) => {
    const error = await failure({ errors: [gatewayError(status)], data: null });
    expect(error.code).toBe(code);
    expect(error.category).toBe(category);
    expect(error.message).toContain(`gateway said ${status}`);
  });

  test("an all-null data object counts as no data", async () => {
    const error = await failure({ errors: [gatewayError(403)], data: { compass: null } });
    expect(error.code).toBe("http_403");
  });

  test("an error that nulled its path throws classified, despite a non-null root", async () => {
    const error = await failure({
      errors: [gatewayError(403, ["compass", "customFieldDefinitions"])],
      data: { compass: { customFieldDefinitions: null } },
    });
    expect(error.code).toBe("http_403");
    expect(error.category).toBe("auth");
  });

  test("a list index on the path that resolves to null throws classified", async () => {
    const error = await failure({
      errors: [gatewayError(404, ["jira", "issues", 1])],
      data: { jira: { issues: [{ id: "1" }, null] } },
    });
    expect(error.code).toBe("http_404");
  });

  test("an error on a path whose value is present stays a partial error", async () => {
    const { client } = harness({
      errors: [gatewayError(403, ["compass", "component", "links"])],
      data: { compass: { component: { id: "c1", links: [] } } },
    });
    const result = await graphql(client, REQUEST);
    expect(result.data).toEqual({ compass: { component: { id: "c1", links: [] } } });
    expect(result.partialErrors).toEqual(["gateway said 403"]);
  });

  test("an error on a sibling path next to real data stays a partial error", async () => {
    const { client } = harness({
      errors: [gatewayError(500, ["compass", "good", "extra"])],
      data: { compass: { good: { id: "1", extra: "present" }, other: { id: "2" } } },
    });
    const result = await graphql(client, REQUEST);
    expect(result.data).toEqual({
      compass: { good: { id: "1", extra: "present" }, other: { id: "2" } },
    });
    expect(result.partialErrors).toEqual(["gateway said 500"]);
  });

  test("errors with no path and real data are partial errors", async () => {
    const { client } = harness({
      errors: [gatewayError(null)],
      data: { compass: { id: "1" } },
    });
    const result = await graphql(client, REQUEST);
    expect(result.partialErrors).toEqual(["gateway said nothing"]);
  });

  test("no statusCode and no data is graphql_error carrying the messages", async () => {
    const error = await failure({
      errors: [gatewayError(null), { message: "second" }],
      data: null,
    });
    expect(error.code).toBe("graphql_error");
    expect(error.category).toBe("api");
    expect(error.message).toContain("gateway said nothing; second");
  });

  test("no statusCode on a nulled path is graphql_error", async () => {
    const error = await failure({
      errors: [gatewayError(null, ["compass", "x"])],
      data: { compass: { x: null } },
    });
    expect(error.code).toBe("graphql_error");
  });

  test("no data and no errors reports no data", async () => {
    const error = await failure({ data: null });
    expect(error.code).toBe("graphql_error");
    expect(error.message).toContain("no data");
  });

  test("a non-object body is an unexpected response", async () => {
    const error = await failure([1, 2]);
    expect(error.code).toBe("unexpected_response");
  });

  test("sends operationName, query and variables to the gateway URL", async () => {
    const { client, calls } = harness({ data: { ok: true } });
    await graphql(client, REQUEST);
    const [call] = calls;
    expect(call?.url).toBe(GRAPHQL_URL);
    expect(call?.init.method).toBe("POST");
    const body = sentBody(call);
    expect(body).toEqual({
      operationName: "Probe",
      query: REQUEST.query,
      variables: { a: 1 },
    });
  });

  test("variables default to an empty object and operationName is always present", async () => {
    const { client, calls } = harness({ data: { ok: true } });
    await graphql(client, { operationName: "NoVars", query: "query NoVars { ok }" });
    const body = sentBody(calls[0]);
    expect(isRecord(body) && body.operationName).toBe("NoVars");
    expect(isRecord(body) && body.variables).toEqual({});
  });

  test("X-ExperimentalApi is sent only when experimental is given", async () => {
    const plain = harness({ data: { ok: true } });
    await graphql(plain.client, REQUEST);
    expect(new Headers(plain.calls[0]?.init.headers).has("X-ExperimentalApi")).toBe(false);

    const empty = harness({ data: { ok: true } });
    await graphql(empty.client, { ...REQUEST, experimental: [] });
    expect(new Headers(empty.calls[0]?.init.headers).has("X-ExperimentalApi")).toBe(false);

    const opted = harness({ data: { ok: true } });
    await graphql(opted.client, { ...REQUEST, experimental: ["compass-beta", "teamwork-graph"] });
    expect(new Headers(opted.calls[0]?.init.headers).get("X-ExperimentalApi")).toBe(
      "compass-beta,teamwork-graph",
    );
  });
});
