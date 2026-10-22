import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  authStatus,
  getAccessToken,
  importToken,
  login,
  logout,
  refresh,
} from "../../src/auth/index.ts";
import { codeChallengeS256 } from "../../src/auth/pkce.ts";
import { readCredentials, type StoredToken, writeCredentials } from "../../src/auth/store.ts";
import { USER_AGENT } from "../../src/version.ts";
import {
  createSandbox,
  credentials,
  ENDPOINTS,
  fakeFetch,
  jsonResponse,
  makeJwt,
  metadataResponse,
  present,
  type RecordedCall,
  type Sandbox,
} from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(() => sandbox.cleanup());

const LOGIN_NEXT = [["atl", "auth", "login"]];

async function seed(token: {
  accessToken?: string;
  refreshToken?: string | null;
  expiresInMs: number;
}) {
  const stored: StoredToken = {
    accessToken: token.accessToken ?? "access-1",
    expiresAt: Date.now() + token.expiresInMs,
    scope: "read:me offline_access",
    obtainedAt: Date.now(),
  };
  if (token.refreshToken !== null) {
    stored.refreshToken = token.refreshToken ?? "refresh-1";
  }
  await writeCredentials(credentials({ token: stored }), sandbox.env);
}

/** Token endpoint that enforces rotation: each refresh token is accepted once. */
function rotatingTokenEndpoint(initial = "refresh-1") {
  let current = initial;
  let counter = 1;
  return fakeFetch((call) => {
    if (call.url !== ENDPOINTS.token) {
      return new Response("", { status: 404 });
    }
    if (call.form.get("refresh_token") !== current) {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    counter++;
    current = `refresh-${counter}`;
    return jsonResponse({
      access_token: `access-${counter}`,
      refresh_token: current,
      expires_in: 28800,
      scope: "read:me",
    });
  });
}

describe("getAccessToken", () => {
  test("returns the stored token without network when it is fresh", async () => {
    await seed({ expiresInMs: 3_600_000 });
    const fake = fakeFetch(() => new Response("", { status: 500 }));
    expect(await getAccessToken({ env: sandbox.env, fetch: fake.fetch })).toBe("access-1");
    expect(fake.calls).toHaveLength(0);
  });

  test("refreshes an expiring token and persists the rotated refresh token", async () => {
    await seed({ expiresInMs: 30_000 });
    const fake = rotatingTokenEndpoint();
    expect(await getAccessToken({ env: sandbox.env, fetch: fake.fetch })).toBe("access-2");

    const call = present(fake.calls[0], "refresh call");
    expect(Object.fromEntries(call.form)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-1",
      client_secret: "secret-1",
      resource: "https://mcp.example.test/v1/mcp/authv2",
    });
    expect(call.headers.get("User-Agent")).toBe(USER_AGENT);
    expect(call.headers.has("Authorization")).toBe(false);

    const stored = await readCredentials(sandbox.env);
    expect(stored?.token).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      scope: "read:me",
    });
    expect(stored?.token?.expiresAt).toBeGreaterThan(Date.now() + 28_000_000);
    expect(stored?.client?.clientId).toBe("client-1");
  });

  test("a response without a new refresh token keeps the previous one", async () => {
    await seed({ expiresInMs: 1000 });
    const fake = fakeFetch(() => jsonResponse({ access_token: "access-2", expires_in: 3600 }));
    await getAccessToken({ env: sandbox.env, fetch: fake.fetch });
    expect((await readCredentials(sandbox.env))?.token?.refreshToken).toBe("refresh-1");
  });

  test("minTtlSeconds controls when a refresh happens", async () => {
    await seed({ expiresInMs: 600_000 });
    const fake = rotatingTokenEndpoint();
    expect(await getAccessToken({ env: sandbox.env, fetch: fake.fetch })).toBe("access-1");
    expect(await getAccessToken({ env: sandbox.env, fetch: fake.fetch, minTtlSeconds: 900 })).toBe(
      "access-2",
    );
    expect(fake.calls).toHaveLength(1);
  });

  test("concurrent calls in one process refresh exactly once", async () => {
    await seed({ expiresInMs: 10_000 });
    const fake = rotatingTokenEndpoint();
    const tokens = await Promise.all(
      [1, 2, 3].map(() => getAccessToken({ env: sandbox.env, fetch: fake.fetch })),
    );
    expect(tokens).toEqual(["access-2", "access-2", "access-2"]);
    expect(fake.calls).toHaveLength(1);
  });

  test("ATL_ACCESS_TOKEN wins, is trimmed, and is never refreshed or required to be stored", async () => {
    await seed({ expiresInMs: -1000 });
    const fake = fakeFetch(() => new Response("", { status: 500 }));
    const env = { ...sandbox.env, ATL_ACCESS_TOKEN: "  env-token \n" };
    expect(await getAccessToken({ env, fetch: fake.fetch })).toBe("env-token");
    expect(fake.calls).toHaveLength(0);
  });

  test("missing credentials give not_logged_in pointing at `atl auth login`", async () => {
    const error = await getAccessToken({ env: sandbox.env }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "not_logged_in", category: "auth", next: LOGIN_NEXT });
  });

  test("invalid_grant becomes refresh_failed and leaves the store untouched", async () => {
    await seed({ expiresInMs: 1000, refreshToken: "dead" });
    const fake = rotatingTokenEndpoint("different");
    const error = await getAccessToken({ env: sandbox.env, fetch: fake.fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "refresh_failed", category: "auth", next: LOGIN_NEXT });
    expect((await readCredentials(sandbox.env))?.token?.refreshToken).toBe("dead");
  });

  test("429 during refresh stays transient instead of claiming the login is dead", async () => {
    await seed({ expiresInMs: 1000 });
    const fake = fakeFetch(() => new Response("", { status: 429 }));
    const error = await getAccessToken({ env: sandbox.env, fetch: fake.fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "http_429", category: "transient" });
  });

  test("a token without refresh token is returned until it expires, then token_expired", async () => {
    await seed({ expiresInMs: 30_000, refreshToken: null });
    expect(await getAccessToken({ env: sandbox.env })).toBe("access-1");
    await seed({ expiresInMs: -1000, refreshToken: null });
    await expect(getAccessToken({ env: sandbox.env })).rejects.toMatchObject({
      code: "token_expired",
      next: LOGIN_NEXT,
    });
  });
});

