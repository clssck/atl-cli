#!/usr/bin/env bun
import "./commands/index.ts";
import { runCli } from "./core/cli.ts";

void runCli(process.argv.slice(2)).then((code) => (process.exitCode = code));
