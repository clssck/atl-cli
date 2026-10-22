import type { Static, TObject } from "./schema.ts";
import { VERSION } from "../version.ts";
import { AtlError, toAtlError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { firstIssue } from "./validate.ts";
import {
  formatJson,
  isPretty,
  project,
  prune,
  sourceMarkdown,
  splitList,
  writeDiagnostic,
  writeStderr,
  writeStdout,
  type Writer,
} from "./output.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SideEffects = "none" | "write" | "local";

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Only the last argument may be variadic; its values arrive in `input.rest`. */
  variadic?: boolean;
}

/** Global flags, available on every command context. */
export interface GlobalOptions {
  /** Dotted-path projection from `--fields`; undefined when not given. */
  fields: string[] | undefined;
  /** Commands return raw API objects instead of compact shapes. */
  full: boolean;
  /** `--output PATH`: write the result `body`/`description` (or the JSON) to a file. */
  output: string | undefined;
  /** `--site`, passed through; resolved by later layers. */
  site: string | undefined;
  /** `--plan` / `--dry-run`: describe the request instead of sending it. */
  plan: boolean;
  pretty: boolean;
}

export interface CommandContext extends GlobalOptions {
  env: NodeJS.ProcessEnv;
  registry: CommandRegistry;
  /** The invocation's argv (after `atl`), used to build `next` hints that re-run it. */
  argv: readonly string[];
}

export interface CommandInput<S extends TObject = TObject> {
  /** Non-variadic positionals by declared name. */
  args: Readonly<Record<string, string>>;
  /** Values of the variadic positional, empty when none. */
  rest: readonly string[];
  flags: Static<S>;
}

