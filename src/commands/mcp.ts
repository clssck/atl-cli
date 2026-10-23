import { Type } from "../core/schema.ts";
import {
  closestMatch,
  defineCommand,
  type CommandContext,
  type CommandInput,
  type CommandSpec,
} from "../core/cli.ts";
import { AtlError, inputError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { FetchLike } from "../core/http.ts";
import { keepRaw } from "../core/output.ts";
import { openSession } from "../core/session.ts";
import { check } from "../core/validate.ts";
import { withMcpClient, type McpClient, type McpTool, type McpToolResult } from "../mcp/client.ts";
import { authStatus } from "../auth/index.ts";
import { applyArgvFor, requireYes } from "./write.ts";

export const mcpGroups: Readonly<Record<string, string>> = {
  mcp: "Atlassian MCP parity tooling: list tools, call any tool (escape hatch)",
};

/** Test seam: an injected `fetch` and file reader used by every command in this module. */
export const mcpDeps: {
  fetch?: FetchLike | undefined;
  readFile?: ((path: string) => Promise<string>) | undefined;
} = {};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function clientOptions(ctx: CommandContext) {
  return { env: ctx.env, fetch: mcpDeps.fetch };
}

/**
 * The MCP filters its tool list and catalog by the token's scopes, so a snapshot taken with a
 * login made for another resource is silently smaller. An env token's resource is unknown.
 */
async function requireLoginFor(ctx: CommandContext, endpoint: string): Promise<void> {
  const status = await authStatus({ env: ctx.env });
  if (status.source !== "stored" || status.resource === endpoint) {
    return;
  }
  throw inputError(
    "resource_mismatch",
    `This login is for ${status.resource}, not ${endpoint}; a snapshot would only show what its scopes allow`,
    `Log in to a throwaway config dir first: ATL_CONFIG_DIR=<dir> atl auth login --resource ${endpoint}`,
  );
}

async function readJsonFile(path: string, flag: string): Promise<unknown> {
  const text = await (mcpDeps.readFile ?? ((p: string) => Bun.file(p).text()))(path).catch(
    (cause: unknown) => {
      throw new AtlError(`Cannot read ${flag} ${path}`, {
        code: "input_file_unreadable",
        category: "input",
        cause,
      });
    },
  );
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AtlError(`${flag} ${path} is not valid JSON`, {
      code: "invalid_json_input",
      category: "input",
      cause,
    });
  }
}

async function readJsonObject(path: string, flag: string): Promise<Record<string, unknown>> {
  const value = await readJsonFile(path, flag);
  if (!isRecord(value)) {
    throw new AtlError(`${flag} ${path} must contain a JSON object`, {
      code: "invalid_json_input",
      category: "input",
    });
  }
  return value;
}

async function siteCloudId(ctx: CommandContext): Promise<string> {
  const session = await openSession(ctx, { fetch: mcpDeps.fetch });
  return session.site.cloudId;
}

function isReadOnly(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true;
}

function requiredArgs(tool: McpTool): string[] {
  const { required } = tool.inputSchema;
  return Array.isArray(required)
    ? required.filter((name): name is string => typeof name === "string")
    : [];
}

// ---------------------------------------------------------------------------
// mcp.tools
// ---------------------------------------------------------------------------

const ToolsFlags = Type.Object({
  names: Type.Optional(Type.Boolean({ description: "Print only tool names" })),
  snapshot: Type.Optional(
    Type.Boolean({
      description:
        "Emit the mcp/tools-v1.json / mcp/tools-v2.json snapshot shape for the configured endpoint (use with --output)",
    }),
  ),
  catalog: Type.Optional(
    Type.Boolean({
      description:
        "Emit the mcp/operations-v2.json shape: every discover-only operation of the v2 endpoint (use with --output)",
    }),
  ),
});

function snapshotOf(
  endpoint: string,
  init: { protocolVersion: string; serverInfo: Record<string, unknown> },
  tools: readonly McpTool[],
): Record<string, unknown> {
  return {
    endpoint,
    serverInfo: Object.fromEntries(
      Object.entries(init.serverInfo).filter(([key]) => key !== "icons"),
    ),
    protocolVersion: init.protocolVersion,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
    })),
  };
}

/** Parallel `discover` calls while building the operation catalog. */
const DISCOVER_CONCURRENCY = 8;
const SUMMARY_MAX_CHARS = 200;

const DiscoverResult = Type.Object({
  name: Type.String(),
  product: Type.String(),
  executeTool: Type.String(),
  description: Type.String(),
  inputs: Type.Array(
    Type.Object({ name: Type.String(), type: Type.String(), required: Type.Boolean() }),
  ),
});

