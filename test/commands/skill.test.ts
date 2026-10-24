import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { runDoctor } from "../../src/commands/site.ts";
import {
  runInstall,
  runStatus,
  runUninstall,
  runUpdate,
  type SkillDeps,
} from "../../src/commands/skill.ts";
import { isRecord } from "../../src/core/guards.ts";
import { BUNDLED_SKILL } from "../../src/skill/bundle.ts";
import type { CliProbe } from "../../src/skill/cli-path.ts";
import { isIgnoredFile } from "../../src/skill/ignored.ts";
import { hashBundle, inspectSkill, installSkill, MANIFEST_FILE } from "../../src/skill/store.ts";
import { makeContext } from "../helpers/context.ts";
import { withDiagnostics } from "../helpers/stderr.ts";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Fixture extends SkillDeps {
  version: string;
  bundle: ReadonlyMap<string, Uint8Array>;
}

/** An `atl` on PATH at `version`, so tests that are not about PATH stay quiet on stderr. */
const onPath = (version: string): CliProbe => ({
  which: () => "/opt/atl",
  version: () => Promise.resolve(version),
});

const V1: Fixture = {
  version: "1.0.0",
  bundle: new Map([
    ["SKILL.md", enc("v1 skill")],
    ["references/old.md", enc("only in v1")],
  ]),
  cli: onPath("1.0.0"),
};
const V2: Fixture = {
  version: "1.1.0",
  bundle: new Map([
    ["SKILL.md", enc("v2 skill")],
    ["references/new.md", enc("only in v2")],
  ]),
  cli: onPath("1.1.0"),
};

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  omp: string;
  claude: string;
  agents: string;
}

/** Fresh HOME with no agent homes; tests create the ones they need. */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "atl-skill-"));
  created.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const ompDir = join(root, "omp-agent");
  const claudeDir = join(root, "claude-config");
  return {
    root,
    env: { HOME: home, PI_CODING_AGENT_DIR: ompDir, CLAUDE_CONFIG_DIR: claudeDir },
    omp: join(ompDir, "skills", "atl"),
    claude: join(claudeDir, "skills", "atl"),
    agents: join(home, ".agents", "skills", "atl"),
  };
}

interface Flags {
  target?: string;
  dir?: string;
  force?: boolean;
  yes?: boolean;
}

const input = (flags: Flags = {}): { args: {}; rest: []; flags: Flags } => ({
  args: {},
  rest: [],
  flags,
});

function targets(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || !Array.isArray(result.targets)) {
    throw new Error("result has no targets");
  }
  return result.targets.filter(isRecord);
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !isIgnoredFile(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
}

describe("embedded bundle", () => {
  test("carries exactly the files of skills/atl", () => {
    const dir = join(import.meta.dir, "..", "..", "skills", "atl");
    expect([...BUNDLED_SKILL.keys()].toSorted()).toEqual(listFiles(dir));
    for (const [path, bytes] of BUNDLED_SKILL) {
      expect(Buffer.from(bytes).equals(readFileSync(join(dir, ...path.split("/"))))).toBe(true);
    }
  });
});

