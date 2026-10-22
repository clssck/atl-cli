import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandInput } from "../../src/core/cli.ts";
import { makeContext as context } from "../helpers/context.ts";
import { AtlError } from "../../src/core/errors.ts";
import type { LoginFlags } from "../../src/commands/auth.ts";
import { authCommands, runLogin } from "../../src/commands/auth.ts";
import { authStatus } from "../../src/auth/index.ts";
import { createSandbox, fakeFetch, jsonResponse, makeJwt, type Sandbox } from "../auth/helpers.ts";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(() => sandbox.cleanup());

const withToken: CommandInput<typeof LoginFlags> = {
  args: {},
  rest: [],
  flags: { withToken: true },
};

describe("auth login --with-token", () => {
  test("empty stdin is a token_missing input error", async () => {
    const error = await runLogin(context(sandbox.env), withToken, {
      readStdin: () => Promise.resolve("  \n"),
      stdinIsTty: () => false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code: "token_missing", category: "input" });
  });

  test("a TTY stdin is never read", async () => {
    let read = false;
    const error = await runLogin(context(sandbox.env), withToken, {
      readStdin: () => {
        read = true;
        return Promise.resolve("token");
      },
      stdinIsTty: () => true,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "token_missing" });
    expect(read).toBe(false);
  });

  test("imports a trimmed token and returns status with refreshed sites", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, scope: "read:me" });
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse([{ id: "c1", url: "https://acme.atlassian.net", name: "Acme", scopes: [] }]),
    );
    const result = await runLogin(context(sandbox.env), withToken, {
      readStdin: () => Promise.resolve(`${token}\n`),
      stdinIsTty: () => false,
      fetch,
    });
    expect(result.sites).toEqual([{ host: "acme.atlassian.net", name: "Acme", cloudId: "c1" }]);
    expect(result.status.loggedIn).toBe(true);
    expect(result.status.source).toBe("stored");
    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect((await authStatus({ env: sandbox.env })).loggedIn).toBe(true);
  });
});

describe("auth status", () => {
  const statusSpec = authCommands.find((spec) => spec.name === "auth.status");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const scope = "read:me read:jira-work";

  function runStatus(overrides: { full?: boolean } = {}): Promise<unknown> {
    if (statusSpec === undefined) {
      throw new Error("missing auth.status");
    }
    const env = { ...sandbox.env, ATL_ACCESS_TOKEN: makeJwt({ exp, scope }) };
    return statusSpec.run(context(env, overrides), { args: {}, rest: [], flags: {} });
  }

  test("compact: scopes are one string, no claims, no sub-second timestamps", async () => {
    const result = await runStatus();
    expect(result).toMatchObject({ loggedIn: true, source: "env", scopes: scope });
    expect(result).not.toHaveProperty("claims");
    expect(result).not.toHaveProperty("resource");
    expect(JSON.stringify(result)).not.toMatch(/T\d\d:\d\d:\d\d\.\d/);
  });

  test("--full returns the raw status with scopes as an array", async () => {
    const result = await runStatus({ full: true });
    expect(result).toMatchObject({ loggedIn: true, scopes: ["read:me", "read:jira-work"] });
    expect(result).toHaveProperty("resource");
  });
});