describe("refresh and logout", () => {
  test("refresh() forces a rotation even when the token is fresh", async () => {
    await seed({ expiresInMs: 3_600_000 });
    const fake = rotatingTokenEndpoint();
    const status = await refresh({ env: sandbox.env, fetch: fake.fetch });
    expect(fake.calls).toHaveLength(1);
    expect(status).toMatchObject({ loggedIn: true, source: "stored", hasRefreshToken: true });
  });

  test("logout deletes the token and keeps the client registration", async () => {
    await seed({ expiresInMs: 3_600_000 });
    const fake = fakeFetch(() => new Response("", { status: 500 }));
    expect(await logout({ env: sandbox.env, fetch: fake.fetch })).toEqual({
      revoked: false,
      hadToken: true,
    });
    const stored = await readCredentials(sandbox.env);
    expect(stored?.token).toBeUndefined();
    expect(stored?.client?.clientId).toBe("client-1");
    expect(fake.calls).toHaveLength(0);
    expect(await logout({ env: sandbox.env })).toEqual({ revoked: false, hadToken: false });
  });

  test("logout --revoke revokes the refresh token before deleting", async () => {
    await seed({ expiresInMs: 3_600_000 });
    const fake = fakeFetch(() => new Response("", { status: 200 }));
    expect(await logout({ env: sandbox.env, fetch: fake.fetch, revoke: true })).toEqual({
      revoked: true,
      hadToken: true,
    });
    expect(fake.calls[0]?.url).toBe(ENDPOINTS.revocation);
    expect(Object.fromEntries(fake.calls[0]?.form ?? [])).toMatchObject({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: "client-1",
    });
    expect((await readCredentials(sandbox.env))?.token).toBeUndefined();
  });

  test("a failed revocation keeps the local token", async () => {
    await seed({ expiresInMs: 3_600_000 });
    const fake = fakeFetch(() => jsonResponse({ error: "server_error" }, 503));
    await expect(
      logout({ env: sandbox.env, fetch: fake.fetch, revoke: true }),
    ).rejects.toMatchObject({
      category: "transient",
    });
    expect((await readCredentials(sandbox.env))?.token?.accessToken).toBe("access-1");
  });
});

