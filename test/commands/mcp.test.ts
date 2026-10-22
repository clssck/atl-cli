import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "../../src/core/schema.ts";
import { mcpCommands, mcpDeps } from "../../src/commands/mcp.ts";
import { miscCommands } from "../../src/commands/misc.ts";
import {
  CommandRegistry,
  defineCommand,
  type CommandContext,
  type CommandSpec,
} from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { fakeMcp, textResult, type FakeMcp } from "../helpers/mcp.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";

const TOOLS = [
  {
    name: "search",
    description: "Rovo search",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { cloudId: { type: "string" }, query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "getJiraIssue",
    description: "Get issue",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cloudId: { type: "string" },
        issueIdOrKey: { type: "string" },
        expand: { type: "array" },
        limit: { type: "integer" },
      },
      required: ["cloudId", "issueIdOrKey"],
    },
  },
  {
    name: "createJiraIssue",
    description: "Create issue",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { cloudId: { type: "string" }, summary: { type: "string" } },
      required: ["cloudId", "summary"],
    },
  },
];

const TOOL_RESULTS = {
  search: textResult({
    results: [
      {
        id: "ari:cloud:confluence:c:page/1",
        title: "Sablon",
        text: "line one\n\n   line two",
        url: "https://acme.atlassian.net/wiki/spaces/X/pages/1",
        type: "page",
        metadata: { cloudId: "c", searchScope: "generic" },
      },
    ],
  }),
  getJiraIssue: textResult({ key: "ABC-1" }),
  createJiraIssue: textResult({ key: "ABC-2" }),
};

let root: string;
let ctx: CommandContext;
let server: FakeMcp;
let files: Record<string, string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-mcp-test-"));
  const env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
  await saveConfig(
    {
      defaultSite: "acme.atlassian.net",
      sites: {
        "acme.atlassian.net": {
          cloudId: CLOUD,
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["read:jira-work"],
          cachedAt: new Date().toISOString(),
        },
      },
    },
    env,
  );
  ctx = makeContext(env);
  server = fakeMcp({ tools: TOOLS, toolResults: TOOL_RESULTS });
  files = {};
  mcpDeps.fetch = server.fetch;
  mcpDeps.readFile = (path) => {
    const text = files[path];
    return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
  };
});

afterEach(async () => {
  mcpDeps.fetch = undefined;
  mcpDeps.readFile = undefined;
  await rm(root, { recursive: true, force: true });
});

