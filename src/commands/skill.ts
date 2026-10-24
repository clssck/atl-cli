import { resolve } from "node:path";
import {
  defineCommand,
  type CommandContext,
  type CommandInput,
  type CommandSpec,
} from "../core/cli.ts";
import { AtlError, inputError, type NextCommand } from "../core/errors.ts";
import { writeDiagnostic } from "../core/output.ts";
import { Type } from "../core/schema.ts";
import { cliOnPath, cliProblem, type CliOnPath, type CliProbe } from "../skill/cli-path.ts";
import {
  detectHosts,
  dirLocation,
  HOST_TARGETS,
  hostLocation,
  inspectSkill,
  installSkill,
  removeSkill,
  type HostTarget,
  type Inspection,
  type SkillLocation,
  type SkillSource,
  type SkillState,
  type TargetName,
} from "../skill/store.ts";
import { VERSION } from "../version.ts";
import { applyArgvFor, requireYes, YES_FLAG } from "./write.ts";

/** What the commands read besides the filesystem; tests substitute both. */
export type SkillDeps = SkillSource & { cli?: CliProbe };

/**
 * The skill is useless to agents without a matching `atl` on PATH: report what was found in the
 * result, and say what is wrong (with the fix) as a stderr warning.
 */
async function checkCli(ctx: CommandContext, deps: SkillDeps): Promise<{ cli?: CliOnPath }> {
  const cli = await cliOnPath(ctx.env, deps.cli);
  const problem = cliProblem(cli, deps.version ?? VERSION);
  if (problem !== undefined) {
    writeDiagnostic({ type: "warning", ...problem });
  }
  return cli.path === undefined ? {} : { cli };
}

export const skillGroups: Readonly<Record<string, string>> = {
  skill: "Install, update and inspect the bundled atl agent skill",
};

const TARGET_FLAGS = {
  target: Type.Optional(
    Type.String({
      description: `Comma-separated host targets (${HOST_TARGETS.join(", ")}); default: all (install: hosts found on this machine)`,
    }),
  ),
  dir: Type.Optional(
    Type.String({
      description: "Skills root to use instead of a host target; installs to <dir>/atl",
    }),
  ),
};
const FORCE_FLAG = Type.Optional(
  Type.Boolean({ description: "Replace a modified, unmanaged or newer copy (never a symlink)" }),
);

const StatusFlags = Type.Object({ ...TARGET_FLAGS });
const WriteFlags = Type.Object({ ...TARGET_FLAGS, force: FORCE_FLAG });
const UninstallFlags = Type.Object({ ...TARGET_FLAGS, force: FORCE_FLAG, yes: YES_FLAG });

type Operation = "install" | "update" | "uninstall";
type Action = "installed" | "updated" | "unchanged" | "removed" | "skipped";

interface TargetResult {
  target: TargetName;
  path: string;
  action: Action;
  state?: SkillState;
  reason?: string;
}

interface Resolved {
  locations: SkillLocation[];
  /** `--target` or `--dir` was given: a refusal is an error, not a skipped row. */
  explicit: boolean;
}

async function resolveLocations(
  ctx: CommandContext,
  flags: { target?: string | undefined; dir?: string | undefined },
  fallback: "all" | "detected",
): Promise<Resolved> {
  if (flags.dir !== undefined) {
    if (flags.target !== undefined) {
      throw inputError("conflicting_flags", "--dir and --target cannot be combined", "Use one.");
    }
    return { locations: [dirLocation(resolve(flags.dir))], explicit: true };
  }
  if (flags.target !== undefined) {
    const names = [
      ...new Set(
        flags.target
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      ),
    ];
    const hosts = names.map((name) => {
      const host = HOST_TARGETS.find((candidate) => candidate === name);
      if (host === undefined) {
        throw inputError("invalid_target", `Unknown skill target "${name}"`, targetHint());
      }
      return host;
    });
    if (hosts.length === 0) {
      throw inputError("invalid_target", "--target is empty", targetHint());
    }
    return { locations: hosts.map((host) => hostLocation(ctx.env, host)), explicit: true };
  }
  const hosts: readonly HostTarget[] =
    fallback === "all" ? HOST_TARGETS : await detectHosts(ctx.env);
  if (hosts.length === 0) {
    throw inputError("no_skill_target", "No agent home found for the skill", targetHint());
  }
  return { locations: hosts.map((host) => hostLocation(ctx.env, host)), explicit: false };
}

