import { registry, type CommandContext } from "../../src/core/cli.ts";

/** Command context with all global flags at their defaults. */
export function makeContext(
  env: NodeJS.ProcessEnv,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    fields: undefined,
    full: false,
    output: undefined,
    site: undefined,
    plan: false,
    pretty: false,
    env,
    registry,
    argv: [],
    ...overrides,
  };
}
