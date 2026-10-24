// Filesystem side of `atl skill`: where host agents look for skills, what an installed copy is
// (manifest + hashes), and the atomic replace. Offline; the bundle and version are injectable.
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { errnoCode } from "../core/fs.ts";
import { isRecord } from "../core/guards.ts";
import { VERSION } from "../version.ts";
import { BUNDLED_SKILL } from "./bundle.ts";
import { isIgnoredFile } from "./ignored.ts";

export const SKILL_NAME = "atl";
export const MANIFEST_FILE = ".atl-skill.json";

export const HOST_TARGETS = ["omp", "claude", "agents"] as const;
export type HostTarget = (typeof HOST_TARGETS)[number];
export type TargetName = HostTarget | "dir";

export type SkillState =
  | "missing"
  | "linked"
  | "unmanaged"
  | "modified"
  | "current"
  | "outdated"
  | "newer";

/** What the CLI ships; tests substitute another bundle or version. */
export interface SkillSource {
  bundle?: ReadonlyMap<string, Uint8Array>;
  version?: string;
}

export interface SkillLocation {
  target: TargetName;
  /** The install directory: `<skills root>/atl`. */
  path: string;
}

export interface Inspection {
  state: SkillState;
  /** Manifest version, when the directory has a readable manifest. */
  installed?: string;
}

/** First non-empty value (an exported but empty variable counts as unset). */
function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function hostDirs(env: NodeJS.ProcessEnv, target: HostTarget): { root: string; markers: string[] } {
  const home = firstSet(env.HOME, env.USERPROFILE) ?? homedir();
  if (target === "omp") {
    const agent = firstSet(env.PI_CODING_AGENT_DIR) ?? join(home, ".omp", "agent");
    return { root: join(agent, "skills"), markers: [agent] };
  }
  if (target === "claude") {
    const config = firstSet(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
    return { root: join(config, "skills"), markers: [config] };
  }
  return {
    root: join(home, ".agents", "skills"),
    markers: [join(home, ".agents"), join(home, ".codex")],
  };
}

export function hostLocation(env: NodeJS.ProcessEnv, target: HostTarget): SkillLocation {
  return { target, path: join(hostDirs(env, target).root, SKILL_NAME) };
}

export function dirLocation(root: string): SkillLocation {
  return { target: "dir", path: join(root, SKILL_NAME) };
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** Host targets whose agent home exists on this machine. */
export async function detectHosts(env: NodeJS.ProcessEnv): Promise<HostTarget[]> {
  const found: HostTarget[] = [];
  for (const target of HOST_TARGETS) {
    for (const marker of hostDirs(env, target).markers) {
      if ((await lstatOrUndefined(marker)) !== undefined) {
        found.push(target);
        break;
      }
    }
  }
  return found;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function hashBundle(bundle: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  return new Map([...bundle].map(([path, bytes]) => [path, sha256(bytes)]));
}

function sameHashes(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([path, hash]) => b.get(path) === hash);
}

/** Hashes of every non-directory entry except the manifest; links and specials never match. */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() || isIgnoredFile(entry.name)) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(dir, absolute).split(sep).join("/");
    if (path === MANIFEST_FILE) {
      continue;
    }
    hashes.set(path, entry.isFile() ? sha256(await readFile(absolute)) : "!not-a-regular-file");
  }
  return hashes;
}

interface Manifest {
  version: string;
  files: Map<string, string>;
}

async function readManifest(dir: string): Promise<Manifest | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.name !== SKILL_NAME || typeof parsed.version !== "string") {
    return undefined;
  }
  if (!isRecord(parsed.files)) {
    return undefined;
  }
  const files = new Map<string, string>();
  for (const [path, hash] of Object.entries(parsed.files)) {
    if (typeof hash !== "string") {
      return undefined;
    }
    files.set(path, hash);
  }
  return { version: parsed.version, files };
}

interface SemVer {
  core: readonly [number, number, number];
  pre: string | undefined;
}

function parseSemVer(text: string): SemVer | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

/** True when `a` is strictly greater than `b`; a release outranks its prereleases. Unparseable: false. */
export function isNewerVersion(a: string, b: string): boolean {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (left === undefined || right === undefined) {
    return false;
  }
  for (let index = 0; index < 3; index++) {
    const delta = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (delta !== 0) {
      return delta > 0;
    }
  }
  if (left.pre === right.pre) {
    return false;
  }
  if (left.pre === undefined || right.pre === undefined) {
    return left.pre === undefined;
  }
  return left.pre > right.pre;
}

export async function inspectSkill(path: string, source: SkillSource = {}): Promise<Inspection> {
  const stat = await lstatOrUndefined(path);
  if (stat === undefined) {
    return { state: "missing" };
  }
  if (stat.isSymbolicLink()) {
    return { state: "linked" };
  }
  const manifest = stat.isDirectory() ? await readManifest(path) : undefined;
  if (manifest === undefined) {
    return { state: "unmanaged" };
  }
  const installed = manifest.version;
  if (!sameHashes(manifest.files, await hashTree(path))) {
    return { state: "modified", installed };
  }
  const version = source.version ?? VERSION;
  if (isNewerVersion(installed, version)) {
    return { state: "newer", installed };
  }
  const current =
    installed === version && sameHashes(manifest.files, hashBundle(source.bundle ?? BUNDLED_SKILL));
  return { state: current ? "current" : "outdated", installed };
}

/**
 * Replace `path` with the bundle: write a sibling temp tree, move the old one aside, move the new
 * one in, delete the old one. Readers see the old or the new tree, never a partial one, and files
 * the new bundle dropped disappear with the old directory. `path` is never followed as a link.
 */
export async function installSkill(path: string, source: SkillSource = {}): Promise<void> {
  const bundle = source.bundle ?? BUNDLED_SKILL;
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const suffix = `${process.pid}.${crypto.randomUUID()}`;
  const fresh = join(parent, `.${SKILL_NAME}.${suffix}.new`);
  const aside = join(parent, `.${SKILL_NAME}.${suffix}.old`);
  try {
    for (const [file, bytes] of bundle) {
      await Bun.write(join(fresh, ...file.split("/")), bytes);
    }
    const manifest = {
      name: SKILL_NAME,
      version: source.version ?? VERSION,
      files: Object.fromEntries(
        [...hashBundle(bundle)].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
    await Bun.write(join(fresh, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    const existed = (await lstatOrUndefined(path)) !== undefined;
    if (existed) {
      await rename(path, aside);
    }
    try {
      await rename(fresh, path);
    } catch (error) {
      if (existed) {
        await rename(aside, path);
      }
      throw error;
    }
    if (existed) {
      await rm(aside, { recursive: true, force: true });
    }
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
}

/** Remove an installed copy: rename aside first so a failed delete never leaves a half-removed install. */
export async function removeSkill(path: string): Promise<void> {
  const aside = join(dirname(path), `.${SKILL_NAME}.${process.pid}.${crypto.randomUUID()}.old`);
  await rename(path, aside);
  await rm(aside, { recursive: true, force: true });
}