export interface CommandSpec<S extends TObject = TObject> {
  /** Dotted name: `page.get` is invoked as `atl page get`; `cql` as `atl cql`. */
  name: string;
  summary: string;
  args: readonly ArgSpec[];
  /** Flag schema. Property `replyTo` is the CLI flag `--reply-to`. */
  flags: S;
  sideEffects: SideEffects;
  examples: readonly string[];
  /** Atlassian MCP v1 tools this command replaces (parity map; see mcp/tools-v1.json). */
  mcpTools?: readonly string[];
  /** The returned value is printed as the single JSON stdout value. */
  run(ctx: CommandContext, input: CommandInput<S>): Promise<unknown>;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** Declare a command; infers `input.flags` from the flag schema. */
export function defineCommand<S extends TObject>(spec: CommandSpec<S>): CommandSpec {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new AtlError(`Invalid command name "${spec.name}"`, {
      code: "invalid_command_definition",
      category: "internal",
    });
  }
  const variadicAt = spec.args.findIndex((arg) => arg.variadic === true);
  if (variadicAt !== -1 && variadicAt !== spec.args.length - 1) {
    throw new AtlError(`Command ${spec.name}: only the last argument may be variadic`, {
      code: "invalid_command_definition",
      category: "internal",
    });
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class CommandRegistry {
  readonly #commands = new Map<string, CommandSpec>();
  readonly #groups = new Map<string, string>();

  register(specs: readonly CommandSpec[]): void {
    for (const spec of specs) {
      if (this.#commands.has(spec.name)) {
        throw new AtlError(`Duplicate command "${spec.name}"`, {
          code: "duplicate_command",
          category: "internal",
        });
      }
      this.#commands.set(spec.name, spec);
    }
  }

  /** Attach a one-line summary to a command group (first name segment). */
  describeGroups(groups: Readonly<Record<string, string>>): void {
    for (const [group, summary] of Object.entries(groups)) {
      this.#groups.set(group, summary);
    }
  }

  all(): CommandSpec[] {
    return [...this.#commands.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): CommandSpec | undefined {
    return this.#commands.get(name);
  }

  groupSummary(group: string): string | undefined {
    return this.#groups.get(group);
  }

  /** True when `words` is a strict prefix of at least one command name. */
  isGroupPrefix(words: readonly string[]): boolean {
    const prefix = `${words.join(".")}.`;
    return [...this.#commands.keys()].some((name) => name.startsWith(prefix));
  }
}

export const registry = new CommandRegistry();

export function registerCommands(specs: readonly CommandSpec[]): void {
  registry.register(specs);
}

export function allCommands(): CommandSpec[] {
  return registry.all();
}

// ---------------------------------------------------------------------------
// Flag introspection
// ---------------------------------------------------------------------------

export type FlagKind = "boolean" | "string" | "integer" | "number";

export interface FlagInfo {
  /** Schema property name. */
  key: string;
  /** CLI spelling without leading dashes, e.g. `reply-to`. */
  flag: string;
  kind: FlagKind;
  /** Repeatable flag backed by an array schema. */
  list: boolean;
  required: boolean;
  description: string | undefined;
  choices: string[] | undefined;
  default: unknown;
}

function kebab(key: string): string {
  return key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function leafKind(schema: unknown): { kind: FlagKind; choices: string[] | undefined } {
  if (!isRecord(schema)) {
    return { kind: "string", choices: undefined };
  }
  const { type } = schema;
  if (type === "boolean" || type === "integer" || type === "number") {
    return { kind: type, choices: undefined };
  }
  if (Array.isArray(schema.anyOf)) {
    const consts = (schema.anyOf as unknown[]).map((member) =>
      isRecord(member) && typeof member.const === "string" ? member.const : undefined,
    );
    if (consts.every((value): value is string => value !== undefined)) {
      return { kind: "string", choices: consts };
    }
  }
  if (typeof schema.const === "string") {
    return { kind: "string", choices: [schema.const] };
  }
  return { kind: "string", choices: undefined };
}

export function describeFlags(schema: TObject): FlagInfo[] {
  const required = new Set<string>(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, property]): FlagInfo => {
    const record: Record<string, unknown> = isRecord(property) ? property : {};
    const list = record.type === "array";
    const { kind, choices } = leafKind(list ? record.items : record);
    return {
      key,
      flag: kebab(key),
      kind,
      list,
      required: required.has(key),
      description: typeof record.description === "string" ? record.description : undefined,
      choices,
      default: record.default,
    };
  });
}

/** `[--limit <integer>] [--all]` style placeholder for one flag. */
function flagLabel(info: FlagInfo): string {
  if (info.kind === "boolean") {
    return `--${info.flag}`;
  }
  const value = info.choices === undefined ? info.kind : info.choices.join("|");
  return `--${info.flag} <${value}>${info.list ? "..." : ""}`;
}

export function commandWords(name: string): string[] {
  return name.split(".");
}

/** `atl page get <id> [--format <md|adf>] [flags]` */
export function usageOf(spec: CommandSpec): string {
  const args = spec.args.map((arg) => {
    const label = arg.variadic === true ? `${arg.name}...` : arg.name;
    return arg.required === true ? `<${label}>` : `[${label}]`;
  });
  const flags = describeFlags(spec.flags).map((info) =>
    info.required ? flagLabel(info) : `[${flagLabel(info)}]`,
  );
  return ["atl", ...commandWords(spec.name), ...args, ...flags].join(" ");
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Closest candidate within a length-scaled edit distance, or undefined. */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const limit = Math.max(2, Math.floor(input.length / 3));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

// ---------------------------------------------------------------------------
// Global flags
// ---------------------------------------------------------------------------

interface GlobalFlagDef {
  name: string;
  /** Value placeholder for flags that take one. */
  value?: string;
  short?: string;
  description: string;
}

export const GLOBAL_FLAGS: readonly GlobalFlagDef[] = [
  {
    name: "fields",
    value: "a,b.c",
    description: "Project output to dotted paths (applied per item when the result has `items`)",
  },
  { name: "full", description: "Return raw API objects instead of compact shapes" },
  {
    name: "output",
    value: "PATH",
    description:
      "Write the result `body` or `description` text to PATH and print the rest of the result with {path, bytes, lines} in its place; results without that text are written as JSON and print {path, bytes}",
  },
  {
    name: "site",
    value: "SITE",
    description: "Atlassian site host or name (default: configured default site)",
  },
  { name: "plan", description: "Print the exact request for a write instead of sending it" },
  { name: "dry-run", description: "Alias for --plan" },
  { name: "json", description: "Accepted no-op; output is always JSON" },
  { name: "pretty", description: "Indent JSON with 2 spaces (or set ATL_PRETTY=1)" },
  { name: "help", short: "h", description: "Show help for the command or group" },
  { name: "version", short: "V", description: "Print the version" },
];

export const EXIT_CODE_HELP: Readonly<Record<string, string>> = {
  "0": "ok",
  "1": "input, config, or auth error",
  "2": "API or internal error",
  "3": "transient (429/5xx/timeout/409): reads are safe to retry; after a write error `write_outcome_unknown` read back first, the request may have been applied",
  "4": "failed assertion",
};

const GLOBAL_BY_NAME = new Map(GLOBAL_FLAGS.map((def) => [def.name, def]));

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export type Invocation =
  | { kind: "version" }
  | { kind: "help"; text: string }
  | { kind: "run"; command: CommandSpec; globals: GlobalOptions; input: CommandInput };

function commandError(spec: CommandSpec, message: string, code: string): AtlError {
  return new AtlError(message, {
    code,
    category: "input",
    hint: `Usage: ${usageOf(spec)}`,
    next: [["atl", "commands", "run", "--fields", spec.name]],
  });
}

function coerce(spec: CommandSpec, info: FlagInfo, raw: string): string | number | boolean {
  const label = `--${info.flag}`;
  if (info.kind === "boolean") {
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    throw commandError(
      spec,
      `${label} is a boolean flag; use ${label} or ${label}=false, got "${raw}"`,
      "invalid_flag_value",
    );
  }
  if (info.kind === "integer") {
    if (!/^[+-]?\d+$/.test(raw)) {
      throw commandError(spec, `${label} expects an integer, got "${raw}"`, "invalid_flag_value");
    }
    return Number(raw);
  }
  if (info.kind === "number") {
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) {
      throw commandError(spec, `${label} expects a number, got "${raw}"`, "invalid_flag_value");
    }
    return value;
  }
  return raw;
}

interface ConsumedTokens {
  globals: GlobalOptions;
  flags: Record<string, unknown>;
  positionals: string[];
}

function consumeTokens(
  spec: CommandSpec,
  tokens: readonly string[],
  skip: ReadonlySet<number>,
  env: NodeJS.ProcessEnv,
): ConsumedTokens {
  const own = new Map(describeFlags(spec.flags).map((info) => [info.flag, info]));
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  const globals: GlobalOptions = {
    fields: undefined,
    full: false,
    output: undefined,
    site: undefined,
    plan: false,
    pretty: false,
  };
  let pretty = false;

  for (let i = 0; i < tokens.length; i++) {
    if (skip.has(i)) {
      continue;
    }
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1).filter((_, offset) => !skip.has(i + 1 + offset)));
      break;
    }
    if (token === "-h" || token === "-V") {
      continue;
    }
    if (!token.startsWith("--")) {
      if (/^-[A-Za-z]/.test(token)) {
        throw commandError(
          spec,
          `Unknown flag ${token}; short flags are not supported`,
          "unknown_flag",
        );
      }
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const takeValue = (label: string): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = tokens[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw commandError(spec, `${label} needs a value`, "missing_flag_value");
      }
      i++;
      return next;
    };

    const info = own.get(name);
    if (info !== undefined) {
      if (info.kind === "boolean" && info.list) {
        throw commandError(
          spec,
          `--${name}: arrays of booleans are not supported`,
          "invalid_flag_value",
        );
      }
      const raw = info.kind === "boolean" ? (inline ?? "true") : takeValue(`--${name}`);
      const value = coerce(spec, info, raw);
      if (info.list) {
        const existing = flags[info.key];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          flags[info.key] = [value];
        }
      } else if (Object.hasOwn(flags, info.key)) {
        throw commandError(spec, `--${name} was given more than once`, "duplicate_flag");
      } else {
        flags[info.key] = value;
      }
      continue;
    }