describe("state detection", () => {
  test("missing, current, outdated and newer follow the manifest version and bundle", async () => {
    const sb = sandbox();
    expect(await inspectSkill(sb.omp, V1)).toEqual({ state: "missing" });
    await installSkill(sb.omp, V1);
    expect(await inspectSkill(sb.omp, V1)).toEqual({ state: "current", installed: "1.0.0" });
    expect(await inspectSkill(sb.omp, V2)).toEqual({ state: "outdated", installed: "1.0.0" });
    await installSkill(sb.omp, V2);
    expect(await inspectSkill(sb.omp, V1)).toEqual({ state: "newer", installed: "1.1.0" });
  });

  test("same version with a different bundle is outdated", async () => {
    const sb = sandbox();
    await installSkill(sb.omp, V1);
    const changed = { version: "1.0.0", bundle: V2.bundle };
    expect((await inspectSkill(sb.omp, changed)).state).toBe("outdated");
  });

  test("edited, added and removed files make the copy modified", async () => {
    const sb = sandbox();
    await installSkill(sb.omp, V1);
    const skillMd = join(sb.omp, "SKILL.md");
    await Bun.write(skillMd, "edited");
    expect((await inspectSkill(sb.omp, V1)).state).toBe("modified");
    await installSkill(sb.omp, V1);
    await Bun.write(join(sb.omp, "extra.md"), "added");
    expect((await inspectSkill(sb.omp, V1)).state).toBe("modified");
    await installSkill(sb.omp, V1);
    rmSync(join(sb.omp, "references", "old.md"));
    expect((await inspectSkill(sb.omp, V1)).state).toBe("modified");
  });

  test("Finder and Explorer junk files leave an untouched copy current", async () => {
    const sb = sandbox();
    await installSkill(sb.omp, V1);
    await Bun.write(join(sb.omp, ".DS_Store"), "finder");
    await Bun.write(join(sb.omp, "references", "Thumbs.db"), "explorer");
    expect(await inspectSkill(sb.omp, V1)).toEqual({ state: "current", installed: "1.0.0" });
  });

  test("a directory without a valid manifest is unmanaged; a symlink is linked", async () => {
    const sb = sandbox();
    await Bun.write(join(sb.omp, "SKILL.md"), "hand written");
    expect((await inspectSkill(sb.omp, V1)).state).toBe("unmanaged");
    await Bun.write(join(sb.omp, MANIFEST_FILE), "{not json");
    expect((await inspectSkill(sb.omp, V1)).state).toBe("unmanaged");

    const checkout = join(sb.root, "checkout");
    await Bun.write(join(checkout, "SKILL.md"), "dev");
    mkdirSync(join(sb.root, "claude-config", "skills"), { recursive: true });
    symlinkSync(checkout, sb.claude, "dir");
    expect((await inspectSkill(sb.claude, V1)).state).toBe("linked");
  });

  test("the manifest records the sha256 of every bundled file", async () => {
    const sb = sandbox();
    await installSkill(sb.omp, V1);
    const manifest: unknown = JSON.parse(readFileSync(join(sb.omp, MANIFEST_FILE), "utf8"));
    expect(manifest).toEqual({
      name: "atl",
      version: "1.0.0",
      files: Object.fromEntries(hashBundle(V1.bundle)),
    });
    expect(isRecord(manifest) && isRecord(manifest.files) && manifest.files["SKILL.md"]).toBe(
      new Bun.CryptoHasher("sha256").update("v1 skill").digest("hex"),
    );
  });
});

describe("skill status", () => {
  test("lists all three host targets under the env-derived roots", async () => {
    const sb = sandbox();
    await installSkill(sb.claude, V1);
    const result = await runStatus(makeContext(sb.env), input(), V1);
    expect(result).toEqual({
      version: "1.0.0",
      targets: [
        { target: "omp", path: sb.omp, state: "missing" },
        { target: "claude", path: sb.claude, state: "current", installed: "1.0.0" },
        { target: "agents", path: sb.agents, state: "missing" },
      ],
      cli: { path: "/opt/atl", version: "1.0.0" },
    });
  });

  test("--target narrows and --dir uses an explicit root", async () => {
    const sb = sandbox();
    const root = join(sb.root, "custom");
    await installSkill(join(root, "atl"), V1);
    const narrowed = await runStatus(makeContext(sb.env), input({ target: "agents,omp" }), V1);
    expect(targets(narrowed).map((row) => row.target)).toEqual(["agents", "omp"]);
    const custom = await runStatus(makeContext(sb.env), input({ dir: root }), V1);
    expect(targets(custom)).toEqual([
      { target: "dir", path: join(root, "atl"), state: "current", installed: "1.0.0" },
    ]);
  });

  test("unknown targets and --dir with --target are input errors", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    await expect(runStatus(ctx, input({ target: "vscode" }), V1)).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(runStatus(ctx, input({ target: "omp", dir: sb.root }), V1)).rejects.toMatchObject({
      code: "conflicting_flags",
    });
  });

  test("warns with the fix when no matching atl is on PATH", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    const absent = await withDiagnostics(() =>
      runStatus(ctx, input(), { ...V1, cli: { which: () => null } }),
    );
    expect(absent.result).not.toHaveProperty("cli");
    expect(absent.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "atl_not_on_path",
        next: [["bun", "add", "-g", "@clssck/atl-cli"]],
      }),
    );

    const old = { which: () => "/opt/atl", version: () => Promise.resolve("0.9.0") };
    const stale = await withDiagnostics(() =>
      runInstall(ctx, input({ dir: sb.root }), { ...V1, cli: old }),
    );
    expect(stale.result).toMatchObject({ cli: { path: "/opt/atl", version: "0.9.0" } });
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({ code: "atl_version_mismatch" }),
    );

    const same = { which: () => "/opt/atl", version: () => Promise.resolve("1.0.0") };
    const ok = await withDiagnostics(() => runStatus(ctx, input(), { ...V1, cli: same }));
    expect(ok.diagnostics).toEqual([]);

    // Found on PATH but `atl --version` cannot run (e.g. `env: node` exit 127): a real spawn failure.
    const broken = { which: () => join(sb.root, "missing-bin", "atl") };
    const dead = await withDiagnostics(() => runStatus(ctx, input(), { ...V1, cli: broken }));
    expect(dead.result).toMatchObject({ cli: { path: join(sb.root, "missing-bin", "atl") } });
    expect(dead.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "atl_not_runnable",
        next: [[join(sb.root, "missing-bin", "atl"), "--version"]],
      }),
    );
  });
});

