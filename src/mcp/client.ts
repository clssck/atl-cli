import { getAccessToken } from "../auth/index.ts";
import { AtlError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import {
  extractErrorMessage,
  mapHttpError,
  resolveTimeout,
  sendWithRetry,
  type FetchLike,
  type HttpMethod,
} from "../core/http.ts";
import { type Writer, writeStderr } from "../core/output.ts";
import { USER_AGENT, VERSION } from "../version.ts";

export const MCP_ENDPOINT = "https://mcp.atlassian.com/v1/mcp/authv2";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MAX_MESSAGE_CHARS = 500;

export interface McpClientOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike | undefined;
  /** Defaults to `ATL_MCP_URL`, then the Atlassian MCP v1 endpoint. */
  endpoint?: string;
  timeoutMs?: number;
  /** Backoff sleep between retries; defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
  /** Receives one JSONL `retry` diagnostic per retry; defaults to stderr. */
  stderr?: Writer;
}

export interface McpTool {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

/** Tool result with JSON text items parsed into values. */
export interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 3)}...` : text;
}

function protocolError(message: string): AtlError {
  return new AtlError(message, { code: "mcp_protocol_error", category: "api" });
}

/** `data:` payloads of each event in a `text/event-stream` body. */
function sseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.replaceAll(/\r\n?/g, "\n").split(/\n\n+/)) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n");
    if (data.trim() === "") {
      continue;
    }
    try {
      messages.push(JSON.parse(data));
    } catch {
      throw protocolError("MCP server sent an event that is not valid JSON");
    }
  }
  return messages;
}

/** Text items holding JSON become the parsed value; other text stays a string. */
function parseContentItem(item: unknown): unknown {
  if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
    return item;
  }
  const text = item.text.trim();
  if (!/^[[{]/.test(text)) {
    return item.text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return item.text;
  }
}

/** JSON that follows a prose prefix, e.g. `Failed to get page: 404. Details: {...}`. */
function embeddedJson(text: string): { prefix: string; value: unknown } | undefined {
  const at = text.search(/[[{]/);
  if (at === -1) {
    return undefined;
  }
  try {
    return { prefix: text.slice(0, at), value: JSON.parse(text.slice(at)) };
  } catch {
    return undefined;
  }
}

function isHttpErrorStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value < 600;
}

const STATUS_IN_TEXT = [
  /\bHTTP[ /]?(?:\d(?:\.\d)?\s+)?([45]\d\d)\b/i,
  /\bstatus(?:Code)?\W{0,3}([45]\d\d)\b/i,
  /\b([45]\d\d) (?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];

/** First HTTP error status in a tool error: `statusCode`/`status` fields at any depth, else the text. */
function findStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (typeof value === "string") {
    const nested = embeddedJson(value);
    const found = nested === undefined ? undefined : findStatus(nested.value, depth + 1);
    if (found !== undefined) {
      return found;
    }
    for (const pattern of STATUS_IN_TEXT) {
      const match = pattern.exec(value);
      if (match?.[1] !== undefined) {
        return Number(match[1]);
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStatus(entry, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["statusCode", "status"]) {
    if (isHttpErrorStatus(value[key])) {
      return value[key];
    }
  }
  for (const entry of Object.values(value)) {
    const found = findStatus(entry, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Human text for one error value; nested JSON (escaped inside strings) is decoded, not echoed. */
function describeToolError(value: unknown, depth = 0): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (typeof value === "string") {
    const nested = embeddedJson(value);
    const inner = nested === undefined ? undefined : describeToolError(nested.value, depth + 1);
    const text = nested === undefined || inner === undefined ? value : `${nested.prefix}${inner}`;
    return text.replaceAll(/\s+/g, " ").trim() || undefined;
  }
  if (Array.isArray(value)) {
    return extractErrorMessage(JSON.stringify({ errors: value }));
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.message === "string") {
    return describeToolError(value.message, depth + 1);
  }
  return extractErrorMessage(JSON.stringify(value));
}

/**
 * The server reports tool failures as text holding JSON such as
 * `{"error":true,"message":"...","statusCode":404}`; a carried HTTP status is classified like a
 * REST response so 404/403/429/5xx get the same codes and exit codes as direct calls.
 */
function toolError(name: string, content: readonly unknown[]): AtlError {
  const values = content.map((item) =>
    isRecord(item) && typeof item.text === "string" ? parseContentItem(item) : item,
  );
  const text = values
    .map((value) => describeToolError(value) ?? JSON.stringify(value))
    .join("; ")
    .trim();
  const message = truncate(`MCP tool ${name} failed: ${text || "no details"}`);
  const status = findStatus(values);
  if (status === undefined) {
    return new AtlError(message, { code: "mcp_tool_error", category: "api" });
  }
  const mapped = mapHttpError("POST", name, status, "");
  return new AtlError(message, {
    code: mapped.code,
    category: mapped.category,
    status,
    ...(mapped.hint === undefined ? {} : { hint: mapped.hint }),
    ...(mapped.next.length === 0 ? {} : { next: mapped.next }),
  });
}

function networkError(label: string, timeoutMs: number, error: unknown): AtlError {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new AtlError(`MCP ${label} timed out after ${timeoutMs} ms`, {
      code: "timeout",
      category: "transient",
      hint: "Raise ATL_TIMEOUT_MS or retry.",
      cause: error,
    });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new AtlError(`MCP ${label} failed: ${detail}`, {
    code: "network_error",
    category: "transient",
    hint: "Network failure; check connectivity and retry.",
    cause: error,
  });
}

export class McpClient {
  readonly endpoint: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #injectedFetch: FetchLike | undefined;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #stderr: Writer;
  #sessionId: string | undefined;
  #initialized = false;
  #nextId = 1;

  constructor(options: McpClientOptions = {}) {
    this.#env = options.env ?? process.env;
    const override = this.#env.ATL_MCP_URL?.trim();
    this.endpoint =
      options.endpoint ?? (override === undefined || override === "" ? MCP_ENDPOINT : override);
    this.#injectedFetch = options.fetch;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = resolveTimeout(options.timeoutMs);
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.#stderr = options.stderr ?? writeStderr;
  }

  async #headers(): Promise<Record<string, string>> {
    const token = await getAccessToken({
      env: this.#env,
      ...(this.#injectedFetch === undefined ? {} : { fetch: this.#injectedFetch }),
    });
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT,
      ...(this.#initialized ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}),
      ...(this.#sessionId === undefined ? {} : { "Mcp-Session-Id": this.#sessionId }),
    };
  }

  /**
   * Send one request under the shared retry policy (429/502/503/504 honoring Retry-After, and
   * network errors; 3 attempts, bounded sleep) when `idempotent`, exactly once otherwise.
   * Non-2xx responses throw the mapped error.
   */
  async #send(
    method: HttpMethod,
    init: RequestInit,
    label: string,
    idempotent: boolean,
  ): Promise<Response> {
    return sendWithRetry({
      method,
      url: this.endpoint,
      idempotent,
      send: () =>
        this.#fetch(this.endpoint, {
          ...init,
          method,
          signal: AbortSignal.timeout(this.#timeoutMs),
        }),
      sleep: this.#sleep,
      stderr: this.#stderr,
      networkError: (error) => networkError(label, this.#timeoutMs, error),
    });
  }

  /**
   * One JSON-RPC request; returns `result` or throws the mapped JSON-RPC error. `idempotent`
   * requests (initialize, tools/list, read tools) are retried on 429/503; others never are.
   */
  async #request(
    method: string,
    params: Record<string, unknown>,
    idempotent: boolean,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#send(
      "POST",
      {
        headers: await this.#headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      method,
      idempotent,
    );
    const text = await response.text().catch(() => "");
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId !== null && sessionId !== "") {
      this.#sessionId = sessionId;
    }

    const contentType = response.headers.get("content-type") ?? "";
    let messages: unknown[];
    if (/text\/event-stream/i.test(contentType)) {
      messages = sseMessages(text);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw protocolError(`MCP ${method} returned a body that is not JSON`);
      }
      messages = Array.isArray(parsed) ? parsed : [parsed];
    }
    const reply = messages.find((message) => isRecord(message) && message.id === id);
    if (!isRecord(reply)) {
      throw protocolError(`MCP ${method} returned no response for id ${id}`);
    }
    if (isRecord(reply.error)) {
      const { code, message } = reply.error;
      throw new AtlError(
        `MCP ${method} failed: ${truncate(typeof message === "string" ? message : "unknown error")}`,
        {
          code: "mcp_error",
          category: "api",
          ...(typeof code === "number" ? { hint: `JSON-RPC error ${code}` } : {}),
        },
      );
    }
    if (!Object.hasOwn(reply, "result")) {
      throw protocolError(`MCP ${method} response has neither result nor error`);
    }
    return reply.result;
  }

  async #notify(method: string): Promise<void> {
    const response = await this.#send(
      "POST",
      { headers: await this.#headers(), body: JSON.stringify({ jsonrpc: "2.0", method }) },
      method,
      true,
    );
    await response.body?.cancel();
  }

  async initialize(): Promise<McpInitializeResult> {
    const result = await this.#request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "atl", version: VERSION },
      },
      true,
    );
    if (!isRecord(result) || typeof result.protocolVersion !== "string") {
      throw protocolError("MCP initialize returned an unexpected result");
    }
    this.#initialized = true;
    await this.#notify("notifications/initialized");
    return {
      protocolVersion: result.protocolVersion,
      serverInfo: isRecord(result.serverInfo) ? result.serverInfo : {},
      capabilities: isRecord(result.capabilities) ? result.capabilities : {},
    };
  }

  /** Every tool, following `nextCursor`. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.#request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        true,
      );
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw protocolError("MCP tools/list returned an unexpected result");
      }
      for (const tool of result.tools) {
        if (isRecord(tool) && typeof tool.name === "string" && isRecord(tool.inputSchema)) {
          tools.push({ ...tool, name: tool.name, inputSchema: tool.inputSchema });
        }
      }
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor !== ""
          ? result.nextCursor
          : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  /**
   * Call a tool. Only `readOnly` calls (the tool's `readOnlyHint`, or a lookup such as `discover`)
   * are retried on 429/503; a call that may write is sent exactly once.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { readOnly?: boolean } = {},
  ): Promise<McpToolResult> {
    const result = await this.#request(
      "tools/call",
      { name, arguments: args },
      options.readOnly === true,
    );
    if (!isRecord(result)) {
      throw protocolError(`MCP tool ${name} returned an unexpected result`);
    }
    const raw = Array.isArray(result.content) ? result.content : [];
    if (result.isError === true) {
      throw toolError(name, raw);
    }
    return {
      content: raw.map(parseContentItem),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  }

  /** End the server session; failures are ignored. */
  async close(): Promise<void> {
    if (this.#sessionId === undefined) {
      return;
    }
    try {
      const response = await this.#send(
        "DELETE",
        { headers: await this.#headers() },
        "close",
        false,
      );
      await response.body?.cancel();
    } catch {
      // Best effort: the server expires idle sessions on its own.
    }
    this.#sessionId = undefined;
  }
}

/** Initialize a client, run `action`, and always close the session. */
export async function withMcpClient<T>(
  options: McpClientOptions,
  action: (client: McpClient, init: McpInitializeResult) => Promise<T>,
): Promise<T> {
  const client = new McpClient(options);
  try {
    return await action(client, await client.initialize());
  } finally {
    await client.close();
  }
}
