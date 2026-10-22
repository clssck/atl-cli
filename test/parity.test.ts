import { describe, expect, test } from "bun:test";
import { allCommands } from "../src/core/cli.ts";
import { Type } from "../src/core/schema.ts";
import { check } from "../src/core/validate.ts";
import "../src/commands/index.ts";

const ToolsSnapshot = Type.Object({
  tools: Type.Array(Type.Object({ name: Type.String() })),
});

const raw: unknown = await Bun.file(new URL("../mcp/tools-v1.json", import.meta.url)).json();
if (!check(ToolsSnapshot, raw)) {
  throw new Error("mcp/tools-v1.json does not match the expected snapshot shape");
}
const snapshot = raw;

describe("Atlassian MCP v1 parity", () => {
  test("every MCP tool maps to at least one atl command", () => {
    const covered = new Set(allCommands().flatMap((spec) => spec.mcpTools ?? []));
    const missing = snapshot.tools.map((tool) => tool.name).filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  test("every mapped tool name exists in the snapshot", () => {
    const known = new Set(snapshot.tools.map((tool) => tool.name));
    const stale = allCommands()
      .flatMap((spec) => (spec.mcpTools ?? []).map((name) => `${spec.name}:${name}`))
      .filter((entry) => !known.has(entry.split(":")[1] ?? ""));
    expect(stale).toEqual([]);
  });
});