    const global = GLOBAL_BY_NAME.get(name);
    if (global === undefined) {
      const suggestion = closestMatch(name, [...own.keys(), ...GLOBAL_BY_NAME.keys()]);
      throw commandError(
        spec,
        `Unknown flag --${name}${suggestion === undefined ? "" : `; did you mean --${suggestion}?`}`,
        "unknown_flag",
      );
    }
    switch (global.name) {
      case "fields": {
        const parsed = splitList(takeValue("--fields"));
        if (parsed.length === 0) {
          throw commandError(spec, "--fields needs at least one field path", "invalid_flag_value");
        }
        globals.fields = parsed;
        break;
      }
      case "output":
        globals.output = takeValue("--output");
        break;
      case "site":
        globals.site = takeValue("--site");
        break;
      case "full":
        globals.full = coerce(spec, { ...BOOLEAN_INFO, flag: name }, inline ?? "true") === true;
        break;
      case "plan":
      case "dry-run":
        globals.plan = coerce(spec, { ...BOOLEAN_INFO, flag: name }, inline ?? "true") === true;
        break;
      case "pretty":
        pretty = coerce(spec, { ...BOOLEAN_INFO, flag: name }, inline ?? "true") === true;
        break;
      default:
        break;
    }
  }
  globals.pretty = isPretty(pretty, env);
  return { globals, flags, positionals };
}