describe("skill install", () => {
  test("without --target installs only where an agent home exists", async () => {
    const sb = sandbox();
    mkdirSync(sb.env.CLAUDE_CONFIG_DIR ?? "", { recursive: true });
    mkdirSync(join(sb.env.HOME ?? "", ".codex"), { recursive: true });
    const result = await runInstall(makeContext(sb.env), input(), V1);
    expect(targets(result).map((row) => [row.target, row.action])).toEqual([
      ["claude", "installed"],
      ["agents", "installed"],
    ]);
    expect(listFiles(sb.claude)).toEqual([MANIFEST_FILE, "SKILL.md", "references/old.md"]);
    expect(readFileSync(join(sb.agents, "SKILL.md"), "utf8")).toBe("v1 skill");
    expect((await inspectSkill(sb.omp, V1)).state).toBe("missing");
  });

  test("no agent home found is an input error listing the --target values", async () => {
    const sb = sandbox();
    const error = await runInstall(makeContext(sb.env), input(), V1).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "no_skill_target", category: "input" });
    expect(error).toMatchObject({ hint: expect.stringContaining("omp|claude|agents") });
  });

  test("a current copy is unchanged and is not rewritten", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    await runInstall(ctx, input({ target: "omp" }), V1);
    const before = Bun.file(join(sb.omp, MANIFEST_FILE)).lastModified;
    const again = await runInstall(ctx, input({ target: "omp" }), V1);
    expect(targets(again)).toEqual([
      { target: "omp", path: sb.omp, state: "current", action: "unchanged" },
    ]);
    expect(Bun.file(join(sb.omp, MANIFEST_FILE)).lastModified).toBe(before);
  });

  test("modified, unmanaged and newer copies need --force when the target is explicit", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env, { argv: ["skill", "install", "--target", "omp"] });
    await installSkill(sb.omp, V2);
    await expect(runInstall(ctx, input({ target: "omp" }), V1)).rejects.toMatchObject({
      code: "skill_conflict",
      next: [["atl", "skill", "install", "--target", "omp", "--force"]],
    });
    expect(readFileSync(join(sb.omp, "SKILL.md"), "utf8")).toBe("v2 skill");

    const forced = await runInstall(ctx, input({ target: "omp", force: true }), V1);
    expect(targets(forced)[0]).toMatchObject({ state: "newer", action: "updated" });
    expect(readFileSync(join(sb.omp, "SKILL.md"), "utf8")).toBe("v1 skill");

    await Bun.write(join(sb.omp, "SKILL.md"), "edited");
    await expect(runInstall(ctx, input({ target: "omp" }), V1)).rejects.toMatchObject({
      code: "skill_conflict",
    });
    await runInstall(ctx, input({ target: "omp", force: true }), V1);
    expect((await inspectSkill(sb.omp, V1)).state).toBe("current");

    rmSync(join(sb.omp, MANIFEST_FILE));
    await expect(runInstall(ctx, input({ target: "omp" }), V1)).rejects.toMatchObject({
      code: "skill_conflict",
    });
    const unmanaged = await runInstall(ctx, input({ target: "omp", force: true }), V1);
    expect(targets(unmanaged)[0]).toMatchObject({ state: "unmanaged", action: "updated" });
  });

  test("a refusal under implicit targets is a skipped row and the others still install", async () => {
    const sb = sandbox();
    mkdirSync(sb.env.PI_CODING_AGENT_DIR ?? "", { recursive: true });
    mkdirSync(sb.env.CLAUDE_CONFIG_DIR ?? "", { recursive: true });
    await Bun.write(join(sb.omp, "SKILL.md"), "hand written");
    const result = await runInstall(makeContext(sb.env), input(), V1);
    expect(targets(result).map((row) => [row.target, row.action])).toEqual([
      ["omp", "skipped"],
      ["claude", "installed"],
    ]);
    expect(readFileSync(join(sb.omp, "SKILL.md"), "utf8")).toBe("hand written");
  });

  test("a symlink is refused even with --force and its target is never touched", async () => {
    const sb = sandbox();
    const checkout = join(sb.root, "checkout");
    await Bun.write(join(checkout, "SKILL.md"), "dev");
    mkdirSync(join(sb.root, "claude-config", "skills"), { recursive: true });
    symlinkSync(checkout, sb.claude, "dir");
    const ctx = makeContext(sb.env);
    for (const run of [runInstall, runUpdate]) {
      await expect(run(ctx, input({ target: "claude", force: true }), V1)).rejects.toMatchObject({
        code: "skill_conflict",
        hint: "Nothing was changed.",
      });
    }
    expect(listFiles(checkout)).toEqual(["SKILL.md"]);
    expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toBe("dev");
    expect((await inspectSkill(sb.claude, V1)).state).toBe("linked");
  });

  test("--dir installs under <dir>/atl", async () => {
    const sb = sandbox();
    const root = join(sb.root, "custom skills");
    const result = await runInstall(makeContext(sb.env), input({ dir: root }), V1);
    expect(targets(result)).toEqual([
      { target: "dir", path: join(root, "atl"), state: "missing", action: "installed" },
    ]);
  });
});

