// The skill tells agents to run `atl`, so it only works when an `atl` on PATH matches the
// installed skill. Shared by `atl skill` and `atl doctor`; offline (one local `atl --version`).
import type { NextCommand } from "../core/errors.ts";
import { VERSION } from "../version.ts";

export const PACKAGE_NAME = "@clssck/atl-cli";

/** The `atl` agents will run: its resolved path and `--version`, both absent when none is found. */
export interface CliOnPath {
  path?: string;
  version?: string;
}

/** Test seam: how `atl` is looked up on PATH and asked for its version. */
export interface CliProbe {
  which?: (env: NodeJS.ProcessEnv) => string | null;
  version?: (path: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

function whichAtl(env: NodeJS.ProcessEnv): string | null {
  return Bun.which("atl", { PATH: env.PATH ?? env.Path ?? "" });
}

async function atlVersion(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const child = Bun.spawn([path, "--version"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
    });
    const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return /^atl (\S+)/.exec(text.trim())?.[1];
  } catch {
    return undefined;
  }
}

export async function cliOnPath(env: NodeJS.ProcessEnv, probe: CliProbe = {}): Promise<CliOnPath> {
  const path = (probe.which ?? whichAtl)(env);
  if (path === null) {
    return {};
  }
  const version = await (probe.version ?? atlVersion)(path, env);
  return version === undefined ? { path } : { path, version };
}

/** What is wrong with the `atl` on PATH and how to fix it; undefined when it matches `expected`. */
export interface CliProblem {
  code: "atl_not_on_path" | "atl_version_mismatch";
  message: string;
  hint: string;
  next: NextCommand[];
}

export function cliProblem(cli: CliOnPath, expected: string = VERSION): CliProblem | undefined {
  if (cli.path === undefined) {
    return {
      code: "atl_not_on_path",
      message: "No `atl` on PATH: agents using the skill cannot run it",
      hint: `Install it globally: \`bun add -g ${PACKAGE_NAME}\` (or \`npm i -g ${PACKAGE_NAME}\`; both need Bun >= 1.4.4 on PATH). From a source checkout: \`bun link\`. Then open a new shell.`,
      next: [["bun", "add", "-g", PACKAGE_NAME]],
    };
  }
  if (cli.version !== undefined && cli.version !== expected) {
    return {
      code: "atl_version_mismatch",
      message: `The atl on PATH (${cli.path}) is ${cli.version}, this skill bundle is ${expected}`,
      hint: `Make them match: upgrade the global CLI (\`bun add -g ${PACKAGE_NAME}@latest\`), then run \`atl skill update\` with it.`,
      next: [
        ["bun", "add", "-g", `${PACKAGE_NAME}@latest`],
        ["atl", "skill", "update"],
      ],
    };
  }
  return undefined;
}
