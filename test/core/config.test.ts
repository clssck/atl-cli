import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type AtlConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";

let root: string;
let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-config-test-"));
  configDir = join(root, "nested", "atl");
  env = { ATL_CONFIG_DIR: configDir };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sample: AtlConfig = {
  defaultSite: "acme.atlassian.net",
  sites: {
    "acme.atlassian.net": {
      cloudId: "be9e333b-6799-49ef-a7c7-8f6bbaf413d1",
      name: "acme",
      url: "https://acme.atlassian.net",
      scopes: ["read:page:confluence"],
      cachedAt: "2026-10-21T10:00:00Z",
    },
  },
};

describe("config", () => {
  test("missing file loads as empty config", async () => {
    expect(await loadConfig(env)).toEqual({});
  });

  test("save then load round-trips; dir is 0700, file 0600, no tmp files left", async () => {
    await saveConfig(sample, env);
    expect(await loadConfig(env)).toEqual(sample);

    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(configDir, "config.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(configDir)).toEqual(["config.json"]);
  });

  test("save overwrites an existing config", async () => {
    await saveConfig(sample, env);
    await saveConfig({ defaultSite: "other" }, env);
    expect(await loadConfig(env)).toEqual({ defaultSite: "other" });
  });

  test("invalid JSON is a config error", async () => {
    await saveConfig({}, env);
    await writeFile(join(configDir, "config.json"), "{not json");
    const error = await loadConfig(env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ category: "config", code: "config_malformed" });
  });

  test("wrong shape is a config error naming the location", async () => {
    await saveConfig({}, env);
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ sites: { "a.atlassian.net": { cloudId: 5 } } }),
    );
    const error = await loadConfig(env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({
      category: "config",
      message: expect.stringContaining("/sites/"),
    });
  });
});