function command(name: string): CommandSpec {
  const spec = mcpCommands.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

function run(
  name: string,
  args: Record<string, string> = {},
  flags: Record<string, unknown> = {},
  overrides: Partial<CommandContext> = {},
  rest: string[] = [],
): Promise<unknown> {
  return command(name).run({ ...ctx, ...overrides }, { args, rest, flags });
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

describe("mcp tools", () => {
  test("compact listing shows name, readOnly and required arguments", async () => {
    expect(await run("mcp.tools")).toEqual({
      items: [
        { name: "search", readOnly: true, required: ["query"] },
        { name: "getJiraIssue", readOnly: true, required: ["cloudId", "issueIdOrKey"] },
        { name: "createJiraIssue", readOnly: false, required: ["cloudId", "summary"] },
      ],
    });
  });

  test("--names lists names and --full returns raw tools with schemas", async () => {
    expect(await run("mcp.tools", {}, { names: true })).toEqual({
      items: ["search", "getJiraIssue", "createJiraIssue"],
    });
    expect(await run("mcp.tools", {}, {}, { full: true })).toMatchObject({
      items: [{ inputSchema: TOOLS[0]?.inputSchema }, {}, {}],
    });
  });

  test("--snapshot emits the mcp/tools-v1.json shape without icons", async () => {
    const snapshot = await run("mcp.tools", {}, { snapshot: true });
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify({
        endpoint: "https://mcp.atlassian.com/v1/mcp/authv2",
        serverInfo: { name: "atlassian-mcp-server", version: "1.0.0" },
        protocolVersion: "2025-06-18",
        tools: TOOLS.map(({ name, description, annotations, inputSchema }) => ({
          name,
          description,
          annotations,
          inputSchema,
        })),
      }),
    );
  });

  test("closes the session", async () => {
    await run("mcp.tools");
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });
});

describe("mcp call", () => {
  test("injects the resolved site's cloudId when the tool requires it", async () => {
    const result = await run("mcp.call", { tool: "getJiraIssue" }, { arg: ["issueIdOrKey=ABC-1"] });
    expect(result).toEqual({ content: [{ key: "ABC-1" }] });
    expect(server.toolCalls()).toEqual([
      { name: "getJiraIssue", arguments: { issueIdOrKey: "ABC-1", cloudId: CLOUD } },
    ]);
  });

  test("keeps an explicit cloudId and does not inject for tools that do not require it", async () => {
    await run(
      "mcp.call",
      { tool: "getJiraIssue" },
      { arg: ["issueIdOrKey=ABC-1", "cloudId=other"] },
    );
    await run("mcp.call", { tool: "search" }, { arg: ["query=docs"] });
    expect(server.toolCalls().map((call) => call.arguments)).toEqual([
      { issueIdOrKey: "ABC-1", cloudId: "other" },
      { query: "docs" },
    ]);
  });

  test("--arg values are JSON-parsed except for string-typed properties", async () => {
    await run(
      "mcp.call",
      { tool: "getJiraIssue" },
      { arg: ["issueIdOrKey=10042", 'expand=["names","schema"]', "limit=5"] },
    );
    expect(server.toolCalls()[0]?.arguments).toEqual({
      cloudId: CLOUD,
      issueIdOrKey: "10042",
      expand: ["names", "schema"],
      limit: 5,
    });
  });

  test("--args-file is merged under --arg", async () => {
    files["args.json"] = JSON.stringify({ issueIdOrKey: "ABC-1", expand: ["names"] });
    await run(
      "mcp.call",
      { tool: "getJiraIssue" },
      { argsFile: "args.json", arg: ["issueIdOrKey=ABC-9"] },
    );
    expect(server.toolCalls()[0]?.arguments).toEqual({
      cloudId: CLOUD,
      issueIdOrKey: "ABC-9",
      expand: ["names"],
    });
  });

  test("rejects an --args-file that is missing, invalid, or not an object", async () => {
    files["list.json"] = "[1]";
    files["bad.json"] = "{";
    expect(
      (await rejection(run("mcp.call", { tool: "search" }, { argsFile: "nope.json" }))).code,
    ).toBe("input_file_unreadable");
    expect(
      (await rejection(run("mcp.call", { tool: "search" }, { argsFile: "bad.json" }))).code,
    ).toBe("invalid_json_input");
    expect(
      (await rejection(run("mcp.call", { tool: "search" }, { argsFile: "list.json" }))).code,
    ).toBe("invalid_json_input");
    expect(server.calls).toHaveLength(0);
  });

  test("a malformed --arg is an input error", async () => {
    const error = await rejection(run("mcp.call", { tool: "search" }, { arg: ["query"] }));
    expect(error).toMatchObject({ code: "invalid_arg", category: "input" });
  });

  test("an unknown tool suggests the closest name and calls nothing", async () => {
    const error = await rejection(run("mcp.call", { tool: "serch" }));
    expect(error).toMatchObject({ code: "unknown_tool", category: "input" });
    expect(error.message).toContain("did you mean search?");
    expect(server.toolCalls()).toHaveLength(0);
  });

  test("unknown --arg and --args-file keys are rejected with the valid keys", async () => {
    files["extra.json"] = JSON.stringify({ query: "x", cursor: "abc" });
    const viaArg = await rejection(run("mcp.call", { tool: "search" }, { arg: ["bogusKey=1"] }));
    expect(viaArg).toMatchObject({ code: "unknown_tool_argument", category: "input" });
    expect(viaArg.hint).toBe("Valid arguments: cloudId, query.");
    const viaFile = await rejection(
      run("mcp.call", { tool: "search" }, { argsFile: "extra.json" }),
    );
    expect(viaFile).toMatchObject({ code: "unknown_tool_argument" });
    expect(viaFile.message).toContain("cursor");
    expect(server.toolCalls()).toHaveLength(0);
  });

  test("a write tool needs --yes and sends nothing without it", async () => {
    const error = await rejection(
      run(
        "mcp.call",
        { tool: "createJiraIssue" },
        { arg: ["summary=Hi"] },
        { argv: ["mcp", "call", "createJiraIssue", "--arg", "summary=Hi"] },
      ),
    );
    expect(error).toMatchObject({ code: "confirmation_required", category: "input" });
    expect(error.next).toEqual([
      ["atl", "mcp", "call", "createJiraIssue", "--arg", "summary=Hi", "--plan"],
    ]);
    expect(server.toolCalls()).toHaveLength(0);
  });

  test("--plan returns the arguments and an apply command without calling the tool", async () => {
    const plan = await run(
      "mcp.call",
      { tool: "createJiraIssue" },
      { arg: ["summary=Hi"] },
      { plan: true, argv: ["mcp", "call", "createJiraIssue", "--arg", "summary=Hi", "--plan"] },
    );
    expect(plan).toEqual({
      type: "plan",
      tool: "createJiraIssue",
      arguments: { cloudId: CLOUD, summary: "Hi" },
      next: [["atl", "mcp", "call", "createJiraIssue", "--arg", "summary=Hi", "--yes"]],
    });
    expect(server.toolCalls()).toHaveLength(0);
  });

  test("--yes sends the write", async () => {
    const result = await run(
      "mcp.call",
      { tool: "createJiraIssue" },
      { arg: ["summary=Hi"], yes: true },
    );
    expect(result).toEqual({ content: [{ key: "ABC-2" }] });
    expect(server.toolCalls()).toEqual([
      { name: "createJiraIssue", arguments: { cloudId: CLOUD, summary: "Hi" } },
    ]);
  });

  test("read-only tools run even with --plan", async () => {
    await run("mcp.call", { tool: "search" }, { arg: ["query=x"] }, { plan: true });
    expect(server.toolCalls()).toHaveLength(1);
  });
});

describe("mcp call errors", () => {
  test("a tool failure is classified by its carried status and still closes the session", async () => {
    server = fakeMcp({
      tools: TOOLS,
      toolResults: {
        search: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: true, message: "denied", statusCode: 403 }),
            },
          ],
        },
      },
    });
    mcpDeps.fetch = server.fetch;
    const error = await rejection(run("mcp.call", { tool: "search" }, { arg: ["query=x"] }));
    expect(error).toMatchObject({ code: "http_403", category: "auth", status: 403, exitCode: 1 });
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });
});