const BOOLEAN_INFO: FlagInfo = {
  key: "",
  flag: "",
  kind: "boolean",
  list: false,
  required: false,
  description: undefined,
  choices: undefined,
  default: undefined,
};

function buildInput(spec: CommandSpec, consumed: ConsumedTokens): CommandInput {
  const { flags, positionals } = consumed;
  const args: Record<string, string> = {};
  let rest: string[] = [];
  let index = 0;
  for (const arg of spec.args) {
    if (arg.variadic === true) {
      rest = positionals.slice(index);
      index = positionals.length;
      if (arg.required === true && rest.length === 0) {
        throw commandError(spec, `Missing required argument <${arg.name}...>`, "missing_argument");
      }
      continue;
    }
    const value = positionals[index];
    if (value === undefined) {
      if (arg.required === true) {
        throw commandError(spec, `Missing required argument <${arg.name}>`, "missing_argument");
      }
    } else {
      args[arg.name] = value;
    }
    index++;
  }
  const extra = positionals[index];
  if (extra !== undefined) {
    throw commandError(spec, `Unexpected argument "${extra}"`, "unexpected_argument");
  }

  for (const info of describeFlags(spec.flags)) {
    if (Object.hasOwn(flags, info.key)) {
      continue;
    }
    if (info.default !== undefined) {
      flags[info.key] = info.default;
    } else if (info.kind === "boolean" && !info.list && info.required) {
      flags[info.key] = false;
    }
  }
  const issue = firstIssue(spec.flags, flags);
  if (issue !== undefined) {
    if (issue.keyword === "required") {
      const missing = issue.missing ?? [];
      throw commandError(
        spec,
        `Missing required flag${missing.length === 1 ? "" : "s"}: ${missing.map((key) => `--${kebab(key)}`).join(", ")}`,
        "missing_flag",
      );
    }
    const key = issue.path.split("/")[1];
    const target = key === undefined || key === "" ? "flags" : `--${kebab(key)}`;
    const choices = describeFlags(spec.flags).find((info) => info.key === key)?.choices;
    throw commandError(
      spec,
      choices === undefined
        ? `Invalid value for ${target}: ${issue.message}`
        : `${target} must be one of: ${choices.join(", ")}`,
      "invalid_flag_value",
    );
  }
  return { args, rest, flags };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function columns(rows: readonly (readonly [string, string])[], indent = "  "): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`.trimEnd());
}

export function renderTopHelp(reg: CommandRegistry): string {
  const rows = new Map<string, string>();
  for (const spec of reg.all()) {
    const [group = spec.name, ...subs] = commandWords(spec.name);
    if (subs.length === 0) {
      rows.set(group, spec.summary);
    } else if (!rows.has(group)) {
      const names = reg
        .all()
        .filter((other) => other.name.startsWith(`${group}.`))
        .map((other) => other.name.slice(group.length + 1).replaceAll(".", " "));
      rows.set(group, reg.groupSummary(group) ?? `Subcommands: ${names.join(", ")}`);
    }
  }
  const commandRows = [...rows.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  const globalRows = GLOBAL_FLAGS.map((def): [string, string] => {
    const names = [`--${def.name}${def.value === undefined ? "" : ` <${def.value}>`}`];
    if (def.short !== undefined) {
      names.push(`-${def.short}`);
    }
    return [names.join(", "), def.description];
  });
  return [
    `atl ${VERSION} - JSON CLI for Confluence and Jira Cloud`,
    "",
    "Usage:",
    "  atl <command> [args] [flags]",
    "  atl <group> --help         list a group's commands",
    "  atl <command> --help       show usage, args, flags, examples",
    "",
    "stdout is exactly one JSON value; diagnostics are JSONL on stderr.",
    "",
    "Commands:",
    ...columns(commandRows),
    "",
    "Global flags:",
    ...columns(globalRows),
    "",
    "Exit codes:",
    ...columns(Object.entries(EXIT_CODE_HELP)),
    "",
  ].join("\n");
}

export function renderGroupHelp(reg: CommandRegistry, words: readonly string[]): string {
  const group = words.join(".");
  const rows = reg
    .all()
    .filter((spec) => spec.name.startsWith(`${group}.`))
    .map((spec): [string, string] => [
      commandWords(spec.name).slice(words.length).join(" "),
      spec.summary,
    ]);
  const summary = reg.groupSummary(group);
  return [
    `atl ${words.join(" ")}${summary === undefined ? "" : ` - ${summary}`}`,
    "",
    "Commands:",
    ...columns(rows),
    "",
    `Run \`atl ${words.join(" ")} <command> --help\` for usage.`,
    "",
  ].join("\n");
}

