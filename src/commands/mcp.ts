import { Type } from "../core/schema.ts";
import {
  closestMatch,
  defineCommand,
  type CommandContext,
  type CommandInput,
  type CommandSpec,
} from "../core/cli.ts";
import { AtlError, type NextCommand } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { FetchLike } from "../core/http.ts";
import { keepRaw } from "../core/output.ts";
import { openSession } from "../core/session.ts";
import { withMcpClient, type McpTool } from "../mcp/client.ts";
import { applyArgv } from "./write.ts";

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
      description: "Emit the mcp/tools-v1.json snapshot shape (use with --output)",
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
  ],
  run: (ctx, input) =>
    withMcpClient(clientOptions(ctx), async (client, init) => {
      const tools = await client.listTools();
      if (input.flags.snapshot === true) {
        return keepRaw(snapshotOf(client.endpoint, init, tools));
      }
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
    }),
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
      return keepRaw(await client.callTool(name, args));
    }
    if (ctx.plan) {
      const base = applyArgv(ctx.argv);
      const apply: NextCommand = base.includes("--yes") ? base : [...base, "--yes"];
      return { type: "plan", tool: name, arguments: args, next: [apply] };
    }
    if (flags.yes !== true) {
      throw new AtlError(`${name} changes data and needs confirmation`, {
        code: "confirmation_required",
        category: "input",
        hint: "Preview with --plan, then re-run with --yes.",
        next: [["atl", ...ctx.argv, "--plan"]],
      });
    }
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
