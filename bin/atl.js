#!/usr/bin/env node
// npm bin for the atl CLI. Bun is the only runtime that executes CLI code.
// A Node-launched npm shim only bootstraps Bun with automatic .env loading
// disabled (a stray .env in the cwd could otherwise redirect ATL_* settings and
// tokens); `bunx --bun` enters Bun's Node-compatibility mode, which disables
// that loading before this module runs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { versionAtLeast } from "./bun-version.js";

const runningUnderBun = typeof process.versions.bun === "string";
const bunNodeCompatibilityMode =
  runningUnderBun &&
  (path.basename(process.argv0).toLowerCase().startsWith("node") ||
    (process.env.npm_lifecycle_event === "bunx" &&
      ["atl", "atl-cli"].includes(process.env.npm_lifecycle_script ?? "") &&
      /^bun(?:\.exe)?$/i.test(path.basename(process.env.npm_execpath ?? ""))));
// Plain `bun bin/atl.js` loaded nothing when the cwd holds none of the files
// Bun autoloads, so it is as safe as --no-env-file and may proceed.
const envFilesAbsent = [
  ".env",
  ".env.local",
  ...["development", "production", "test"].flatMap((mode) => [
    `.env.${mode}`,
    `.env.${mode}.local`,
  ]),
].every((name) => !existsSync(path.resolve(name)));
const envFileAutoloadDisabled =
  process.execArgv.includes("--no-env-file") || bunNodeCompatibilityMode || envFilesAbsent;
// The one source of the minimum is package.json engines.bun (">=X.Y.Z").
const MINIMUM_BUN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
).engines.bun.replace(/^>=/, "");

function writeError(error) {
  process.stdout.write(`${JSON.stringify({ type: "error", ok: false, ...error })}\n`);
  process.exitCode = error.exitCode;
}

if (!runningUnderBun) {
  // Check before spawning: an old Bun may reject --no-env-file during argument
  // parsing, before any launcher code could report a JSON error.
  const probe = spawnSync("bun", ["--version"], { encoding: "utf-8" });
  const found = probe.error ? undefined : probe.stdout.trim();
  const result =
    found !== undefined && versionAtLeast(found, MINIMUM_BUN)
      ? spawnSync(
          "bun",
          ["--no-env-file", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
          { stdio: "inherit", env: process.env },
        )
      : {
          error: new Error(
            found ? `Bun ${found} is older than the required ${MINIMUM_BUN}.` : "bun not found",
          ),
        };
  if (result.error) {
    writeError({
      error: `Unable to start the required Bun runtime: ${result.error.message}`,
      code: "internal_error",
      category: "internal",
      exitCode: 2,
      hint: found
        ? `Update Bun to ${MINIMUM_BUN} or newer: run \`bun upgrade\`.`
        : `Install Bun ${MINIMUM_BUN} or newer (https://bun.sh) and ensure \`bun\` is on PATH.`,
    });
  } else if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.status ?? 1;
  }
} else if (!versionAtLeast(Bun.version, MINIMUM_BUN)) {
  writeError({
    error: `Bun ${Bun.version} is older than the required ${MINIMUM_BUN}.`,
    code: "internal_error",
    category: "internal",
    exitCode: 2,
    hint: `Update Bun to ${MINIMUM_BUN} or newer: run \`bun upgrade\`.`,
  });
} else if (!envFileAutoloadDisabled) {
  writeError({
    error: "Bun automatic .env loading must be disabled for the atl launcher.",
    code: "env_autoload_enabled",
    category: "usage",
    exitCode: 1,
    hint: "Use `bunx --bun atl-cli` or pass `--no-env-file` before the script path.",
  });
} else {
  const here = import.meta.dir;
  const distCliPath = path.resolve(here, "../dist/atl.js");
  const sourceCliPath = path.resolve(here, "../src/main.ts");
  // A source checkout always runs its source; a leftover dist/ would otherwise
  // silently shadow every edit. The published package ships no src/, so
  // installs run dist.
  const usesDistCli =
    !(await Bun.file(sourceCliPath).exists()) && (await Bun.file(distCliPath).exists());
  const cliPath = usesDistCli ? distCliPath : sourceCliPath;

  // Same process, same argv: the CLI sees process.argv.slice(2) exactly as before.
  await import(pathToFileURL(cliPath).href);
}