export function renderCommandHelp(spec: CommandSpec): string {
  const lines = [usageOf(spec), "", spec.summary, ""];
  if (spec.args.length > 0) {
    lines.push(
      "Arguments:",
      ...columns(
        spec.args.map((arg): [string, string] => [
          arg.variadic === true ? `${arg.name}...` : arg.name,
          `${arg.required === true ? "(required) " : ""}${arg.description}`,
        ]),
      ),
      "",
    );
  }
  const flags = describeFlags(spec.flags);
  if (flags.length > 0) {
    lines.push(
      "Flags:",
      ...columns(
        flags.map((info): [string, string] => {
          const notes = [
            info.required ? "(required)" : undefined,
            info.description,
            info.default === undefined ? undefined : `(default: ${JSON.stringify(info.default)})`,
          ].filter((part): part is string => part !== undefined);
          return [flagLabel(info), notes.join(" ")];
        }),
      ),
      "",
    );
  }
  lines.push(`Side effects: ${spec.sideEffects}`, "");
  if (spec.examples.length > 0) {
    lines.push("Examples:", ...spec.examples.map((example) => `  ${example}`), "");
  }
  lines.push(
    "Global flags (--fields, --full, --output, --site, --plan, --pretty): see `atl --help`.",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Invocation parsing
// ---------------------------------------------------------------------------

function unknownCommand(
  reg: CommandRegistry,
  words: readonly string[],
  following: readonly string[],
): AtlError {
  const typedWords = [...words];
  for (const token of following) {
    if (token.startsWith("-")) {
      break;
    }
    typedWords.push(token);
  }
  const names = reg.all().map((spec) => commandWords(spec.name).join(" "));

  let suggestion: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const typed = typedWords.slice(0, name.split(" ").length).join(" ").toLowerCase();
    const distance = editDistance(typed, name.toLowerCase());
    if (distance < bestDistance && distance <= Math.max(2, Math.floor(typed.length / 3))) {
      suggestion = name;
      bestDistance = distance;
    }
  }

  const group = words[0];
  const siblings =
    group === undefined || !reg.isGroupPrefix([group])
      ? []
      : names.filter((name) => name.startsWith(`${group} `));
  const hint =
    suggestion !== undefined
      ? `Did you mean "atl ${suggestion}"?`
      : siblings.length > 0
        ? `Commands in "${group}": ${siblings.map((name) => name.slice(`${group} `.length)).join(", ")}. See \`atl ${group} --help\`.`
        : "Run `atl --help` for the command list or `atl commands run` for the registry.";
  const next =
    suggestion !== undefined
      ? [["atl", "commands", "run", "--fields", suggestion.replaceAll(" ", ".")]]
      : [["atl", "commands", "run"]];
  return new AtlError(
    `Unknown command "${typedWords.slice(0, Math.max(words.length, 2)).join(" ")}"`,
    {
      code: "unknown_command",
      category: "input",
      hint,
      next,
    },
  );
}

/**
 * Resolve argv to a help/version/run outcome. Global flags may appear before or after the
 * command words; a command that declares a flag with a global's name owns that flag (`--version`
 * included, e.g. `page get --version 3`; `-V` always prints the CLI version).
 */
export function parseArgv(
  argv: readonly string[],
  reg: CommandRegistry = registry,
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  const dashDash = argv.indexOf("--");
  const flagTokens = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const wantsHelp = flagTokens.includes("--help") || flagTokens.includes("-h");
  const wantsVersion =
    !wantsHelp && (flagTokens.includes("--version") || flagTokens.includes("-V"));
  if (wantsVersion && flagTokens.includes("-V")) {
    return { kind: "version" };
  }

  const words: string[] = [];
  const wordIndexes = new Set<number>();
  let command: CommandSpec | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      break;
    }
    if (token.startsWith("-")) {
      const name = token.startsWith("--") ? token.slice(2) : "";
      if (!token.includes("=") && GLOBAL_BY_NAME.get(name)?.value !== undefined) {
        i++;
      }
      continue;
    }
    words.push(token);
    wordIndexes.add(i);
    command = reg.get(words.join("."));
    if (command !== undefined) {
      break;
    }
    if (!reg.isGroupPrefix(words)) {
      if (wantsVersion) {
        return { kind: "version" };
      }
      throw unknownCommand(reg, words, argv.slice(i + 1, dashDash === -1 ? undefined : dashDash));
    }
  }

  if (
    wantsVersion &&
    (command === undefined || !describeFlags(command.flags).some((info) => info.flag === "version"))
  ) {
    return { kind: "version" };
  }
  if (command === undefined) {
    return {
      kind: "help",
      text: words.length === 0 ? renderTopHelp(reg) : renderGroupHelp(reg, words),
    };
  }
  if (wantsHelp) {
    return { kind: "help", text: renderCommandHelp(command) };
  }

  const consumed = consumeTokens(command, argv, wordIndexes, env);
  const input = buildInput(command, consumed);
  return { kind: "run", command, globals: consumed.globals, input };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface CliIo {
  stdout: Writer;
  stderr: Writer;
  env: NodeJS.ProcessEnv;
  registry: CommandRegistry;
}

