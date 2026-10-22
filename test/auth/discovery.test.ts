import { describe, expect, test } from "bun:test";
import {
  authServerMetadataUrl,
  discover,
  protectedResourceMetadataUrl,
} from "../../src/auth/discovery.ts";
import { USER_AGENT } from "../../src/version.ts";
import {
  ENDPOINTS,
  fakeFetch,
  ISSUER,
  jsonResponse,
  metadataResponse,
  RESOURCE,
  SCOPES,
} from "./helpers.ts";

describe("discovery", () => {
  test("derives RFC 9728 and RFC 8414 well-known URLs", () => {
    expect(protectedResourceMetadataUrl("https://mcp.atlassian.com/v1/mcp/authv2")).toBe(
      "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2",
    );
    expect(authServerMetadataUrl("https://auth.atlassian.com/abc/")).toBe(
      "https://auth.atlassian.com/abc/.well-known/oauth-authorization-server",
    );
  });

  test("returns endpoints, issuer and advertised scopes, sending the atl User-Agent", async () => {
    const fake = fakeFetch((call) => metadataResponse(call) ?? new Response("", { status: 404 }));
    const result = await discover({ resource: RESOURCE, fetch: fake.fetch });
    expect(result).toEqual({
      resource: RESOURCE,
      issuer: ISSUER,
      endpoints: ENDPOINTS,
      scopesSupported: SCOPES,
    });
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.headers.get("User-Agent")).toBe(USER_AGENT);
    }
  });

  test("rejects metadata that describes a different resource", async () => {
    const fake = fakeFetch(
      (call) =>
        metadataResponse(call, { resource: "https://evil.test/mcp" }) ??
        new Response("", { status: 404 }),
    );
    await expect(discover({ resource: RESOURCE, fetch: fake.fetch })).rejects.toMatchObject({
      code: "discovery_failed",
      category: "auth",
    });
  });

  test("rejects an auth server whose issuer differs from the advertised one", async () => {
    const fake = fakeFetch(
      (call) =>
        metadataResponse(call, { issuer: "https://other.test" }) ??
        new Response("", { status: 404 }),
    );
    await expect(discover({ resource: RESOURCE, fetch: fake.fetch })).rejects.toMatchObject({
      code: "discovery_failed",
    });
  });

  test("rejects non-https endpoints and servers without S256", async () => {
    const insecure = fakeFetch((call) => {
      if (call.url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: "http://auth.example.test/authorize",
          token_endpoint: ENDPOINTS.token,
        });
      }
      return metadataResponse(call) ?? new Response("", { status: 404 });
    });
    await expect(discover({ resource: RESOURCE, fetch: insecure.fetch })).rejects.toMatchObject({
      code: "discovery_failed",
    });

    const noPkce = fakeFetch((call) => {
      if (call.url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: ENDPOINTS.authorization,
          token_endpoint: ENDPOINTS.token,
          code_challenge_methods_supported: ["plain"],
        });
      }
      return metadataResponse(call) ?? new Response("", { status: 404 });
    });
    await expect(discover({ resource: RESOURCE, fetch: noPkce.fetch })).rejects.toMatchObject({
      code: "discovery_failed",
    });
  });

  test("malformed metadata is an auth error; 429 and network failures are transient", async () => {
    const malformed = fakeFetch(() => jsonResponse({ resource: RESOURCE }));
    await expect(discover({ resource: RESOURCE, fetch: malformed.fetch })).rejects.toMatchObject({
      code: "discovery_failed",
      category: "auth",
    });

    const limited = fakeFetch(() => new Response("slow down", { status: 429 }));
    await expect(discover({ resource: RESOURCE, fetch: limited.fetch })).rejects.toMatchObject({
      code: "http_429",
      category: "transient",
      status: 429,
    });

    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(discover({ resource: RESOURCE, fetch: down.fetch })).rejects.toMatchObject({
      code: "network_error",
      category: "transient",
    });
  });
});