function targetHint(): string {
  return `Pass --target ${HOST_TARGETS.join("|")} (comma-separated) or --dir <skills-root>.`;
}

type Decision =
  | { kind: "write" | "remove" | "unchanged" }
  | { kind: "skip"; reason: string }
  | { kind: "refuse"; reason: string; forceable: boolean };

const LINKED = "symlink (dev link): remove it yourself, atl never touches it";
const LOCAL_EDITS = "local edits would be lost";

function decide(operation: Operation, state: SkillState, force: boolean): Decision {
  if (state === "linked") {
    return { kind: "refuse", reason: LINKED, forceable: false };
  }
  if (state === "missing") {
    return operation === "install" ? { kind: "write" } : { kind: "skip", reason: "not installed" };
  }
  if (operation === "uninstall") {
    if (state === "unmanaged") {
      return {
        kind: "refuse",
        reason: "not installed by atl (no manifest): delete it yourself",
        forceable: false,
      };
    }
    if (state === "modified" && !force) {
      return { kind: "refuse", reason: LOCAL_EDITS, forceable: true };
    }
    return { kind: "remove" };
  }
  if (state === "current") {
    return { kind: "unchanged" };
  }
  if (state === "outdated" || force) {
    return { kind: "write" };
  }
  const reasons: Partial<Record<SkillState, string>> = {
    modified: LOCAL_EDITS,
    unmanaged: "not installed by atl (no manifest)",
    newer: "installed copy is from a newer atl",
  };
  return { kind: "refuse", reason: reasons[state] ?? state, forceable: true };
}

interface Planned {
  location: SkillLocation;
  inspection: Inspection;
  decision: Decision;
}

function ioError(action: string, path: string, error: unknown): AtlError {
  const detail = error instanceof Error ? error.message : String(error);
  return new AtlError(`Cannot ${action} ${path}: ${detail}`, {
    code: "skill_io_error",
    category: "config",
    hint: "Check the directory exists and is writable; nothing was left half-written.",
    cause: error,
  });
}

async function runOperation(
  operation: Operation,
  ctx: CommandContext,
  flags: {
    target?: string | undefined;
    dir?: string | undefined;
    force?: boolean | undefined;
    yes?: boolean | undefined;
  },
  source: SkillDeps,
): Promise<unknown> {
  if (operation === "uninstall") {
    requireYes(ctx, flags.yes, "Uninstalling the atl skill");
  }
  const resolved = await resolveLocations(ctx, flags, operation === "install" ? "detected" : "all");
  const force = flags.force === true;
  const planned: Planned[] = [];
  for (const location of resolved.locations) {
    const inspection = await inspectSkill(location.path, source);
    planned.push({ location, inspection, decision: decide(operation, inspection.state, force) });
  }

  const refused = planned.filter(
    (entry): entry is Planned & { decision: Decision & { kind: "refuse" } } =>
      entry.decision.kind === "refuse",
  );
  if (resolved.explicit && refused.length > 0 && !ctx.plan) {
    const forceable = refused.some((entry) => entry.decision.forceable) && !force;
    const next: NextCommand[] = forceable
      ? [[...applyArgvFor(ctx, operation === "uninstall"), "--force"]]
      : [];
    throw new AtlError(
      `Refusing to ${operation}: ${refused
        .map(
          (entry) => `${entry.location.target} (${entry.location.path}): ${entry.decision.reason}`,
        )
        .join("; ")}`,
      {
        code: "skill_conflict",
        category: "input",
        hint: forceable
          ? "Nothing was changed. Re-run with --force to replace it."
          : "Nothing was changed.",
        next,
      },
    );
  }

  const targets: TargetResult[] = [];
  for (const { location, inspection, decision } of planned) {
    const base = { target: location.target, path: location.path, state: inspection.state };
    switch (decision.kind) {
      case "unchanged":
        targets.push({ ...base, action: "unchanged" });
        break;
      case "skip":
      case "refuse":
        targets.push({ ...base, action: "skipped", reason: decision.reason });
        break;
      case "write":
        if (!ctx.plan) {
          await installSkill(location.path, source).catch((error: unknown) => {
            throw ioError("write", location.path, error);
          });
        }
        targets.push({ ...base, action: inspection.state === "missing" ? "installed" : "updated" });
        break;
      case "remove":
        if (!ctx.plan) {
          await removeSkill(location.path).catch((error: unknown) => {
            throw ioError("remove", location.path, error);
          });
        }
        targets.push({ ...base, action: "removed" });
        break;
    }
  }

  const result = {
    version: source.version ?? VERSION,
    targets,
    ...(operation === "uninstall" ? {} : await checkCli(ctx, source)),
  };
  if (!ctx.plan) {
    return result;
  }
  const changes = targets.some((entry) =>
    ["installed", "updated", "removed"].includes(entry.action),
  );
  return {
    type: "plan",
    ...result,
    ...(changes ? { next: [applyArgvFor(ctx, operation === "uninstall")] } : {}),
  };
}

