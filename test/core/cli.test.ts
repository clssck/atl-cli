import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyLines } from "../../src/commands/common.ts";
import { Type } from "../../src/core/schema.ts";
import {
  CommandRegistry,
  defineCommand,
  parseArgv,
  runCli,
  type CommandInput,
  type Invocation,
} from "../../src/core/cli.ts";
import { AtlError } from "../../src/core/errors.ts";

const sample = defineCommand({
  name: "thing.get",
  summary: "Get a thing",
  args: [
    { name: "id", description: "Thing id", required: true },
    { name: "extra", description: "Optional second" },
  ],
  flags: Type.Object({
    limit: Type.Optional(Type.Integer({ description: "Max items" })),
    ratio: Type.Optional(Type.Number()),
    title: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    all: Type.Boolean({ default: false }),
    set: Type.Optional(Type.Array(Type.String())),
    format: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("adf")])),
  }),
  sideEffects: "none",
  examples: ["atl thing get 1"],
  run(_ctx, input) {
    return Promise.resolve({ id: input.args.id, flags: input.flags });
  },
});

const needsFlag = defineCommand({
  name: "thing.make",
  summary: "Make a thing",
  args: [{ name: "names", description: "Names", required: true, variadic: true }],
  flags: Type.Object({ space: Type.String() }),
  sideEffects: "write",
  examples: [],
  run(_ctx, input) {
    return Promise.resolve({ names: input.rest, space: input.flags.space });
  },
});

const echoItems = defineCommand({
  name: "echo",
  summary: "Echo items",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run(ctx) {
    return Promise.resolve({
      items: [
        { id: 1, fields: { a: "x", b: "y" } },
        { id: 2, fields: { a: "z", b: "w" } },
      ],
      nextCursor: null,
      ctx: { site: ctx.site, plan: ctx.plan, full: ctx.full },
    });
  },
});

const bodyCommand = defineCommand({
  name: "page.body",
  summary: "Return a body",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run() {
    return Promise.resolve({ id: "1", body: "# hello\n" });
  },
});

const bodyLinesCommand = defineCommand({
  name: "page.lines",
  summary: "Return a body as markdown lines",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run() {
    return Promise.resolve({
      id: "1",
      body: ["# hello", "", "first line", "", "```", "code", "```"],
    });
  },
});

/** A table row and a code line over the line budget, plus long prose: `bodyLines` splits all three. */
const WIDE_MARKDOWN = [
  "# Wide",
  "",
  "| key | value |",
  "| --- | --- |",
  `| retention | ${"x".repeat(800)} |`,
  "",
  "```",
  `const payload = "${"y".repeat(800)}";`,
  "```",
  "",
  "word ".repeat(300).trim(),
].join("\n");

const wideBodyCommand = defineCommand({
  name: "page.wide",
  summary: "Return a body whose lines need wrapping",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run() {
    return Promise.resolve({ id: "1", title: "Wide", body: bodyLines(WIDE_MARKDOWN) });
  },
});

const descriptionLinesCommand = defineCommand({
  name: "issue.lines",
  summary: "Return a description as markdown lines",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run() {
    return Promise.resolve({ key: "K-1", description: ["one", "two"] });
  },
});

const descriptionCommand = defineCommand({
  name: "issue.show",
  summary: "Return a description",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run() {
    return Promise.resolve({ key: "K-1", description: "one\ntwo\nthree", status: "Open" });
  },
});

const bigListCommand = defineCommand({
  name: "big.list",
  summary: "Return a list wider than one stdout line",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [],
  run() {
    return Promise.resolve({
      items: Array.from({ length: 30 }, (_, index) => ({ id: index, title: "x".repeat(40) })),
    });
  },
});

const ownFields = defineCommand({
  name: "own.fields",
  summary: "Owns --fields",
  args: [],
  flags: Type.Object({
    fields: Type.Optional(Type.String()),
    version: Type.Optional(Type.Integer()),
  }),
  sideEffects: "none",
  examples: [],
  run(_ctx, input) {
    return Promise.resolve({ got: input.flags.fields, other: 1 });
  },
});

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register([
    sample,
    needsFlag,
    echoItems,
    bodyCommand,
    bodyLinesCommand,
    wideBodyCommand,
    descriptionLinesCommand,
    ownFields,
    descriptionCommand,
    bigListCommand,
  ]);
  return registry;
}