describe("get", () => {
  interface Seen {
    command: string;
    args: Record<string, string>;
    flags: Record<string, unknown>;
  }

  let seen: Seen[];
  let registry: CommandRegistry;

  beforeEach(() => {
    seen = [];
    registry = new CommandRegistry();
    registry.register(
      ["page.get", "issue.get", "comment.get"].map((name) =>
        defineCommand({
          name,
          summary: name,
          args: [{ name: "ref", description: "ref", required: true }],
          flags: Type.Object({}),
          sideEffects: "none",
          examples: [],
          run(_ctx, input) {
            seen.push({ command: name, args: { ...input.args }, flags: { ...input.flags } });
            return Promise.resolve({ from: name });
          },
        }),
      ),
    );
  });

  function get(ref: string, flags: Record<string, unknown> = {}): Promise<unknown> {
    const spec = miscCommands.find((candidate) => candidate.name === "get");
    if (spec === undefined) {
      throw new Error("missing get");
    }
    return spec.run({ ...ctx, registry }, { args: { ref }, rest: [], flags });
  }

  test("a Confluence page URL goes to page.get", async () => {
    const url = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Title";
    expect(await get(url, { format: "storage" })).toEqual({ from: "page.get" });
    expect(seen).toEqual([
      { command: "page.get", args: { page: url }, flags: { format: "storage" } },
    ]);
  });

  test("an issue key goes to issue.get with format and comments", async () => {
    await get("ABC-123", { format: "adf", comments: 3 });
    expect(seen).toEqual([
      { command: "issue.get", args: { issue: "ABC-123" }, flags: { format: "adf", comments: 3 } },
    ]);
  });

  test("a Jira ARI goes to issue.get", async () => {
    const ari = "ari:cloud:jira:11111111-2222-3333-4444-555555555555:issue/10000";
    await get(ari);
    expect(seen).toEqual([{ command: "issue.get", args: { issue: ari }, flags: {} }]);
  });

  test("a Confluence page ARI goes to page.get", async () => {
    const ari = "ari:cloud:confluence:11111111-2222-3333-4444-555555555555:page/123456";
    await get(ari);
    expect(seen).toEqual([{ command: "page.get", args: { page: ari }, flags: {} }]);
  });

  test("a page URL with focusedCommentId and a comment ARI go to comment.get", async () => {
    const url = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Title?focusedCommentId=789";
    const ari = "ari:cloud:confluence:11111111-2222-3333-4444-555555555555:comment/789";
    await get(url, { inline: true });
    await get(ari);
    expect(seen).toEqual([
      { command: "comment.get", args: { comment: url }, flags: { inline: true } },
      { command: "comment.get", args: { comment: ari }, flags: {} },
    ]);
  });

  test("storage format is rejected for Jira issues and comments", async () => {
    expect((await rejection(get("ABC-1", { format: "storage" }))).code).toBe(
      "unsupported_body_format",
    );
    expect(seen).toHaveLength(0);
  });

  test("unrecognized and ambiguous references are input errors", async () => {
    expect((await rejection(get("hello"))).category).toBe("input");
    expect((await rejection(get("12345"))).code).toBe("ambiguous_ref");
  });

  test("a missing target command is an internal error", async () => {
    registry = new CommandRegistry();
    expect(await rejection(get("ABC-1"))).toMatchObject({
      code: "command_missing",
      category: "internal",
    });
  });
});