describe("importToken and authStatus", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt({
    iss: "https://auth.atlassian.com",
    exp,
    iat: exp - 28800,
    scope: "read:me read:jira-work",
    aud: ["ari:cloud:jira::site/cloud-1"],
    "https://atlassian.com/3lo": true,
  });

  test("imports an access token with expiry from exp and no refresh token", async () => {
    const status = await importToken(jwt, { env: sandbox.env });
    expect(status).toMatchObject({
      loggedIn: true,
      source: "stored",
      hasRefreshToken: false,
      clientRegistered: false,
      scopes: ["read:me", "read:jira-work"],
      claims: {
        iss: "https://auth.atlassian.com",
        threeLo: true,
        firstParty: false,
        audSites: ["cloud-1"],
      },
    });
    expect(status.expiresAt).toBe(new Date(exp * 1000).toISOString());
    expect(await getAccessToken({ env: sandbox.env })).toBe(jwt);
  });

  test("status never exposes secrets", async () => {
    await importToken(jwt, { env: sandbox.env });
    await seed({ expiresInMs: 3_600_000, accessToken: jwt, refreshToken: "super-secret-refresh" });
    const text = JSON.stringify(await authStatus({ env: sandbox.env }));
    for (const secret of [jwt, "super-secret-refresh", "secret-1"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("rejects non-JWT and already-expired tokens", async () => {
    await expect(importToken("plain-opaque", { env: sandbox.env })).rejects.toMatchObject({
      code: "invalid_token",
      category: "input",
    });
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(importToken(stale, { env: sandbox.env })).rejects.toMatchObject({
      code: "token_expired",
    });
  });

  test("status reports missing, env and a registered-but-logged-out client", async () => {
    expect(await authStatus({ env: sandbox.env })).toMatchObject({
      loggedIn: false,
      source: "missing",
      clientRegistered: false,
      scopes: [],
      hasRefreshToken: false,
    });
    expect(await authStatus({ env: { ...sandbox.env, ATL_ACCESS_TOKEN: jwt } })).toMatchObject({
      loggedIn: true,
      source: "env",
      hasRefreshToken: false,
    });
    await writeCredentials(credentials(), sandbox.env);
    expect(await authStatus({ env: sandbox.env })).toMatchObject({
      loggedIn: false,
      clientRegistered: true,
    });
  });

  test("an expired token with a refresh token still counts as logged in", async () => {
    await seed({ expiresInMs: -5000 });
    expect(await authStatus({ env: sandbox.env })).toMatchObject({
      loggedIn: true,
      hasRefreshToken: true,
    });
    expect((await authStatus({ env: sandbox.env })).expiresInSeconds).toBeLessThan(0);
  });
});

function loginFetch(onToken?: (call: RecordedCall) => Response) {
  return fakeFetch((call) => {
    const meta = metadataResponse(call);
    if (meta) {
      return meta;
    }
    if (call.url === ENDPOINTS.registration) {
      return jsonResponse({ client_id: "dcr-client", client_secret: "dcr-secret" }, 201);
    }
    if (call.url === ENDPOINTS.token) {
      return (
        onToken?.(call) ??
        jsonResponse({
          access_token: makeJwt({
            exp: Math.floor(Date.now() / 1000) + 28800,
            scope: "read:me",
            aud: ["ari:cloud:jira::site/c1"],
          }),
          refresh_token: "login-refresh",
          expires_in: 28800,
          scope: "read:me offline_access",
        })
      );
    }
    return new Response("", { status: 404 });
  });
}

/** Plays the browser: hits the loopback redirect with the state the authorize URL carried. */
function browserApproving(urls: string[], extra = "code=auth-code") {
  return async (url: string) => {
    urls.push(url);
    const authorize = new URL(url);
    const redirect = new URL(present(authorize.searchParams.get("redirect_uri"), "redirect_uri"));
    const state = present(authorize.searchParams.get("state"), "state");
    await fetch(`http://127.0.0.1:${redirect.port}${redirect.pathname}?${extra}&state=${state}`);
  };
}

describe("login", () => {
  test("runs discovery, DCR, PKCE, loopback and code exchange, then stores the session", async () => {
    const fake = loginFetch();
    const reported: string[] = [];
    const opened: string[] = [];
    const status = await login({
      env: sandbox.env,
      fetch: fake.fetch,
      port: 0,
      resource: "https://mcp.example.test/v1/mcp/authv2",
      onAuthorizeUrl: (url) => reported.push(url),
      openBrowser: browserApproving(opened),
    });

    expect(opened).toEqual(reported);
    const authorize = new URL(present(reported[0], "reported authorize URL"));
    expect(authorize.origin + authorize.pathname).toBe(ENDPOINTS.authorization);
    expect(authorize.searchParams.get("client_id")).toBe("dcr-client");
    expect(authorize.searchParams.get("scope")).toBe("read:me offline_access read:jira-work");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
    expect(authorize.searchParams.get("resource")).toBe("https://mcp.example.test/v1/mcp/authv2");

    const exchange = present(
      fake.calls.find((c) => c.url === ENDPOINTS.token),
      "token exchange call",
    );
    expect(exchange.form.get("grant_type")).toBe("authorization_code");
    expect(exchange.form.get("code")).toBe("auth-code");
    expect(exchange.form.get("client_secret")).toBe("dcr-secret");
    expect(exchange.form.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
    expect(exchange.form.get("resource")).toBe("https://mcp.example.test/v1/mcp/authv2");
    expect(codeChallengeS256(present(exchange.form.get("code_verifier"), "code_verifier"))).toBe(
      present(authorize.searchParams.get("code_challenge"), "code_challenge"),
    );

    expect(status).toMatchObject({
      loggedIn: true,
      source: "stored",
      hasRefreshToken: true,
      clientRegistered: true,
    });
    const stored = await readCredentials(sandbox.env);
    expect(stored?.token?.refreshToken).toBe("login-refresh");
    expect(stored?.client?.clientId).toBe("dcr-client");
  });

  test("a failing browser launcher is non-fatal; the URL was still reported", async () => {
    const fake = loginFetch();
    const reported: string[] = [];
    const approve = browserApproving([]);
    const status = await login({
      env: sandbox.env,
      fetch: fake.fetch,
      port: 0,
      resource: "https://mcp.example.test/v1/mcp/authv2",
      onAuthorizeUrl: (url) => reported.push(url),
      openBrowser: (url) => {
        void approve(url);
        return Promise.reject(new Error("no browser"));
      },
    });
    expect(status.loggedIn).toBe(true);
    expect(reported).toHaveLength(1);
  });

  test("a consent error keeps the new registration for the next attempt and stores no token", async () => {
    const fake = loginFetch();
    const error = await login({
      env: sandbox.env,
      fetch: fake.fetch,
      port: 0,
      resource: "https://mcp.example.test/v1/mcp/authv2",
      openBrowser: browserApproving([], "error=access_denied"),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "consent_denied" });
    const stored = await readCredentials(sandbox.env);
    expect(stored?.client?.clientId).toBe("dcr-client");
    expect(stored?.token).toBeUndefined();
  });

  test("a rejected code exchange surfaces as an auth error and stores no token", async () => {
    const fake = loginFetch(() =>
      jsonResponse({ error: "invalid_grant", error_description: "bad code" }, 400),
    );
    const error = await login({
      env: sandbox.env,
      fetch: fake.fetch,
      port: 0,
      resource: "https://mcp.example.test/v1/mcp/authv2",
      openBrowser: browserApproving([]),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "token_exchange_failed", category: "auth" });
    expect((await readCredentials(sandbox.env))?.token).toBeUndefined();
  });
});
