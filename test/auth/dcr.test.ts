import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl } from "../../src/auth/authorize.ts";
import { ensureClient } from "../../src/auth/dcr.ts";
import type { Discovery } from "../../src/auth/discovery.ts";
import {
  ENDPOINTS,
  credentials,
  fakeFetch,
  ISSUER,
  jsonResponse,
  present,
  RESOURCE,
  SCOPES,
} from "./helpers.ts";

const discovery: Discovery = {
  resource: RESOURCE,
  issuer: ISSUER,
  endpoints: ENDPOINTS,
  scopesSupported: SCOPES,
};

function registrationFetch() {
  return fakeFetch(() =>
    jsonResponse({ client_id: "new-client", client_secret: "new-secret" }, 201),
  );
}

describe("dynamic client registration", () => {
  test("registers when nothing is stored, with omp's metadata under client_name atl", async () => {
    const fake = registrationFetch();
    const { client, registered } = await ensureClient({
      stored: undefined,
      discovery,
      redirectUri: "http://localhost:47923/callback",
      fetch: fake.fetch,
    });
    expect(registered).toBe(true);
    expect(client).toMatchObject({
      clientId: "new-client",
      clientSecret: "new-secret",
      redirectUri: "http://localhost:47923/callback",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(ENDPOINTS.registration);
    expect(fake.calls[0]?.json).toEqual({
      client_name: "atl",
      redirect_uris: ["http://localhost:47923/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: SCOPES.join(" "),
    });
  });

  test("reuses the stored client when the redirect URI matches", async () => {
    const fake = registrationFetch();
    const stored = credentials();
    const { client, registered } = await ensureClient({
      stored,
      discovery,
      redirectUri: "http://localhost:47923/callback",
      fetch: fake.fetch,
    });
    expect(registered).toBe(false);
    expect(client).toBe(present(stored.client, "stored client"));
    expect(fake.calls).toHaveLength(0);
  });

  test("re-registers when the requested port differs from the stored redirect URI", async () => {
    const fake = registrationFetch();
    const { client, registered } = await ensureClient({
      stored: credentials(),
      discovery,
      redirectUri: "http://localhost:50001/callback",
      fetch: fake.fetch,
    });
    expect(registered).toBe(true);
    expect(client.redirectUri).toBe("http://localhost:50001/callback");
    expect(fake.calls).toHaveLength(1);
  });

  test("a rejected registration is an auth error, and 5xx is transient", async () => {
    const rejected = fakeFetch(() => jsonResponse({ error: "invalid_redirect_uri" }, 400));
    await expect(
      ensureClient({
        stored: undefined,
        discovery,
        redirectUri: "http://localhost:1/callback",
        fetch: rejected.fetch,
      }),
    ).rejects.toMatchObject({ code: "registration_failed", category: "auth" });

    const down = fakeFetch(() => new Response("", { status: 503 }));
    await expect(
      ensureClient({
        stored: undefined,
        discovery,
        redirectUri: "http://localhost:1/callback",
        fetch: down.fetch,
      }),
    ).rejects.toMatchObject({ category: "transient" });
  });

  test("a response without client_id is rejected", async () => {
    const fake = fakeFetch(() => jsonResponse({ client_secret: "x" }));
    await expect(
      ensureClient({
        stored: undefined,
        discovery,
        redirectUri: "http://localhost:1/callback",
        fetch: fake.fetch,
      }),
    ).rejects.toMatchObject({ code: "registration_failed" });
  });
});

describe("authorize URL", () => {
  test("carries omp's parameter set, with prompt=consent for offline_access and no audience", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: ENDPOINTS.authorization,
        clientId: "client-1",
        scope: "read:me offline_access",
        resource: RESOURCE,
        redirectUri: "http://localhost:47923/callback",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect([...url.searchParams.keys()]).toEqual([
      "response_type",
      "client_id",
      "scope",
      "prompt",
      "resource",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("audience")).toBe(false);
  });

  test("omits prompt without offline_access and scope when none is advertised", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: ENDPOINTS.authorization,
        clientId: "c",
        scope: "",
        resource: RESOURCE,
        redirectUri: "http://localhost:1/callback",
        state: "s",
        codeChallenge: "x",
      }),
    );
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.has("scope")).toBe(false);
  });
});