interface CatalogOperation {
  name: string;
  product: string;
  executeTool: string;
  description: string;
  inputs: { name: string; type: string; required: boolean }[];
}

/** First sentence of a description, whitespace collapsed, cut to 200 characters. */
function summary(description: string): string {
  const text = description.replaceAll(/\s+/g, " ").trim();
  const end = /[.!?](?=\s+[^\sa-z]|$)/.exec(text);
  const sentence = end === null ? text : text.slice(0, end.index + 1);
  return sentence.length <= SUMMARY_MAX_CHARS
    ? sentence
    : `${sentence.slice(0, SUMMARY_MAX_CHARS - 3)}...`;
}

/** The `results` of a `discover` call; its text is one JSON line, then an optional "also matched" list. */
function discoverResults(result: McpToolResult): unknown[] {
  const [first] = result.content;
  let payload = first;
  if (typeof first === "string") {
    try {
      payload = JSON.parse(first.split("\n", 1)[0] ?? "");
    } catch {
      payload = undefined;
    }
  }
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new AtlError("MCP discover returned an unexpected result", {
      code: "mcp_protocol_error",
      category: "api",
    });
  }
  return payload.results;
}

/** Look up one operation by its exact name; `undefined` when discover does not return it in full. */
async function discoverOperation(
  client: McpClient,
  name: string,
): Promise<CatalogOperation | undefined> {
  const found = discoverResults(
    await client.callTool("discover", { query: name }, { readOnly: true }),
  ).find((result) => isRecord(result) && result.name === name);
  if (found === undefined) {
    return undefined;
  }
  if (!check(DiscoverResult, found)) {
    throw new AtlError(`MCP discover returned an unexpected record for ${name}`, {
      code: "mcp_protocol_error",
      category: "api",
    });
  }
  return {
    name,
    product: found.product,
    executeTool: found.executeTool,
    description: summary(found.description),
    inputs: found.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required,
    })),
  };
}

/**
 * The mcp/operations-v2.json catalog: every operation that `?tools=all` lists beyond the primary
 * tools, described by `discover` (the only source of `product`), sorted by product and name.
 */
async function operationCatalog(ctx: CommandContext): Promise<Record<string, unknown>> {
  const options = clientOptions(ctx);
  return withMcpClient(options, async (client) => {
    await requireLoginFor(ctx, client.endpoint);
    const primary = new Set((await client.listTools()).map((tool) => tool.name));
    if (!primary.has("discover")) {
      throw inputError(
        "catalog_unsupported",
        `${client.endpoint} has no discover tool; --catalog needs the MCP v2 endpoint`,
        "Run with ATL_MCP_URL=https://mcp.atlassian.com/v2/mcp and a login made with `atl auth login --resource https://mcp.atlassian.com/v2/mcp`.",
      );
    }
    const everything = new URL(client.endpoint);
    everything.searchParams.set("tools", "all");
    const listed = await withMcpClient({ ...options, endpoint: everything.href }, (all) =>
      all.listTools(),
    );
    const queue = listed.map((tool) => tool.name).filter((name) => !primary.has(name));
    const operations: CatalogOperation[] = [];
    const missing: string[] = [];
    const worker = async (): Promise<void> => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const operation = await discoverOperation(client, name);
        if (operation === undefined) {
          missing.push(name);
        } else {
          operations.push(operation);
        }
      }
    };
    await Promise.all(Array.from({ length: DISCOVER_CONCURRENCY }, () => worker()));
    if (missing.length > 0) {
      throw new AtlError(
        `discover did not return ${missing.length} operation(s) by name: ${missing.toSorted().join(", ")}`,
        { code: "catalog_incomplete", category: "api" },
      );
    }
    // Plain code-unit order (names are ASCII and unique), not locale order: it matches the committed file.
    operations.sort((a, b) =>
      a.product === b.product ? (a.name < b.name ? -1 : 1) : a.product < b.product ? -1 : 1,
    );
    return {
      generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      endpoint: client.endpoint,
      count: operations.length,
      operations,
    };
  });
}

