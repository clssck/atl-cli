import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { credentialsPath } from "../../src/core/paths.ts";
import { deleteCredentials, readCredentials, writeCredentials } from "../../src/auth/store.ts";
import { AtlError } from "../../src/core/errors.ts";
import { createSandbox, credentials, type Sandbox } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(() => sandbox.cleanup());

describe("credential store", () => {
  test("round-trips credentials", async () => {
    const creds = credentials({
      token: { accessToken: "a", refreshToken: "r", expiresAt: 5, scope: "x y", obtainedAt: 1 },
    });
    await writeCredentials(creds, sandbox.env);
    expect(await readCredentials(sandbox.env)).toEqual(creds);
  });

  test.skipIf(process.platform === "win32")("file is 0600 and directory 0700", async () => {
    await writeCredentials(credentials(), sandbox.env);
    expect((await stat(credentialsPath(sandbox.env))).mode & 0o777).toBe(0o600);
    expect((await stat(sandbox.configDir)).mode & 0o777).toBe(0o700);
  });

  test("missing file reads as undefined; delete is idempotent", async () => {
    expect(await readCredentials(sandbox.env)).toBeUndefined();
    await deleteCredentials(sandbox.env);
    await writeCredentials(credentials(), sandbox.env);
    await deleteCredentials(sandbox.env);
    expect(await readCredentials(sandbox.env)).toBeUndefined();
  });

  test("corrupt content is a config error that does not echo the contents", async () => {
    await writeCredentials(credentials(), sandbox.env);
    await writeFile(credentialsPath(sandbox.env), '{"version":1,"resource":5,"secret":"hunter2"}');
    const error = await readCredentials(sandbox.env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code: "credentials_corrupt" });
    expect(error instanceof Error ? error.message : "").not.toContain("hunter2");
  });

  test("overwrite leaves no temp files behind", async () => {
    await writeCredentials(credentials(), sandbox.env);
    await writeCredentials(credentials({ resource: "https://other" }), sandbox.env);
    const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: sandbox.configDir }));
    expect(entries).toEqual(["credentials.json"]);
  });
});
