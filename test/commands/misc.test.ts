import { beforeEach, describe, expect, test } from "bun:test";
import { miscCommands } from "../../src/commands/misc.ts";
import { CommandRegistry, defineCommand } from "../../src/core/cli.ts";
import { AtlError } from "../../src/core/errors.ts";
import { Type } from "../../src/core/schema.ts";
import { makeContext } from "../helpers/context.ts";

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
  return spec.run({ ...makeContext({}), registry }, { args: { ref }, rest: [], flags });
}

describe("get", () => {
  test("a legacy /display/ link goes to page.get, which resolves the title", async () => {
    const url = "https://acme.atlassian.net/wiki/display/ENG/My+Title";
    expect(await get(url, { format: "storage" })).toEqual({ from: "page.get" });
    expect(seen).toEqual([
      { command: "page.get", args: { page: url }, flags: { format: "storage" } },
    ]);
  });

  test("a viewer or tiny link goes to page.get, which probes page then blog post", async () => {
    const viewer = "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=555";
    const tiny = "https://acme.atlassian.net/wiki/x/Fc1bBw";
    await get(viewer);
    await get(tiny);
    expect(seen.map((call) => call.command)).toEqual(["page.get", "page.get"]);
  });

  test("an inline-comment link passes no kind, so comment.get can try both", async () => {
    const url = "https://acme.atlassian.net/wiki/spaces/ENG/pages/123/T?focusedCommentId=789";
    await get(url);
    expect(seen).toEqual([{ command: "comment.get", args: { comment: url }, flags: {} }]);
  });

  test("references wrapped in angle brackets, markdown links or brackets are accepted", async () => {
    await get("<https://acme.atlassian.net/wiki/spaces/ENG/pages/123/T>");
    await get("[KAN-1]");
    await get("KAN-2:");
    expect(seen.map((call) => call.command)).toEqual(["page.get", "issue.get", "issue.get"]);
  });

  test("a wrapped reference that is not a reference stays an input error", async () => {
    try {
      await get("<hello>");
    } catch (error) {
      expect(error instanceof AtlError && error.category).toBe("input");
      return;
    }
    throw new Error("expected rejection");
  });
});