describe("skill update", () => {
  test("refreshes outdated copies, drops stale files and skips missing targets", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    await installSkill(sb.omp, V1);
    const result = await runUpdate(ctx, input(), V2);
    expect(targets(result).map((row) => [row.target, row.action, row.reason])).toEqual([
      ["omp", "updated", undefined],
      ["claude", "skipped", "not installed"],
      ["agents", "skipped", "not installed"],
    ]);
    expect(listFiles(sb.omp)).toEqual([MANIFEST_FILE, "SKILL.md", "references/new.md"]);
    expect((await inspectSkill(sb.omp, V2)).state).toBe("current");
    expect(readdirSync(join(sb.omp, ".."))).toEqual(["atl"]);
    expect((await inspectSkill(sb.claude, V2)).state).toBe("missing");
  });

  test("a modified copy is only replaced with --force", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    await installSkill(sb.omp, V1);
    await Bun.write(join(sb.omp, "SKILL.md"), "edited");
    await expect(runUpdate(ctx, input({ target: "omp" }), V2)).rejects.toMatchObject({
      code: "skill_conflict",
    });
    expect(readFileSync(join(sb.omp, "SKILL.md"), "utf8")).toBe("edited");
    await runUpdate(ctx, input({ target: "omp", force: true }), V2);
    expect((await inspectSkill(sb.omp, V2)).state).toBe("current");
  });
});