/** Result fields whose text `--output` moves to the file, in priority order. */
const OUTPUT_TEXT_FIELDS = ["body", "description"] as const;

function countLines(text: string): number {
  if (text === "") {
    return 0;
  }
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * A markdown body: a string, or the array of display lines compact output uses. Arrays resolve to
 * the exact source markdown (`sourceMarkdown`), never the re-joined lines: wrapped or hard-split
 * table rows and code would otherwise be corrupted on an `--output` -> edit -> update round trip.
 */
function outputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((line) => typeof line === "string")
  ) {
    return undefined;
  }
  return sourceMarkdown(value) ?? value.join("\n");
}

/**
 * `--output PATH`: a `body` (pages, comments) or `description` (issues) given as a string or an
 * array of markdown lines goes to the file as markdown and is replaced in the printed result by
 * `{path, bytes, lines}`, so ids, titles and status stay visible. Results without such a field are
 * written as JSON and print `{path, bytes}`.
 */
async function writeOutputFile(path: string, result: unknown, pretty: boolean): Promise<unknown> {
  const field = isRecord(result)
    ? OUTPUT_TEXT_FIELDS.find((name) => outputText(result[name]) !== undefined)
    : undefined;
  const text = isRecord(result) && field !== undefined ? outputText(result[field]) : undefined;
  const content = text ?? `${formatJson(result, pretty)}\n`;
  let bytes: number;
  try {
    bytes = await Bun.write(path, content);
  } catch (error) {
    throw new AtlError(
      `Cannot write --output file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "output_write_failed",
        category: "input",
        hint: "Check that the path is writable.",
        cause: error,
      },
    );
  }
  if (text === undefined || !isRecord(result)) {
    return { path, bytes };
  }
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) =>
      key === field ? [key, { path, bytes, lines: countLines(text) }] : [key, value],
    ),
  );
}

/** Run the CLI; returns the process exit code. Never throws. */
export async function runCli(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  const out = io.stdout ?? writeStdout;
  const err = io.stderr ?? writeStderr;
  const env = io.env ?? process.env;
  const reg = io.registry ?? registry;
  try {
    const invocation = parseArgv(argv, reg, env);
    if (invocation.kind === "version") {
      out(`atl ${VERSION}\n`);
      return 0;
    }
    if (invocation.kind === "help") {
      out(invocation.text);
      return 0;
    }
    const { command, globals, input } = invocation;
    const result = await command.run({ ...globals, env, registry: reg, argv }, input);
    const ownsFields = describeFlags(command.flags).some((info) => info.flag === "fields");
    const selected =
      globals.fields !== undefined && !ownsFields
        ? project(result, globals.fields, (paths) =>
            writeDiagnostic(
              {
                type: "warning",
                code: "fields_unmatched",
                paths,
                hint: "No result field matched these --fields paths; list items are addressed per item (key, not items.key). Rerun without --fields to see the shape.",
              },
              err,
            ),
          )
        : result;
    const projected = globals.full ? selected : prune(selected);
    const printed =
      globals.output === undefined
        ? projected
        : await writeOutputFile(globals.output, projected, globals.pretty);
    out(`${formatJson(printed, globals.pretty)}\n`);
    return 0;
  } catch (error) {
    const atlError = toAtlError(error);
    writeDiagnostic(atlError.toDiagnostic(), err);
    return atlError.exitCode;
  }
}
