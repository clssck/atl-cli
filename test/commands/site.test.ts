import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Static } from "../../src/core/schema.ts";
import type { CommandInput } from "../../src/core/cli.ts";
import { isRecord } from "../../src/core/guards.ts";
import { makeContext as context } from "../helpers/context.ts";
import { loadConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import type { ApiFlags, SitesFlags } from "../../src/commands/site.ts";
import { runApi, runDoctor, runSites, runWhoami } from "../../src/commands/site.ts";
import { DEFAULT_RESOURCE } from "../../src/auth/index.ts";
import {
  createSandbox,
  fakeFetch,
  jsonResponse,
  makeJwt,
  metadataResponse,
  type RecordedCall,
  type Sandbox,
} from "../auth/helpers.ts";

const CLOUD_ID = "11111111-aaaa-bbbb-cccc-222222222222";
const SITE = {
  cloudId: CLOUD_ID,
  name: "Acme",
  url: "https://acme.atlassian.net",
  scopes: ["read:jira-work"],
  cachedAt: "2026-01-01T00:00:00.000Z",
};

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(() => sandbox.cleanup());

function configDir(): string {
  const dir = sandbox.env.ATL_CONFIG_DIR;
  if (dir === undefined) {
    throw new Error("sandbox has no ATL_CONFIG_DIR");
  }
  return dir;
}

async function seedConfig(config: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(join(configDir(), "config.json"), JSON.stringify(config));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected an object");
  }
  return value;
}

function sitesInput(flags: Static<typeof SitesFlags>): CommandInput<typeof SitesFlags> {
  return { args: {}, rest: [], flags };
}

/** doctor probes the default MCP resource; the helper serves its documents under example.test. */
function discoveryResponse(call: RecordedCall): Response | undefined {
  return metadataResponse(
    { ...call, url: call.url.replace("https://mcp.atlassian.com/", "https://mcp.example.test/") },
    { resource: DEFAULT_RESOURCE },
  );
}

function loggedIn(): NodeJS.ProcessEnv {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { ...sandbox.env, ATL_ACCESS_TOKEN: makeJwt({ exp, scope: "read:me" }) };
}

function apiInput(
  method: string,
  path: string,
  flags: Static<typeof ApiFlags> = {},
): CommandInput<typeof ApiFlags> {
  return { args: { method, path }, rest: [], flags };
}

async function rejection(promise: Promise<unknown>): Promise<AtlError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AtlError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected rejection");
}

