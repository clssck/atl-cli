import { Type, type Static, type TSchema } from "../core/schema.ts";
import { AtlError } from "../core/errors.ts";
import type { FetchLike } from "../core/http.ts";
import { readJson, responseError, send } from "./http.ts";

/** Atlassian Remote MCP v1 resource; a future v2/3LO mode passes a different resource URL. */
export const DEFAULT_RESOURCE = "https://mcp.atlassian.com/v1/mcp/authv2";

export interface AuthEndpoints {
  authorization: string;
  token: string;
  registration?: string;
  revocation?: string;
}

export interface Discovery {
  /** Resource identifier as advertised by the protected-resource metadata (RFC 8707 `resource`). */
  resource: string;
  issuer: string;
  endpoints: AuthEndpoints;
  /** Scopes the resource advertises; omp requests exactly this set. */
  scopesSupported: string[];
}

const ProtectedResourceMetadata = Type.Object({
  resource: Type.String({ minLength: 1 }),
  authorization_servers: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  scopes_supported: Type.Optional(Type.Array(Type.String())),
});

const AuthServerMetadata = Type.Object({
  issuer: Type.String({ minLength: 1 }),
  authorization_endpoint: Type.String({ minLength: 1 }),
  token_endpoint: Type.String({ minLength: 1 }),
  registration_endpoint: Type.Optional(Type.String({ minLength: 1 })),
  revocation_endpoint: Type.Optional(Type.String({ minLength: 1 })),
  code_challenge_methods_supported: Type.Optional(Type.Array(Type.String())),
});
type AuthServerMetadata = Static<typeof AuthServerMetadata>;

export interface DiscoveryOptions {
  resource?: string | undefined;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
}

/** RFC 9728 §3.1: well-known segment inserted between the origin and the resource path. */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

export function authServerMetadataUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
}

async function fetchMetadata<S extends TSchema>(
  url: string,
  schema: S,
  what: string,
  options: DiscoveryOptions,
): Promise<Static<S>> {
  const response = await send(
    url,
    { headers: { Accept: "application/json" } },
    { ...options, what },
  );
  if (!response.ok) {
    throw await responseError(response, what, "discovery_failed");
  }
  return readJson(response, schema, what, "discovery_failed");
}

function assertEndpointUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AtlError(`Auth server metadata has an invalid ${name}`, {
      code: "discovery_failed",
      category: "auth",
    });
  }
  if (parsed.protocol !== "https:") {
    throw new AtlError(`Auth server ${name} must use https`, {
      code: "discovery_failed",
      category: "auth",
    });
  }
}

function toEndpoints(metadata: AuthServerMetadata): AuthEndpoints {
  assertEndpointUrl("authorization_endpoint", metadata.authorization_endpoint);
  assertEndpointUrl("token_endpoint", metadata.token_endpoint);
  const endpoints: AuthEndpoints = {
    authorization: metadata.authorization_endpoint,
    token: metadata.token_endpoint,
  };
  if (metadata.registration_endpoint) {
    assertEndpointUrl("registration_endpoint", metadata.registration_endpoint);
    endpoints.registration = metadata.registration_endpoint;
  }
  if (metadata.revocation_endpoint) {
    assertEndpointUrl("revocation_endpoint", metadata.revocation_endpoint);
    endpoints.revocation = metadata.revocation_endpoint;
  }
  return endpoints;
}

/** Protected-resource metadata, then the first advertised authorization server's metadata. */
export async function discover(options: DiscoveryOptions = {}): Promise<Discovery> {
  const requested = options.resource ?? DEFAULT_RESOURCE;
  const resourceMeta = await fetchMetadata(
    protectedResourceMetadataUrl(requested),
    ProtectedResourceMetadata,
    "Protected-resource discovery",
    options,
  );
  if (resourceMeta.resource !== requested) {
    throw new AtlError(
      `Protected-resource metadata describes ${resourceMeta.resource}, expected ${requested}`,
      { code: "discovery_failed", category: "auth" },
    );
  }

  const issuer = resourceMeta.authorization_servers[0];
  if (issuer === undefined) {
    throw new AtlError("Protected-resource metadata lists no authorization server", {
      code: "discovery_failed",
      category: "auth",
    });
  }
  const serverMeta = await fetchMetadata(
    authServerMetadataUrl(issuer),
    AuthServerMetadata,
    "Authorization-server discovery",
    options,
  );
  if (serverMeta.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new AtlError(
      `Authorization server reports issuer ${serverMeta.issuer}, expected ${issuer}`,
      {
        code: "discovery_failed",
        category: "auth",
      },
    );
  }
  const methods = serverMeta.code_challenge_methods_supported;
  if (methods !== undefined && !methods.includes("S256")) {
    throw new AtlError("Authorization server does not support PKCE S256", {
      code: "discovery_failed",
      category: "auth",
    });
  }

  return {
    resource: resourceMeta.resource,
    issuer: serverMeta.issuer,
    endpoints: toEndpoints(serverMeta),
    scopesSupported: resourceMeta.scopes_supported ?? [],
  };
}
