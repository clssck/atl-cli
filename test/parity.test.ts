import { describe, expect, test } from "bun:test";
import { allCommands } from "../src/core/cli.ts";
import { Type, type Static, type TSchema } from "../src/core/schema.ts";
import { check } from "../src/core/validate.ts";
import "../src/commands/index.ts";

const ToolsSnapshot = Type.Object({
  tools: Type.Array(Type.Object({ name: Type.String() })),
});

const OperationsCatalog = Type.Object({
  operations: Type.Array(Type.Object({ name: Type.String(), product: Type.String() })),
});

const GapsFile = Type.Object({
  outOfScopeProducts: Type.Array(Type.String()),
  hiddenOperations: Type.Array(Type.Object({ name: Type.String(), product: Type.String() })),
  gaps: Type.Array(
    Type.Object({ name: Type.String(), reason: Type.String(), evidence: Type.String() }),
  ),
});

async function load<S extends TSchema>(file: string, schema: S): Promise<Static<S>> {
  const raw: unknown = await Bun.file(new URL(`../mcp/${file}`, import.meta.url)).json();
  if (!check(schema, raw)) {
    throw new Error(`mcp/${file} does not match the expected shape`);
  }
  return raw;
}

const v1 = await load("tools-v1.json", ToolsSnapshot);
const v2Tools = await load("tools-v2.json", ToolsSnapshot);
const v2Operations = await load("operations-v2.json", OperationsCatalog);
const v2Gaps = await load("gaps-v2.json", GapsFile);

const mapped = new Set(allCommands().flatMap((spec) => spec.mcpTools ?? []));
const gapNames = new Set(v2Gaps.gaps.map((gap) => gap.name));
const outOfScope = new Set(v2Gaps.outOfScopeProducts);
const inScopeOperations = [...v2Operations.operations, ...v2Gaps.hiddenOperations].filter(
  (operation) => !outOfScope.has(operation.product),
);

describe("Atlassian MCP v1 parity", () => {
  test("every v1 tool maps to at least one atl command", () => {
    expect(v1.tools.map((tool) => tool.name).filter((name) => !mapped.has(name))).toEqual([]);
  });
});

describe("Atlassian MCP v2 parity (Jira and Confluence)", () => {
  test("every v2 tool maps to a command or is a documented gap", () => {
    const missing = v2Tools.tools
      .map((tool) => tool.name)
      .filter((name) => !mapped.has(name) && !gapNames.has(name));
    expect(missing).toEqual([]);
  });

  test("every in-scope v2 operation maps to a command or is a documented gap", () => {
    const missing = inScopeOperations
      .map((operation) => operation.name)
      .filter((name) => !mapped.has(name) && !gapNames.has(name));
    expect(missing).toEqual([]);
  });

  test("no operation is both mapped and listed as a gap", () => {
    expect([...gapNames].filter((name) => mapped.has(name))).toEqual([]);
  });
});

test("every mapped name exists in a v1 or v2 catalog", () => {
  const known = new Set([
    ...v1.tools.map((tool) => tool.name),
    ...v2Tools.tools.map((tool) => tool.name),
    ...v2Operations.operations.map((operation) => operation.name),
    ...v2Gaps.hiddenOperations.map((operation) => operation.name),
  ]);
  const stale = allCommands().flatMap((spec) =>
    (spec.mcpTools ?? []).filter((name) => !known.has(name)).map((name) => `${spec.name}:${name}`),
  );
  expect(stale).toEqual([]);
});

test("every gap names a catalog entry", () => {
  const known = new Set([
    ...v2Tools.tools.map((tool) => tool.name),
    ...inScopeOperations.map((operation) => operation.name),
  ]);
  expect([...gapNames].filter((name) => !known.has(name))).toEqual([]);
});
