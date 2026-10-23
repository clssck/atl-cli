// Packs the package (or takes a verified release candidate), installs it into a
// temporary project, and exercises the installed `atl` offline: version, help,
// a JSON command, the error envelope, and the shipped skill and license.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyCandidate } from "./release-candidate.ts";

const root = path.resolve(import.meta.dir, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atl-cli-platform-"));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command: string, args: string[], options: { cwd?: string } = {}): string {
  const result = Bun.spawnSync([command, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
    env: smokeEnv,
    ...options,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stdout.toString()}`,
    );
  }
  return result.stdout.toString();
}

// An empty config dir keeps the smoke away from the user's credentials and site cache.
const configDir = path.join(tempRoot, "config");
const smokeEnv = { ...process.env, ATL_CONFIG_DIR: configDir };

try {
  const packDir = path.join(tempRoot, "packed artifact");
  const installDir = path.join(tempRoot, "installed package");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  await Bun.write(path.join(installDir, "package.json"), '{"private":true}\n');

  const [option, candidateDirectory, ...extra] = process.argv.slice(2);
  assert(
    option === undefined ||
      (option === "--candidate" && candidateDirectory !== undefined && extra.length === 0),
    "Usage: platform-smoke.ts [--candidate DIRECTORY]",
  );
  const candidate = candidateDirectory ? verifyCandidate(candidateDirectory) : undefined;
  let tarball: string;
  if (candidateDirectory) {
    tarball = path.resolve(candidateDirectory, "package.tgz");
  } else {
    const packOutput = run(process.execPath, ["pm", "pack", `--destination=${packDir}`, "--quiet"]);
    const packedPath = packOutput.trim().split(/\r?\n/).at(-1);
    assert(typeof packedPath === "string" && packedPath.length > 0, "Bun pack omitted filename");
    tarball = path.isAbsolute(packedPath) ? packedPath : path.join(packDir, packedPath);
  }
  assert(await Bun.file(tarball).exists(), `packed artifact is missing: ${tarball}`);

  run(process.execPath, ["add", "--cwd", installDir, "--no-save", "--ignore-scripts", tarball]);

  const installed = path.join(installDir, "node_modules", "@clssck", "atl-cli");
  const cli = path.join(installed, "bin", "atl.js");
  assert(await Bun.file(cli).exists(), `installed CLI entrypoint is missing: ${cli}`);
  const pkg: { version: string } = await Bun.file(path.join(installed, "package.json")).json();

  const version = run(process.execPath, ["--no-env-file", cli, "--version"], {
    cwd: installDir,
  }).trim();
  assert(version === `atl ${pkg.version}`, `packaged CLI version output is invalid: ${version}`);
  if (candidate) {
    assert(
      pkg.version === candidate.version,
      "Installed candidate version differs from its manifest",
    );
  }
  const bunxVersion = run(process.execPath, ["x", "--bun", "atl", "--version"], {
    cwd: installDir,
  }).trim();
  assert(bunxVersion === version, "bunx reported the wrong packaged CLI version");

  const help = run(process.execPath, ["--no-env-file", cli, "--help"], { cwd: installDir });
  assert(help.includes("Usage:") && help.includes("Commands:"), "packaged CLI help is invalid");

  const formats: { products?: unknown } = JSON.parse(
    run(process.execPath, ["--no-env-file", cli, "formats"], { cwd: installDir }),
  );
  assert(typeof formats.products === "object", "packaged formats output is invalid");

  for (const relativePath of [path.join("skills", "atl", "SKILL.md"), "LICENSE", "plugin.json"]) {
    const packaged = path.join(installed, relativePath);
    assert(await Bun.file(packaged).exists(), `packaged file is missing: ${relativePath}`);
    if (!candidate) {
      assert(
        Bun.deepEquals(
          await Bun.file(packaged).bytes(),
          await Bun.file(path.join(root, relativePath)).bytes(),
        ),
        `packaged file differs from the source tree: ${relativePath}`,
      );
    }
  }

  const failure = Bun.spawnSync([process.execPath, "--no-env-file", cli, "not-a-command"], {
    cwd: installDir,
    env: smokeEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(
    failure.exitCode === 1,
    `packaged CLI returned unexpected error status: ${failure.exitCode}`,
  );
  assert(failure.stdout.toString() === "", "packaged CLI wrote error output to stdout");
  const errorLines = failure.stderr.toString().trim().split("\n");
  assert(errorLines.length === 1, "packaged CLI error output was not one JSONL event");
  const error: { type?: unknown; exitCode?: unknown } = JSON.parse(errorLines[0] ?? "");
  assert(error.type === "error" && error.exitCode === 1, "packaged CLI error envelope is invalid");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      version: pkg.version,
    })}\n`,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
}