function parseRun(argv: string[]): Extract<Invocation, { kind: "run" }> {
  const result = parseArgv(argv, makeRegistry(), {});
  if (result.kind !== "run") {
    throw new Error(`expected run, got ${result.kind}`);
  }
  return result;
}

function parseError(argv: string[]): AtlError {
  try {
    parseArgv(argv, makeRegistry(), {});
  } catch (error) {
    if (error instanceof AtlError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parse to throw");
}

function flagsOf(argv: string[]): CommandInput["flags"] {
  return parseRun(argv).input.flags;
}

describe("parseArgv flags", () => {
  test("space and equals forms", () => {
    expect(flagsOf(["thing", "get", "1", "--title", "a b"])).toEqual({ title: "a b", all: false });
    expect(flagsOf(["thing", "get", "1", "--title=a=b"])).toEqual({ title: "a=b", all: false });
  });

  test("camelCase schema keys are kebab-case flags", () => {
    expect(flagsOf(["thing", "get", "1", "--reply-to", "9"])).toEqual({ replyTo: "9", all: false });
  });

  test("boolean flags, with explicit =false, and schema default", () => {
    expect(flagsOf(["thing", "get", "1", "--all"])).toEqual({ all: true });
    expect(flagsOf(["thing", "get", "1", "--all=false"])).toEqual({ all: false });
    expect(flagsOf(["thing", "get", "1"])).toEqual({ all: false });
  });

  test("repeated flags build arrays", () => {
    expect(flagsOf(["thing", "get", "1", "--set", "k=v", "--set=k2=v2"])).toEqual({
      set: ["k=v", "k2=v2"],
      all: false,
    });
  });

  test("integer and number coercion", () => {
    expect(flagsOf(["thing", "get", "1", "--limit", "25", "--ratio=1.5"])).toEqual({
      limit: 25,
      ratio: 1.5,
      all: false,
    });
  });

  test("bad integer is an input error naming the usage", () => {
    const error = parseError(["thing", "get", "1", "--limit", "abc"]);
    expect(error.category).toBe("input");
    expect(error.message).toContain("--limit expects an integer");
    expect(error.hint).toContain("atl thing get <id>");
    expect(error.next).toEqual([["atl", "commands", "run", "--fields", "thing.get"]]);
    expect(parseError(["thing", "get", "1", "--limit", "1.5"]).code).toBe("invalid_flag_value");
  });

  test("enum values are validated against the schema", () => {
    expect(flagsOf(["thing", "get", "1", "--format", "adf"])).toMatchObject({ format: "adf" });
    const error = parseError(["thing", "get", "1", "--format", "html"]);
    expect(error.code).toBe("invalid_flag_value");
    expect(error.message).toContain("--format");
  });

  test("a bad choice names the allowed values", () => {
    const error = parseError(["thing", "get", "1", "--format", "html"]);
    expect(error.category).toBe("input");
    expect(error.code).toBe("invalid_flag_value");
    expect(error.message).toBe("--format must be one of: md, adf");
  });

  test("unknown flag suggests the closest one", () => {
    const error = parseError(["thing", "get", "1", "--limt", "5"]);
    expect(error.code).toBe("unknown_flag");
    expect(error.category).toBe("input");
    expect(error.message).toContain("did you mean --limit");
    expect(error.next).toEqual([["atl", "commands", "run", "--fields", "thing.get"]]);
  });

  test("flag without a value, and duplicate scalar flag, are errors", () => {
    expect(parseError(["thing", "get", "1", "--title"]).code).toBe("missing_flag_value");
    expect(parseError(["thing", "get", "1", "--title", "--all"]).code).toBe("missing_flag_value");
    expect(parseError(["thing", "get", "1", "--title", "a", "--title", "b"]).code).toBe(
      "duplicate_flag",
    );
  });

  test("-- ends flag parsing", () => {
    const run = parseRun(["thing", "get", "--", "--not-a-flag"]);
    expect(run.input.args.id).toBe("--not-a-flag");
  });

  test("required flag missing is an error listing it", () => {
    const error = parseError(["thing", "make", "a"]);
    expect(error.code).toBe("missing_flag");
    expect(error.message).toContain("--space");
  });
});

describe("parseArgv positionals and commands", () => {
  test("named and variadic positionals", () => {
    expect(parseRun(["thing", "get", "7", "8"]).input.args).toEqual({ id: "7", extra: "8" });
    const make = parseRun(["thing", "make", "a", "b", "--space", "X", "c"]);
    expect(make.input.rest).toEqual(["a", "b", "c"]);
  });

  test("missing required argument and extra argument", () => {
    expect(parseError(["thing", "get"]).code).toBe("missing_argument");
    expect(parseError(["thing", "get", "1", "2", "3"]).code).toBe("unexpected_argument");
    expect(parseError(["thing", "make", "--space", "X"]).code).toBe("missing_argument");
  });

  test("unknown command suggests the closest match", () => {
    const error = parseError(["thng", "get"]);
    expect(error.code).toBe("unknown_command");
    expect(error.category).toBe("input");
    expect(error.hint).toBe('Did you mean "atl thing get"?');
    expect(error.next).toEqual([["atl", "commands", "run", "--fields", "thing.get"]]);
  });

  test("unknown subcommand lists the group's commands", () => {
    const error = parseError(["thing", "zzzzzzzzzz"]);
    expect(error.hint).toContain("get, make");
  });

  test("single-word command and group-only invocation", () => {
    expect(parseRun(["echo"]).command.name).toBe("echo");
    const group = parseArgv(["thing"], makeRegistry(), {});
    expect(group.kind).toBe("help");
  });
});

describe("global flags", () => {
  test("parse before and after command words", () => {
    const before = parseRun(["--site", "acme", "--plan", "echo"]);
    expect(before.globals).toMatchObject({ site: "acme", plan: true });
    const after = parseRun([
      "echo",
      "--site=acme",
      "--dry-run",
      "--full",
      "--json",
      "--fields",
      "id, fields.a",
    ]);
    expect(after.globals).toMatchObject({
      site: "acme",
      plan: true,
      full: true,
      fields: ["id", "fields.a"],
    });
  });

  test("pretty comes from --pretty or ATL_PRETTY", () => {
    expect(parseArgv(["echo", "--pretty"], makeRegistry(), {})).toMatchObject({
      globals: { pretty: true },
    });
    expect(parseArgv(["echo"], makeRegistry(), { ATL_PRETTY: "1" })).toMatchObject({
      globals: { pretty: true },
    });
    expect(parseArgv(["echo"], makeRegistry(), {})).toMatchObject({ globals: { pretty: false } });
  });

  test("a command declaring a global's name owns that flag", () => {
    const run = parseRun(["own", "fields", "--fields", "a,b"]);
    expect(run.input.flags).toEqual({ fields: "a,b" });
    expect(run.globals.fields).toBeUndefined();
  });

  test("--help and --version short-circuit", () => {
    expect(parseArgv(["thing", "get", "--help"], makeRegistry(), {})).toMatchObject({
      kind: "help",
    });
    expect(parseArgv(["thing", "get", "-h"], makeRegistry(), {})).toMatchObject({ kind: "help" });
    expect(parseArgv(["--version"], makeRegistry(), {})).toEqual({ kind: "version" });
    expect(parseArgv(["thing", "-V"], makeRegistry(), {})).toEqual({ kind: "version" });
  });

  test("a command declaring `version` owns --version; -V and other commands still print the version", () => {
    const owned = parseArgv(["own", "fields", "--version", "3"], makeRegistry(), {});
    expect(owned).toMatchObject({ kind: "run", input: { flags: { version: 3 } } });
    expect(parseArgv(["own", "fields", "-V"], makeRegistry(), {})).toEqual({ kind: "version" });
    expect(parseArgv(["thing", "get", "1", "--version"], makeRegistry(), {})).toEqual({
      kind: "version",
    });
    expect(parseArgv(["nope", "--version"], makeRegistry(), {})).toEqual({ kind: "version" });
  });

  test("repeated --fields accumulate paths instead of the last one winning", async () => {
    const run = parseRun(["echo", "--fields", "id", "--fields=fields.a,x"]);
    expect(run.globals.fields).toEqual(["id", "fields.a", "x"]);
    const { stdout } = await runAtl(["echo", "--fields", "id", "--fields", "fields.a"]);
    expect(JSON.parse(stdout)).toMatchObject({
      items: [
        { id: 1, fields: { a: "x" } },
        { id: 2, fields: { a: "z" } },
      ],
    });
  });

  test("repeated --site or --output is a duplicate_flag error, not a silent last-wins", () => {
    expect(parseError(["echo", "--site", "a", "--site", "b"]).code).toBe("duplicate_flag");
    expect(parseError(["echo", "--output", "a.md", "--output=b.md"]).code).toBe("duplicate_flag");
  });
});

async function runAtl(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    registry: makeRegistry(),
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("runCli", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atl-cli-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("prints exactly one compact JSON value", async () => {
    const { code, stdout, stderr } = await runAtl(["thing", "get", "5"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe('{"id":"5","flags":{"all":false}}\n');
  });

  test("errors write one JSONL diagnostic to stderr, nothing to stdout, and return the exit code", async () => {
    const { code, stdout, stderr } = await runAtl(["nope"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.endsWith("\n")).toBe(true);
    const lines = stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      type: "error",
      code: "unknown_command",
      exitCode: 1,
    });
  });

  test("a thrown non-AtlError becomes an internal error with exit code 2", async () => {
    const boom = defineCommand({
      name: "boom",
      summary: "Throws",
      args: [],
      flags: Type.Object({}),
      sideEffects: "none",
      examples: [],
      run() {
        return Promise.reject(new Error("kaput"));
      },
    });
    const registry = new CommandRegistry();
    registry.register([boom]);
    let stderr = "";
    const code = await runCli(["boom"], {
      registry,
      env: {},
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({ code: "internal_error", message: "kaput" });
  });

  test("--fields projects each item of an items result", async () => {
    const { stdout } = await runAtl(["echo", "--fields", "id,fields.a"]);
    expect(JSON.parse(stdout)).toEqual({
      items: [
        { id: 1, fields: { a: "x" } },
        { id: 2, fields: { a: "z" } },
      ],
      ctx: { site: undefined, plan: false, full: false },
    });
  });

  test("--fields keeps every item, and warns on stderr about paths that match nothing", async () => {
    const { stdout, stderr, code } = await runAtl(["echo", "--fields", "items.fields.a,nope"]);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(parsed).toMatchObject({ items: [{ fields: { a: "x" } }, { fields: { a: "z" } }] });
    expect(JSON.parse(stderr)).toEqual({
      type: "warning",
      code: "fields_unmatched",
      paths: ["nope"],
      hint: expect.stringContaining("--fields"),
    });
    const none = await runAtl(["echo", "--fields", "nope"]);
    expect(JSON.parse(none.stdout)).toMatchObject({ items: [{}, {}] });
  });

  test("compact output omits null values; --full prints the result as returned", async () => {
    const compact = JSON.parse((await runAtl(["echo"])).stdout);
    expect(compact).not.toHaveProperty("nextCursor");
    const full = JSON.parse((await runAtl(["echo", "--full"])).stdout);
    expect(full).toHaveProperty("nextCursor", null);
  });

  test("global flags reach the command context", async () => {
    const { stdout } = await runAtl([
      "echo",
      "--site",
      "acme",
      "--plan",
      "--full",
      "--fields",
      "ctx",
    ]);
    expect(JSON.parse(stdout)).toEqual({
      nextCursor: null,
      ctx: { site: "acme", plan: true, full: true },
    });
  });

  test("a command that owns --fields is not projected", async () => {
    const { stdout } = await runAtl(["own", "fields", "--fields", "a"]);
    expect(JSON.parse(stdout)).toEqual({ got: "a", other: 1 });
  });

  test("--output moves a string body to the file and keeps the rest of the result", async () => {
    const path = join(dir, "out.md");
    const { code, stdout } = await runAtl(["page", "body", "--output", path]);
    expect(code).toBe(0);
    expect(await readFile(path, "utf8")).toBe("# hello\n");
    expect(JSON.parse(stdout)).toEqual({ id: "1", body: { path, bytes: 8, lines: 1 } });
  });

  test("--output moves a string description to the file when there is no body", async () => {
    const path = join(dir, "issue.md");
    const { stdout } = await runAtl(["issue", "show", "--output", path]);
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree");
    expect(JSON.parse(stdout)).toEqual({
      key: "K-1",
      description: { path, bytes: 13, lines: 3 },
      status: "Open",
    });
  });

  test("--output joins a body given as markdown lines back into the exact markdown", async () => {
    const path = join(dir, "lines.md");
    const markdown = "# hello\n\nfirst line\n\n```\ncode\n```";
    const { stdout } = await runAtl(["page", "lines", "--output", path]);
    expect(await readFile(path, "utf8")).toBe(markdown);
    expect(JSON.parse(stdout)).toEqual({
      id: "1",
      body: { path, bytes: Buffer.byteLength(markdown), lines: 7 },
    });
  });

  test("--output writes the original markdown when display lines were wrapped or split", async () => {
    const { stdout: printed } = await runAtl(["page", "wide"]);
    const display = printed.trimEnd().split("\n");
    expect(Math.max(...display.map((line) => Buffer.byteLength(line)))).toBeLessThanOrEqual(768);
    for (const argv of [
      ["page", "wide"],
      ["page", "wide", "--fields", "id,body"],
    ]) {
      const path = join(dir, `wide-${argv.length}.md`);
      const { stdout } = await runAtl([...argv, "--output", path]);
      expect(await readFile(path, "utf8")).toBe(WIDE_MARKDOWN);
      expect(JSON.parse(stdout)).toMatchObject({ id: "1", body: { path, lines: 11 } });
    }
  });

  test("--output moves a description given as markdown lines to the file", async () => {
    const path = join(dir, "issue-lines.md");
    const { stdout } = await runAtl(["issue", "lines", "--output", path]);
    expect(await readFile(path, "utf8")).toBe("one\ntwo");
    expect(JSON.parse(stdout)).toEqual({
      key: "K-1",
      description: { path, bytes: 7, lines: 2 },
    });
  });

  test("--output writes JSON when there is no text field", async () => {
    const path = join(dir, "nested", "out.json");
    const { stdout } = await runAtl(["thing", "get", "5", "--output", path]);
    const written = await readFile(path, "utf8");
    expect(JSON.parse(written)).toEqual({ id: "5", flags: { all: false } });
    expect(JSON.parse(stdout)).toEqual({ path, bytes: Buffer.byteLength(written) });
  });

  test("--output JSON for a large result is multi-line and parses equal to stdout", async () => {
    const path = join(dir, "big.json");
    const { stdout: printed } = await runAtl(["big", "list"]);
    const { stdout } = await runAtl(["big", "list", "--output", path]);
    const written = await readFile(path, "utf8");
    expect(written.trimEnd().split("\n").length).toBeGreaterThanOrEqual(30);
    expect(JSON.parse(written)).toEqual(JSON.parse(printed));
    expect(JSON.parse(stdout)).toEqual({ path, bytes: Buffer.byteLength(written) });
  });

  test("results wider than a stdout line are broken into lines and still parse", async () => {
    const { stdout } = await runAtl(["big", "list"]);
    expect(stdout.split("\n").length).toBeGreaterThan(30);
    expect(JSON.parse(stdout).items).toHaveLength(30);
  });

  test("--pretty indents; --version and --help are plain text", async () => {
    expect((await runAtl(["thing", "get", "5", "--pretty"])).stdout).toContain('\n  "id": "5"');
    expect((await runAtl(["--version"])).stdout).toBe("atl 0.1.0\n");
    const help = await runAtl(["--help"]);
    expect(help.stdout).toContain("Exit codes:");
    expect(help.stdout).not.toContain("\u001B[");
  });

  test("command help lists args, flags and examples", async () => {
    const { stdout } = await runAtl(["thing", "get", "--help"]);
    expect(stdout).toContain("atl thing get <id> [extra]");
    expect(stdout).toContain("--limit <integer>");
    expect(stdout).toContain("Max items");
    expect(stdout).toContain("atl thing get 1");
  });
});