export async function runStatus(
  ctx: CommandContext,
  input: CommandInput<typeof StatusFlags>,
  source: SkillDeps = {},
): Promise<unknown> {
  const { locations } = await resolveLocations(ctx, input.flags, "all");
  const targets = [];
  for (const location of locations) {
    const { state, installed } = await inspectSkill(location.path, source);
    targets.push({
      target: location.target,
      path: location.path,
      state,
      ...(installed === undefined ? {} : { installed }),
    });
  }
  return { version: source.version ?? VERSION, targets, ...(await checkCli(ctx, source)) };
}

export function runInstall(
  ctx: CommandContext,
  input: CommandInput<typeof WriteFlags>,
  source: SkillDeps = {},
): Promise<unknown> {
  return runOperation("install", ctx, input.flags, source);
}

export function runUpdate(
  ctx: CommandContext,
  input: CommandInput<typeof WriteFlags>,
  source: SkillDeps = {},
): Promise<unknown> {
  return runOperation("update", ctx, input.flags, source);
}

export function runUninstall(
  ctx: CommandContext,
  input: CommandInput<typeof UninstallFlags>,
  source: SkillDeps = {},
): Promise<unknown> {
  return runOperation("uninstall", ctx, input.flags, source);
}

const status = defineCommand({
  name: "skill.status",
  summary: "Show where the atl skill is installed and whether each copy is current",
  args: [],
  flags: StatusFlags,
  sideEffects: "none",
  examples: [
    "atl skill status",
    "atl skill status --target omp,claude",
    "atl skill status --dir ./skills",
  ],
  run: (ctx, input) => runStatus(ctx, input),
});

const install = defineCommand({
  name: "skill.install",
  summary: "Install or refresh the bundled atl skill (default: every agent home found)",
  args: [],
  flags: WriteFlags,
  sideEffects: "local",
  examples: [
    "atl skill install",
    "atl skill install --target omp,claude",
    "atl skill install --dir ./skills --force",
    "atl skill install --plan",
  ],
  run: (ctx, input) => runInstall(ctx, input),
});

const update = defineCommand({
  name: "skill.update",
  summary: "Refresh installed copies of the atl skill to this CLI's bundle; skips missing ones",
  args: [],
  flags: WriteFlags,
  sideEffects: "local",
  examples: [
    "atl skill update",
    "atl skill update --target claude --force",
    "atl skill update --plan",
  ],
  run: (ctx, input) => runUpdate(ctx, input),
});

const uninstall = defineCommand({
  name: "skill.uninstall",
  summary: "Remove installed copies of the atl skill (managed copies only)",
  args: [],
  flags: UninstallFlags,
  sideEffects: "local",
  examples: [
    "atl skill uninstall --yes",
    "atl skill uninstall --target omp --yes --force",
    "atl skill uninstall --plan",
  ],
  run: (ctx, input) => runUninstall(ctx, input),
});

export const skillCommands: readonly CommandSpec[] = [status, install, update, uninstall];
