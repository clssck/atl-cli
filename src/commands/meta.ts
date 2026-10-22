import { Type } from "../core/schema.ts";
import {
  closestMatch,
  defineCommand,
  EXIT_CODE_HELP,
  GLOBAL_FLAGS,
  usageOf,
  type CommandSpec,
} from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { splitList } from "../core/output.ts";

export const metaGroups: Readonly<Record<string, string>> = {
  commands: "Discover registered commands",
  agent: "Machine-readable CLI contract for agents",
};

/** Index summaries are cut to the first clause and capped so the whole index stays small. */
const INDEX_SUMMARY_CAP = 40;

function indexSummary(summary: string): string {
  const clause = summary.split(/; | \(|: /)[0] ?? summary;
  if (clause.length <= INDEX_SUMMARY_CAP) {
    return clause;
  }
  const cut = clause.slice(0, INDEX_SUMMARY_CAP - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

/** `{page: {get: "...", create: "..."}, cql: "..."}`: one level of grouping by the dotted name. */
function groupedIndex(registry: readonly CommandSpec[]): Record<string, unknown> {
  const index: Record<string, string | Record<string, string>> = {};
  for (const spec of registry) {
    const [group = spec.name, ...rest] = spec.name.split(".");
    const summary = indexSummary(spec.summary);
    if (rest.length === 0) {
      index[group] = summary;
      continue;
    }
    const existing = index[group];
    const bucket = typeof existing === "object" ? existing : {};
    bucket[rest.join(".")] = summary;
    index[group] = bucket;
  }
  return index;
}

/** Full entry without empty arrays or defaults (`sideEffects: none`, `required: false`). */
function fullEntry(spec: CommandSpec): Record<string, unknown> {
  const hasFlags = Object.keys(spec.flags.properties).length > 0;
  return {
    name: spec.name,
    usage: usageOf(spec),
    summary: spec.summary,
    ...(spec.args.length === 0
      ? {}
      : {
          args: spec.args.map((arg) => ({
            name: arg.name,
            description: arg.description,
            ...(arg.required === true ? { required: true } : {}),
            ...(arg.variadic === true ? { variadic: true } : {}),
          })),
        }),
    ...(hasFlags ? { flags: spec.flags } : {}),
    ...(spec.sideEffects === "none" ? {} : { sideEffects: spec.sideEffects }),
    ...(spec.examples.length === 0 ? {} : { examples: spec.examples }),
    ...(spec.mcpTools === undefined ? {} : { mcpTools: spec.mcpTools }),
  };
}

function matchesContains(spec: CommandSpec, needle: string): boolean {
  const haystack = [
    spec.name.replaceAll(".", " "),
    spec.summary,
    usageOf(spec),
    ...spec.examples,
    ...(spec.mcpTools ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .every((term) => haystack.includes(term));
}

const CommandsRunFlags = Type.Object({
  fields: Type.Optional(
    Type.String({
      description:
        "Comma-separated command names (e.g. page.get,comment.update) to return in full; replaces the global --fields projection for this command",
    }),
  ),
  contains: Type.Optional(
    Type.String({
      description: "Return full entries whose name, summary, usage, or examples contain every word",
    }),
  ),
});

export const commandsRun = defineCommand({
  name: "commands.run",
  summary: "List commands; select entries by name or text to get full schemas",
  args: [],
  flags: CommandsRunFlags,
  sideEffects: "none",
  examples: [
    "atl commands run",
    "atl commands run --fields page.get,comment.update",
    'atl commands run --contains "edit comment"',
  ],
  run(ctx, { flags }) {
    const registry = ctx.registry.all();
    if (flags.fields === undefined && flags.contains === undefined) {
      return Promise.resolve({
        commands: groupedIndex(registry),
        writes: registry.filter((spec) => spec.sideEffects === "write").map((spec) => spec.name),
        hint: "atl commands run --fields page.get for flags and examples",
      });
    }

    let selected = registry;
    if (flags.fields !== undefined) {
      const wanted = splitList(flags.fields);
      const known = registry.map((spec) => spec.name);
      for (const name of wanted) {
        if (known.includes(name)) {
          continue;
        }
        const suggestion = closestMatch(name, known);
        throw new AtlError(`Unknown command name "${name}"`, {
          code: "unknown_command_name",
          category: "input",
          hint:
            suggestion === undefined
              ? "Names are dotted, e.g. page.get. Run `atl commands run` to list them."
              : `Did you mean "${suggestion}"?`,
          next: [["atl", "commands", "run"]],
        });
      }
      const set = new Set(wanted);
      selected = selected.filter((spec) => set.has(spec.name));
    }
    if (flags.contains !== undefined) {
      const needle = flags.contains;
      selected = selected.filter((spec) => matchesContains(spec, needle));
    }
    return Promise.resolve({ commands: selected.map(fullEntry) });
  },
});

export const agentContract = defineCommand({
  name: "agent.contract",
  summary: "Print the machine contract: output channels, exit codes, global flags",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl agent contract", "atl agent contract --fields agentContractVersion"],
  run() {
    return Promise.resolve({
      agentContractVersion: 1,
      output: "single JSON value on stdout; JSONL diagnostics on stderr",
      exitCodes: EXIT_CODE_HELP,
      globalFlags: Object.fromEntries(
        GLOBAL_FLAGS.map((def) => [
          `--${def.name}${def.value === undefined ? "" : ` <${def.value}>`}${def.short === undefined ? "" : ` | -${def.short}`}`,
          def.description,
        ]),
      ),
    });
  },
});

export const metaCommands: readonly CommandSpec[] = [commandsRun, agentContract];