function runFormats(flags: Record<string, unknown> = {}): Promise<unknown> {
  const spec = miscCommands.find((candidate) => candidate.name === "formats");
  if (spec === undefined) {
    throw new Error("missing formats");
  }
  return spec.run(ctx, { args: {}, rest: [], flags });
}

describe("formats", () => {
  test("covers both products, the markdown mappings, and the render rules", async () => {
    const guide = await runFormats();
    expect(guide).toMatchObject({
      products: {
        confluence: {
          formats: { md: expect.any(String), adf: expect.any(String), storage: expect.any(String) },
        },
        jira: { formats: { md: expect.any(String), adf: expect.any(String) } },
      },
    });
    const text = JSON.stringify(guide);
    for (const needle of [
      "heading",
      "taskItem",
      "tableHeader",
      "codeBlock",
      "mediaSingle",
      "strong",
      "**Info:**",
      "<details>",
      "<!-- macro:",
      "media:",
      "@Name",
    ]) {
      expect(text).toContain(needle);
    }
    expect(guide).toHaveProperty("markdownToAdf");
    expect(guide).toHaveProperty("adfToMarkdown");
  });

  test("--product limits the guide to one product", async () => {
    const guide = await runFormats({ product: "jira" });
    expect(guide).toHaveProperty("products.jira");
    expect(guide).not.toHaveProperty("products.confluence");
  });
});