describe("skill uninstall", () => {
  test("needs --yes and removes managed copies", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    await installSkill(sb.omp, V1);
    await expect(runUninstall(ctx, input({ target: "omp" }), V1)).rejects.toMatchObject({
      code: "confirmation_required",
    });
    expect((await inspectSkill(sb.omp, V1)).state).toBe("current");
    const result = await runUninstall(ctx, input({ target: "omp,claude", yes: true }), V1);
    expect(targets(result).map((row) => row.action)).toEqual(["removed", "skipped"]);
    expect((await inspectSkill(sb.omp, V1)).state).toBe("missing");
    expect(readdirSync(join(sb.omp, ".."))).toEqual([]);
  });

  test("a modified copy needs --force; unmanaged and linked copies are never removed", async () => {
    const sb = sandbox();
    const ctx = makeContext(sb.env);
    await installSkill(sb.omp, V1);
    await Bun.write(join(sb.omp, "SKILL.md"), "edited");
    await expect(runUninstall(ctx, input({ target: "omp", yes: true }), V1)).rejects.toMatchObject({
      code: "skill_conflict",
    });
    await runUninstall(ctx, input({ target: "omp", yes: true, force: true }), V1);
    expect((await inspectSkill(sb.omp, V1)).state).toBe("missing");

    await Bun.write(join(sb.claude, "SKILL.md"), "hand written");
    await expect(
      runUninstall(ctx, input({ target: "claude", yes: true, force: true }), V1),
    ).rejects.toMatchObject({ code: "skill_conflict" });
    expect(readFileSync(join(sb.claude, "SKILL.md"), "utf8")).toBe("hand written");

    const checkout = join(sb.root, "checkout");
    await Bun.write(join(checkout, "SKILL.md"), "dev");
    mkdirSync(join(sb.agents, ".."), { recursive: true });
    symlinkSync(checkout, sb.agents, "dir");
    await expect(
      runUninstall(ctx, input({ target: "agents", yes: true, force: true }), V1),
    ).rejects.toMatchObject({ code: "skill_conflict" });
    expect(readFileSync(join(checkout, "SKILL.md"), "utf8")).toBe("dev");
  });
});

describe("--plan", () => {
  test("install, update and uninstall report their actions and touch nothing", async () => {
    const sb = sandbox();
    const plan = makeContext(sb.env, { plan: true, argv: ["skill", "install", "--plan"] });

    const installed = await runInstall(plan, input({ target: "omp,claude" }), V1);
    expect(installed).toMatchObject({
      type: "plan",
      version: "1.0.0",
      next: [["atl", "skill", "install"]],
    });
    expect(targets(installed).map((row) => row.action)).toEqual(["installed", "installed"]);
    expect(readdirSync(sb.root)).toEqual(["home"]);

    await installSkill(sb.omp, V1);
    const before = listFiles(sb.omp);
    const updated = await runUpdate(plan, input({ target: "omp" }), V2);
    expect(targets(updated)[0]).toMatchObject({ action: "updated" });
    expect(listFiles(sb.omp)).toEqual(before);
    expect(readFileSync(join(sb.omp, "SKILL.md"), "utf8")).toBe("v1 skill");

    const removed = await runUninstall(plan, input({ target: "omp" }), V1);
    expect(targets(removed)[0]).toMatchObject({ action: "removed" });
    expect(removed).toMatchObject({ next: [["atl", "skill", "install", "--yes"]] });
    expect((await inspectSkill(sb.omp, V1)).state).toBe("current");
  });

  test("a refusal is reported as skipped instead of thrown", async () => {
    const sb = sandbox();
    await Bun.write(join(sb.omp, "SKILL.md"), "hand written");
    const plan = makeContext(sb.env, { plan: true });
    const result = await runInstall(plan, input({ target: "omp" }), V1);
    expect(targets(result)[0]).toMatchObject({ action: "skipped", state: "unmanaged" });
    expect(result).not.toHaveProperty("next");
  });
});

const down = (): Promise<Response> => Promise.resolve(new Response("down", { status: 503 }));

describe("doctor", () => {
  test("lists only installed copies and points an outdated one at `skill update`", async () => {
    const sb = sandbox();
    const env = { ...sb.env, ATL_CONFIG_DIR: join(sb.root, "config") };
    const clean = await runDoctor(makeContext(env), { fetch: down });
    expect(isRecord(clean) ? clean.skill : undefined).toEqual({});

    await installSkill(sb.omp, { bundle: V1.bundle });
    await installSkill(sb.claude);
    const report = await runDoctor(makeContext(env), { fetch: down });
    expect(report).toMatchObject({ skill: { omp: "outdated", claude: "current" } });
    expect(isRecord(report) ? report.missing : undefined).toContainEqual({
      step: "Update the installed atl skill",
      next: ["atl", "skill", "update"],
    });
  });
});