describe("doctor", () => {
  test("logged out: exit-0 report with a login step and no authenticated probes", async () => {
    const { fetch, calls } = fakeFetch((call) => discoveryResponse(call) ?? jsonResponse({}, 404));
    const report = asRecord(await runDoctor(context(sandbox.env), { fetch }));
    expect(report.auth).toMatchObject({ loggedIn: false, source: "missing" });
    expect(report.site).toEqual({ error: "not_logged_in", hint: "Run `atl auth login`." });
    expect(report.missing).toContainEqual({ step: "Log in", next: ["atl", "auth", "login"] });
    expect(report.ok).toBe(false);
    expect(report.probes).toBeUndefined();
    expect(report.auth).not.toHaveProperty("resource");
    expect(calls.every((call) => !call.headers.has("Authorization"))).toBe(true);

    const full = asRecord(await runDoctor(context(sandbox.env, { full: true }), { fetch }));
    expect(asRecord(full.probes).me).toEqual({ ok: false, code: "skipped_not_logged_in" });
    expect(full.auth).toHaveProperty("resource");
  });

  test("reports an unreachable auth server without throwing", async () => {
    const { fetch } = fakeFetch(() => new Response("down", { status: 503 }));
    const report = await runDoctor(context(sandbox.env), { fetch });
    expect(report).toMatchObject({ ok: false });
    expect(asRecord(asRecord(report).probes).authServer).toBeDefined();
    expect(asRecord(report).probes).not.toHaveProperty("me");
    expect(asRecord(report).missing).toContainEqual(
      expect.objectContaining({ next: expect.arrayContaining(["--with-token"]) }),
    );
  });

  test("logged in: probes me, confluence and jira on the resolved site", async () => {
    await seedConfig({ sites: { "acme.atlassian.net": SITE } });
    const { fetch, calls } = fakeFetch(
      (call) => discoveryResponse(call) ?? jsonResponse({ results: [] }),
    );
    const report = await runDoctor(context(loggedIn()), { fetch });
    expect(asRecord(report).site).toEqual({ host: "acme.atlassian.net", cloudId: CLOUD_ID });
    expect(report).toMatchObject({ ok: true });
    expect(report).not.toHaveProperty("probes");
    expect(report).not.toHaveProperty("missing");
    const urls = calls.map((call) => call.url);
    expect(urls).toContain("https://api.atlassian.com/me");
    expect(urls).toContain(
      `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces?limit=1`,
    );
    expect(urls).toContain(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/project/search?maxResults=1`,
    );
  });
});

describe("sites", () => {
  const resources = [
    { id: CLOUD_ID, url: "https://acme.atlassian.net", name: "Acme", scopes: ["read:jira-work"] },
    { id: "33333333-aaaa-bbbb-cccc-444444444444", url: "https://beta.atlassian.net", name: "Beta" },
  ];
  const handler = () => jsonResponse(resources);

  test("lists sites with the default flag", async () => {
    await seedConfig({ defaultSite: "beta.atlassian.net" });
    const { fetch, calls } = fakeFetch(handler);
    const result = await runSites(context(loggedIn()), sitesInput({}), { fetch });
    expect(calls[0]?.url).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect(result).toEqual({
      items: [
        { host: "acme.atlassian.net", name: "Acme", cloudId: CLOUD_ID },
        {
          host: "beta.atlassian.net",
          name: "Beta",
          cloudId: "33333333-aaaa-bbbb-cccc-444444444444",
          default: true,
        },
      ],
    });
  });

  test("--full keeps url, scopes and the raw list shape", async () => {
    await seedConfig({ defaultSite: "beta.atlassian.net" });
    const { fetch } = fakeFetch(handler);
    const result = await runSites(context(loggedIn(), { full: true }), sitesInput({}), { fetch });
    expect(result).toMatchObject({
      items: [
        {
          host: "acme.atlassian.net",
          url: "https://acme.atlassian.net",
          scopes: ["read:jira-work"],
          default: false,
        },
        { host: "beta.atlassian.net", scopes: [], default: true },
      ],
      nextCursor: null,
    });
  });

  test("--default persists a known site (by short name) and rejects unknown ones", async () => {
    const env = loggedIn();
    const { fetch } = fakeFetch(handler);
    await runSites(context(env), sitesInput({ default: "acme" }), { fetch });
    expect((await loadConfig(env)).defaultSite).toBe("acme.atlassian.net");

    const error = await rejection(
      runSites(context(env), sitesInput({ default: "nope.atlassian.net" }), { fetch }),
    );
    expect(error.code).toBe("unknown_site");
    expect(error.category).toBe("input");
    expect((await loadConfig(env)).defaultSite).toBe("acme.atlassian.net");
  });
});

describe("whoami", () => {
  const me = {
    account_id: "712020:abc",
    name: "Ada",
    email: "ada@example.com",
    nickname: "ada",
    account_status: "active",
    picture: "https://avatar.example/ada.png",
  };

  test("compacts the /me payload", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(me));
    const result = await runWhoami(context(loggedIn()), { fetch });
    expect(calls[0]?.url).toBe("https://api.atlassian.com/me");
    expect(result).toEqual({
      accountId: "712020:abc",
      name: "Ada",
      email: "ada@example.com",
      nickname: "ada",
      accountStatus: "active",
    });
  });

  test("--full returns the raw object", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(me));
    expect(await runWhoami(context(loggedIn(), { full: true }), { fetch })).toEqual(me);
  });
});

describe("api", () => {
  beforeEach(() => seedConfig({ sites: { "acme.atlassian.net": SITE } }));

  test("routes /wiki, /rest and /me to the right base with query params", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const ctx = context(loggedIn());
    await runApi(
      ctx,
      apiInput("get", "/wiki/api/v2/spaces", { query: ["limit=1", "type=a", "type=b"] }),
      {
        fetch,
      },
    );
    await runApi(ctx, apiInput("GET", "/rest/api/3/myself"), { fetch });
    await runApi(ctx, apiInput("GET", "/me"), { fetch });
    await runApi(
      ctx,
      apiInput("GET", "https://api.atlassian.com/oauth/token/accessible-resources"),
      {
        fetch,
      },
    );
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces?limit=1&type=a&type=b`,
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`,
      "https://api.atlassian.com/me",
      "https://api.atlassian.com/oauth/token/accessible-resources",
    ]);
  });

  test("rejects foreign hosts and unroutable paths before sending anything", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    const ctx = context(loggedIn());
    const foreign = await rejection(
      runApi(ctx, apiInput("GET", "https://evil.example.com/me"), { fetch }),
    );
    expect(foreign.code).toBe("foreign_host");
    const lookalike = await rejection(
      runApi(ctx, apiInput("GET", "https://api.atlassian.com.evil.example/me"), { fetch }),
    );
    expect(lookalike.code).toBe("foreign_host");
    const bad = await rejection(runApi(ctx, apiInput("GET", "/other"), { fetch }));
    expect(bad.code).toBe("invalid_path");
    expect(calls).toHaveLength(0);
  });

  test("non-GET without --yes needs confirmation and points at --plan", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    const error = await rejection(
      runApi(
        context(loggedIn()),
        apiInput("POST", "/rest/api/3/issue", { query: ["a=b"], bodyFile: "b.json" }),
        { fetch, readFile: () => Promise.resolve("{}") },
      ),
    );
    expect(error.code).toBe("confirmation_required");
    expect(error.next).toEqual([
      [
        "atl",
        "api",
        "POST",
        "/rest/api/3/issue",
        "--query",
        "a=b",
        "--body-file",
        "b.json",
        "--plan",
      ],
    ]);
    expect(calls).toHaveLength(0);
  });

  test("--plan returns a plan with body digest and sends no request", async () => {
    const body = JSON.stringify({ fields: { summary: "x".repeat(600) } });
    const { fetch, calls } = fakeFetch(() => jsonResponse({}));
    const plan = await runApi(
      context(loggedIn(), { plan: true }),
      apiInput("POST", "/rest/api/3/issue", { bodyFile: "b.json" }),
      { fetch, readFile: () => Promise.resolve(body) },
    );
    const { body: planBody, ...planRest } = asRecord(plan);
    expect(calls).toHaveLength(0);
    expect(planRest).toMatchObject({
      type: "plan",
      method: "POST",
      url: `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue`,
    });
    expect(planBody).toMatchObject({
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      preview: body.slice(0, 500),
    });
    expect(planRest.next).toEqual([
      ["atl", "api", "POST", "/rest/api/3/issue", "--body-file", "b.json", "--yes"],
    ]);
  });

  test("--yes sends the JSON body", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ id: "10" }, 201));
    const result = await runApi(
      context(loggedIn()),
      apiInput("POST", "/rest/api/3/issue", { yes: true, bodyFile: "b.json" }),
      { fetch, readFile: () => Promise.resolve('{"a":1}') },
    );
    expect(result).toEqual({ id: "10" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.json).toEqual({ a: 1 });
  });

  test("invalid body JSON and unknown methods are input errors", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({}));
    const ctx = context(loggedIn());
    const body = await rejection(
      runApi(ctx, apiInput("PUT", "/rest/x", { yes: true, bodyFile: "b" }), {
        fetch,
        readFile: () => Promise.resolve("{nope"),
      }),
    );
    expect(body.code).toBe("invalid_body");
    const method = await rejection(runApi(ctx, apiInput("TRACE", "/me"), { fetch }));
    expect(method.code).toBe("invalid_method");
  });
});