const mcpTools = defineCommand({
  name: "mcp.tools",
  summary: "List the tools the Atlassian MCP server offers",
  args: [],
  flags: ToolsFlags,
  sideEffects: "none",
  examples: [
    "atl mcp tools",
    "atl mcp tools --names",
    "atl mcp tools --full --fields name,inputSchema",
    "atl mcp tools --snapshot --pretty --output mcp/tools-v1.json",
    "ATL_MCP_URL=https://mcp.atlassian.com/v2/mcp atl mcp tools --snapshot --output mcp/tools-v2.json",
    "ATL_MCP_URL=https://mcp.atlassian.com/v2/mcp atl mcp tools --catalog --pretty --output mcp/operations-v2.json",
  ],
  run: async (ctx, input) => {
    if (input.flags.catalog === true) {
      if (input.flags.snapshot === true || input.flags.names === true) {
        throw inputError(
          "conflicting_flags",
          "--catalog cannot be combined with --snapshot or --names",
        );
      }
      return keepRaw(await operationCatalog(ctx));
    }
    return withMcpClient(clientOptions(ctx), async (client, init) => {
      if (input.flags.snapshot === true) {
        await requireLoginFor(ctx, client.endpoint);
        return keepRaw(snapshotOf(client.endpoint, init, await client.listTools()));
      }
      const tools = await client.listTools();
      if (input.flags.names === true) {
        return { items: tools.map((tool) => tool.name) };
      }
      if (ctx.full) {
        return { items: tools };
      }
      return {
        items: tools.map((tool) => ({
          name: tool.name,
          readOnly: isReadOnly(tool),
          required: requiredArgs(tool),
        })),
      };
    });
  },
});

// ---------------------------------------------------------------------------
// mcp.call
// ---------------------------------------------------------------------------

const CallFlags = Type.Object({
  argsFile: Type.Optional(Type.String({ description: "JSON file with the tool arguments object" })),
  arg: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool argument as key=value (value parsed as JSON when possible); repeatable",
    }),
  ),
  yes: Type.Optional(Type.Boolean({ description: "Confirm a tool that changes data" })),
});

function parseArgPairs(
  pairs: readonly string[],
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new AtlError(`Invalid --arg "${pair}"`, {
        code: "invalid_arg",
        category: "input",
        hint: "Use --arg key=value; values are parsed as JSON when possible.",
      });
    }
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    const property = properties[key];
    const wantsString = isRecord(property) && property.type === "string";
    let value: unknown = raw;
    if (!wantsString) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    args[key] = value;
  }
  return args;
}

function findTool(tools: readonly McpTool[], name: string): McpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool !== undefined) {
    return tool;
  }
  const suggestion = closestMatch(
    name,
    tools.map((candidate) => candidate.name),
  );
  throw new AtlError(
    `Unknown MCP tool "${name}"${suggestion === undefined ? "" : `; did you mean ${suggestion}?`}`,
    {
      code: "unknown_tool",
      category: "input",
      hint: "List tools with `atl mcp tools --names`.",
      next: [["atl", "mcp", "tools", "--names"]],
    },
  );
}

async function runMcpCall(
  ctx: CommandContext,
  input: CommandInput<typeof CallFlags>,
): Promise<unknown> {
  const name = input.args.tool ?? "";
  const { flags } = input;
  const fromFile =
    flags.argsFile === undefined ? {} : await readJsonObject(flags.argsFile, "--args-file");

  return withMcpClient(clientOptions(ctx), async (client) => {
    const tool = findTool(await client.listTools(), name);
    const schemaProperties = tool.inputSchema.properties;
    const properties = isRecord(schemaProperties) ? schemaProperties : {};
    const args: Record<string, unknown> = {
      ...fromFile,
      ...parseArgPairs(flags.arg ?? [], properties),
    };
    const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
    if (isRecord(schemaProperties) && unknown.length > 0) {
      throw new AtlError(`Unknown argument for ${name}: ${unknown.join(", ")}`, {
        code: "unknown_tool_argument",
        category: "input",
        hint: `Valid arguments: ${Object.keys(properties).join(", ") || "none"}.`,
        next: [["atl", "mcp", "tools", "--full", "--fields", "name,inputSchema"]],
      });
    }
    if (requiredArgs(tool).includes("cloudId") && args.cloudId === undefined) {
      args.cloudId = await siteCloudId(ctx);
    }

    if (isReadOnly(tool)) {
      return keepRaw(await client.callTool(name, args, { readOnly: true }));
    }
    if (ctx.plan) {
      return { type: "plan", tool: name, arguments: args, next: [applyArgvFor(ctx, true)] };
    }
    requireYes(ctx, flags.yes, name);
    return keepRaw(await client.callTool(name, args));
  });
}

const mcpCall = defineCommand({
  name: "mcp.call",
  summary: "Call any Atlassian MCP tool with JSON arguments",
  args: [{ name: "tool", description: "MCP tool name (see `atl mcp tools`)", required: true }],
  flags: CallFlags,
  sideEffects: "write",
  examples: [
    'atl mcp call search --arg query="onboarding"',
    "atl mcp call getVisibleJiraProjects",
    "atl mcp call getTeamworkGraphObject --args-file objects.json",
    "atl mcp call createCompassComponent --args-file component.json --plan",
  ],
  run: (ctx, input) => runMcpCall(ctx, input),
});

export const mcpCommands: readonly CommandSpec[] = [mcpTools, mcpCall];
