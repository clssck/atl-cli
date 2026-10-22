import { describe, expect, test } from "bun:test";
import { Type } from "../../src/core/schema.ts";
import { CommandRegistry, defineCommand } from "../../src/core/cli.ts";
import { AtlError } from "../../src/core/errors.ts";
import { agentContract, commandsRun, metaCommands } from "../../src/commands/meta.ts";
import { makeContext } from "../helpers/context.ts";

const pageGet = defineCommand({
  name: "page.get",
  summary: "Get a page or blog post with its body",
  args: [{ name: "page", description: "Page id or URL", required: true }],
  flags: Type.Object({ format: Type.Optional(Type.String({ description: "Body format" })) }),
  sideEffects: "none",
  examples: ["atl page get 123"],
  run: () => Promise.resolve({}),
});
const pageCreate = defineCommand({
  name: "page.create",
  summary: "Create a page or blog post from a file; sends once",
  args: [],
  flags: Type.Object({ title: Type.String({ description: "Title" }) }),
  sideEffects: "write",
  examples: [],
  run: () => Promise.resolve({}),
});
const cql = defineCommand({
  name: "cql",
  summary: "Search Confluence with CQL",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run: () => Promise.resolve({}),
});

function context(overrides = {}) {
  const registry = new CommandRegistry();
  registry.register([pageGet, pageCreate, cql, ...metaCommands]);
  return makeContext({}, { registry, ...overrides });
}

async function run(flags: Record<string, unknown> = {}): Promise<unknown> {
  return await commandsRun.run(context(), { args: {}, rest: [], flags });
}

describe("commands run", () => {
  test("no filter returns a grouped index with a write list and a hint", async () => {
    const result = await run();
    expect(result).toEqual({
      commands: {
        agent: { contract: "Print the machine contract" },
        commands: { run: "List commands" },
        cql: "Search Confluence with CQL",
        page: {
          create: "Create a page or blog post from a file",
          get: "Get a page or blog post with its body",
        },
      },
      writes: ["page.create"],
      hint: "atl commands run --fields page.get for flags and examples",
    });
  });

  test("--fields returns full entries without empty arrays or defaults", async () => {
    const result = await run({ fields: "page.get,cql,page.create" });
    expect(result).toEqual({
      commands: [
        { name: "cql", usage: "atl cql", summary: "Search Confluence with CQL" },
        {
          name: "page.create",
          usage: expect.stringContaining("atl page create"),
          summary: "Create a page or blog post from a file; sends once",
          flags: expect.objectContaining({ required: ["title"] }),
          sideEffects: "write",
        },
        {
          name: "page.get",
          usage: expect.stringContaining("atl page get <page>"),
          summary: "Get a page or blog post with its body",
          args: [{ name: "page", description: "Page id or URL", required: true }],
          flags: expect.objectContaining({ properties: expect.any(Object) }),
          examples: ["atl page get 123"],
        },
      ],
    });
  });

  test("--contains selects full entries by words", async () => {
    const result = await run({ contains: "blog post" });
    expect(result).toMatchObject({
      commands: [{ name: "page.create" }, { name: "page.get" }],
    });
  });

  test("an unknown name is unknown_command_name with a suggestion", async () => {
    const error = await run({ fields: "page.gte" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code: "unknown_command_name", hint: 'Did you mean "page.get"?' });
  });
});

describe("agent contract", () => {
  test("lists exit codes and global flags as a flag-to-description map", async () => {
    const result = await agentContract.run(context(), { args: {}, rest: [], flags: {} });
    expect(result).toMatchObject({
      agentContractVersion: 1,
      exitCodes: { "0": "ok", "4": "failed assertion" },
      globalFlags: {
        "--full": expect.any(String),
        "--fields <a,b.c>": expect.any(String),
        "--help | -h": expect.any(String),
      },
    });
  });
});
