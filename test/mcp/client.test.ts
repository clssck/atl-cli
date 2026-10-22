import { describe, expect, test } from "bun:test";
import { AtlError } from "../../src/core/errors.ts";
import { MCP_ENDPOINT, McpClient, withMcpClient } from "../../src/mcp/client.ts";
import { USER_AGENT } from "../../src/version.ts";
import { fakeMcp, SESSION_ID, textResult, type FakeMcpOptions } from "../helpers/mcp.ts";

const ENV = { ATL_ACCESS_TOKEN: "test-token" };

function client(options: FakeMcpOptions, env: NodeJS.ProcessEnv = ENV) {
  const server = fakeMcp(options);
  return { server, client: new McpClient({ env, fetch: server.fetch }) };
}

async function rejection(promise: Promise<unknown>): Promise<AtlError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AtlError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected rejection");
}

async function toolFailure(text: string): Promise<AtlError> {
  const { client: mcp } = client({
    toolResults: { getConfluencePage: { isError: true, content: [{ type: "text", text }] } },
  });
  await mcp.initialize();
  return rejection(mcp.callTool("getConfluencePage", {}));
}

describe("McpClient session", () => {
  test("initialize sends the handshake headers and then the initialized notification", async () => {
    const { server, client: mcp } = client({});
    const init = await mcp.initialize();
    expect(init).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "atlassian-mcp-server", version: "1.0.0" },
    });

    const [first, second] = server.calls;
    expect(first?.url).toBe(MCP_ENDPOINT);
    expect(first?.method).toBe("POST");
    expect(first?.headers.get("Authorization")).toBe("Bearer test-token");
    expect(first?.headers.get("Accept")).toBe("application/json, text/event-stream");
    expect(first?.headers.get("User-Agent")).toBe(USER_AGENT);
    expect(first?.headers.get("Mcp-Session-Id")).toBeNull();
    expect(first?.headers.get("MCP-Protocol-Version")).toBeNull();
    expect(first?.rpc).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    expect(second?.rpc?.method).toBe("notifications/initialized");
    expect(second?.rpc?.id).toBeUndefined();
    expect(second?.headers.get("Mcp-Session-Id")).toBe(SESSION_ID);
    expect(second?.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
  });

  test("echoes the session id on later calls and closes with DELETE", async () => {
    const { server, client: mcp } = client({ tools: [] });
    await mcp.initialize();
    await mcp.listTools();
    await mcp.close();

    const listCall = server.calls.find((call) => call.rpc?.method === "tools/list");
    expect(listCall?.headers.get("Mcp-Session-Id")).toBe(SESSION_ID);
    const last = server.calls.at(-1);
    expect(last?.method).toBe("DELETE");
    expect(last?.headers.get("Mcp-Session-Id")).toBe(SESSION_ID);
  });

  test("close ignores failures and is a no-op without a session", async () => {
    const { server, client: mcp } = client({ failClose: true });
    await mcp.close();
    expect(server.calls).toHaveLength(0);
    await mcp.initialize();
    await mcp.close();
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });

  test("withMcpClient closes the session even when the action throws", async () => {
    const server = fakeMcp({});
    const failure = await rejection(
      withMcpClient({ env: ENV, fetch: server.fetch }, () =>
        Promise.reject(new AtlError("boom", { code: "boom", category: "api" })),
      ),
    );
    expect(failure.code).toBe("boom");
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });

  test("ATL_MCP_URL overrides the endpoint", async () => {
    const { server, client: mcp } = client(
      {},
      { ...ENV, ATL_MCP_URL: "https://mcp.example.test/mcp" },
    );
    await mcp.initialize();
    expect(server.calls.every((call) => call.url === "https://mcp.example.test/mcp")).toBe(true);
  });
});

describe("McpClient responses", () => {
  const tool = { name: "search", inputSchema: { type: "object" } };

  test("parses JSON responses", async () => {
    const { client: mcp } = client({ tools: [tool] });
    await mcp.initialize();
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(["search"]);
  });

  test("parses event-stream responses and picks the frame with the matching id", async () => {
    const { client: mcp } = client({ sse: true, tools: [tool] });
    const init = await mcp.initialize();
    expect(init.serverInfo.name).toBe("atlassian-mcp-server");
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(["search"]);
  });

  test("follows tools/list cursors", async () => {
    const { client: mcp } = client({
      toolPages: [[tool], [{ name: "fetch", inputSchema: { type: "object" } }]],
    });
    await mcp.initialize();
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(["search", "fetch"]);
  });

  test("callTool parses JSON text items and keeps other text and structuredContent", async () => {
    const { client: mcp } = client({
      toolResults: {
        search: {
          content: [
            { type: "text", text: '{"results":[1,2]}' },
            { type: "text", text: "plain words" },
            { type: "text", text: "{not json" },
            { type: "image", data: "abc" },
          ],
          structuredContent: { total: 2 },
        },
      },
    });
    await mcp.initialize();
    expect(await mcp.callTool("search", { query: "x" })).toEqual({
      content: [{ results: [1, 2] }, "plain words", "{not json", { type: "image", data: "abc" }],
      structuredContent: { total: 2 },
    });
  });

  test("callTool omits structuredContent when the server sends none", async () => {
    const { client: mcp } = client({ toolResults: { search: textResult({ ok: true }) } });
    await mcp.initialize();
    expect(await mcp.callTool("search", {})).toEqual({ content: [{ ok: true }] });
  });
});

