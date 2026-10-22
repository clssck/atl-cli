#!/usr/bin/env bun
import "./commands/index.ts";
import { runCli } from "./core/cli.ts";
import { quietOnClosedStdout } from "./core/output.ts";

quietOnClosedStdout(process.stdout);
void runCli(process.argv.slice(2)).then((code) => (process.exitCode = code));
