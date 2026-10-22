import { isRecord } from "../../src/core/guards.ts";
import type { FetchLike } from "../../src/core/http.ts";

export const SESSION_ID = "session-abc";

export interface McpCall {
  method: string;
  url: string;
  headers: Headers;
  rpc:
    | {
        jsonrpc: unknown;
        id: number | undefined;
        method: string;
        params: Record<string, unknown>;
      }
    | undefined;
}

export interface FakeMcpOptions {
  tools?: readonly Record<string, unknown>[];
  /** Respond with `text/event-stream` instead of JSON. */
  sse?: boolean;
  /** Result for `tools/call`, by tool name; unknown tools get a JSON-RPC error. */
  toolResults?: Record<string, unknown>;
  /** Pages of tools for `tools/list`, served by cursor `"1"`, `"2"`, ... */
  toolPages?: readonly (readonly Record<string, unknown>[])[];
  /** Fails the DELETE that closes the session. */
  failClose?: boolean;
}

export interface FakeMcp {
  fetch: FetchLike;
  calls: McpCall[];
  /** `tools/call` requests in order. */
  toolCalls(): { name: string; arguments: Record<string, unknown> }[];
}

function rpcReply(options: FakeMcpOptions, id: number, body: Record<string, unknown>): Response {
  const message = { jsonrpc: "2.0", id, ...body };
  const headers = { "Mcp-Session-Id": SESSION_ID };
  if (options.sse === true) {
    const noise = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } };
    const text = `event: message\ndata: ${JSON.stringify(noise)}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    return new Response(text, { headers: { ...headers, "Content-Type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(message), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function parseRpc(text: string): McpCall["rpc"] {
  if (text === "") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    return undefined;
  }
  return {
    jsonrpc: parsed.jsonrpc,
    id: typeof parsed.id === "number" ? parsed.id : undefined,
    method: typeof parsed.method === "string" ? parsed.method : "",
    params: isRecord(parsed.params) ? parsed.params : {},
  };
}

export function fakeMcp(options: FakeMcpOptions = {}): FakeMcp {
  const calls: McpCall[] = [];

  const respond = (rpc: NonNullable<McpCall["rpc"]>, id: number): Response => {
    switch (rpc.method) {
      case "initialize":
        return rpcReply(options, id, {
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "atlassian-mcp-server", version: "1.0.0", icons: [{ src: "x" }] },
          },
        });
      case "tools/list": {
        if (options.toolPages !== undefined) {
          const page = Number(rpc.params.cursor ?? 0);
          return rpcReply(options, id, {
            result: {
              tools: options.toolPages[page] ?? [],
              ...(page + 1 < options.toolPages.length ? { nextCursor: String(page + 1) } : {}),
            },
          });
        }
        return rpcReply(options, id, { result: { tools: options.tools ?? [] } });
      }
      case "tools/call": {
        const name = String(rpc.params.name);
        const result = options.toolResults?.[name];
        if (result === undefined) {
          return rpcReply(options, id, {
            error: { code: -32602, message: `Unknown tool: ${name}` },
          });
        }
        return rpcReply(options, id, { result });
      }
      default:
        return rpcReply(options, id, { error: { code: -32601, message: "Method not found" } });
    }
  };

  const fetch: FetchLike = (url, init) => {
    const method = init?.method ?? "GET";
    const rpc = parseRpc(typeof init?.body === "string" ? init.body : "");
    calls.push({ method, url, headers: new Headers(init?.headers), rpc });

    if (method === "DELETE") {
      return options.failClose === true
        ? Promise.reject(new Error("close failed"))
        : Promise.resolve(new Response(null, { status: 200 }));
    }
    if (rpc?.id === undefined) {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return Promise.resolve(respond(rpc, rpc.id));
  };

  return {
    fetch,
    calls,
    toolCalls: () =>
      calls
        .filter((call) => call.rpc?.method === "tools/call")
        .map((call) => {
          const args = call.rpc?.params.arguments;
          return { name: String(call.rpc?.params.name), arguments: isRecord(args) ? args : {} };
        }),
  };
}

export function textResult(value: unknown): { content: { type: string; text: string }[] } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  };
}