describe("McpClient errors", () => {
  test("JSON-RPC errors become mcp_error", async () => {
    const { client: mcp } = client({});
    await mcp.initialize();
    const error = await rejection(mcp.callTool("nope", {}));
    expect(error).toMatchObject({ code: "mcp_error", category: "api", exitCode: 2 });
    expect(error.message).toContain("Unknown tool: nope");
    expect(error.hint).toContain("-32602");
  });

  test("isError tool results become mcp_tool_error with the tool text", async () => {
    const { client: mcp } = client({
      toolResults: {
        createJiraIssue: { isError: true, content: [{ type: "text", text: "Project not found" }] },
      },
    });
    await mcp.initialize();
    const error = await rejection(mcp.callTool("createJiraIssue", {}));
    expect(error).toMatchObject({ code: "mcp_tool_error", category: "api" });
    expect(error.message).toBe("MCP tool createJiraIssue failed: Project not found");
  });

  describe("tool errors that carry an HTTP status", () => {
    test("a 404 is decoded to a readable message and classified like core", async () => {
      const error = await toolFailure(
        JSON.stringify({
          error: true,
          message:
            'Failed to get page: 404 Not Found. Details: {\n  "errors": [\n    {\n      "status": 404,\n      "code": "NOT_FOUND",\n      "title": "Cannot find a page with id [999999999]",\n      "detail": null\n    }\n  ]\n}',
          statusCode: 404,
        }),
      );
      expect(error).toMatchObject({ code: "http_404", category: "api", status: 404, exitCode: 2 });
      expect(error.message).toBe(
        "MCP tool getConfluencePage failed: Failed to get page: 404 Not Found. Details: Cannot find a page with id [999999999]",
      );
    });

    test("a GraphQL 403 nested in the message text is an auth error with the inner message", async () => {
      const error = await toolFailure(
        JSON.stringify({
          error: true,
          message:
            'GraphQL errors: [{"message":"Unable to find active workspace","locations":[],"extensions":{"product":"COMPASS","statusCode":403}}]',
        }),
      );
      expect(error).toMatchObject({ code: "http_403", category: "auth", status: 403, exitCode: 1 });
      expect(error.message).toBe(
        "MCP tool getConfluencePage failed: GraphQL errors: Unable to find active workspace",
      );
    });

    test("429 and 5xx are transient; 400 is a plain api error", async () => {
      const limited = await toolFailure(JSON.stringify({ message: "slow down", statusCode: 429 }));
      expect(limited).toMatchObject({ code: "http_429", category: "transient", exitCode: 3 });
      const down = await toolFailure("Upstream returned HTTP 503 Service Unavailable");
      expect(down).toMatchObject({ code: "http_503", category: "transient", status: 503 });
      const bad = await toolFailure(JSON.stringify({ message: "bad query", statusCode: 400 }));
      expect(bad).toMatchObject({ code: "http_400", category: "api", status: 400 });
    });

    test("messages are truncated to 500 characters", async () => {
      const error = await toolFailure(
        JSON.stringify({ message: "x".repeat(2000), statusCode: 500 }),
      );
      expect(error.message.length).toBeLessThanOrEqual(500);
      expect(error.message.endsWith("...")).toBe(true);
    });
  });

  test("HTTP failures map through the core mapper", async () => {
    const mcp = new McpClient({
      env: ENV,
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ message: "expired" }), { status: 401 })),
    });
    const unauthorized = await rejection(mcp.initialize());
    expect(unauthorized).toMatchObject({ code: "http_401", category: "auth", status: 401 });

    const flaky = new McpClient({
      env: ENV,
      fetch: () => Promise.resolve(new Response("x", { status: 503 })),
    });
    expect(await rejection(flaky.initialize())).toMatchObject({
      code: "http_503",
      category: "transient",
    });
  });

  test("a body with no matching id is a protocol error", async () => {
    const mcp = new McpClient({
      env: ENV,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
    });
    expect(await rejection(mcp.initialize())).toMatchObject({ code: "mcp_protocol_error" });
  });

  test("network failures are transient", async () => {
    const mcp = new McpClient({
      env: ENV,
      fetch: () => Promise.reject(new TypeError("connection refused")),
    });
    expect(await rejection(mcp.initialize())).toMatchObject({
      code: "network_error",
      category: "transient",
    });
  });
});
