import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../../src/core/http.ts";
import type { StoredCredentials } from "../../src/auth/store.ts";

export interface Sandbox {
  dir: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "atl-auth-"));
  const configDir = join(dir, "cfg");
  return {
    dir,
    configDir,
    env: { ATL_CONFIG_DIR: configDir },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Narrows away null/undefined, failing the test with `what` when the value is absent. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function makeJwt(payload: Record<string, unknown>): string {
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.signature`;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  form: URLSearchParams;
  json: unknown;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
}

export function fakeFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    let json: unknown;
    if (headers.get("Content-Type")?.includes("json")) {
      json = JSON.parse(body);
    }
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers,
      form: headers.get("Content-Type")?.includes("x-www-form-urlencoded")
        ? new URLSearchParams(body)
        : new URLSearchParams(),
      json,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const ENDPOINTS = {
  authorization: "https://auth.example.test/authorize",
  token: "https://auth.example.test/oauth/token",
  registration: "https://auth.example.test/dcr/register",
  revocation: "https://auth.example.test/oauth/revoke",
};

export const RESOURCE = "https://mcp.example.test/v1/mcp/authv2";
export const ISSUER = "https://auth.example.test/tenant";

export function credentials(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    version: 1,
    resource: RESOURCE,
    issuer: ISSUER,
    endpoints: ENDPOINTS,
    client: {
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "http://localhost:47923/callback",
      registeredAt: 1,
    },
    ...overrides,
  };
}

export const SCOPES = ["read:me", "offline_access", "read:jira-work"];

/** Serves the two public discovery documents for RESOURCE/ISSUER; undefined for any other URL. */
export function metadataResponse(
  call: RecordedCall,
  overrides: { resource?: string; issuer?: string } = {},
): Response | undefined {
  if (call.url === "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp/authv2") {
    return jsonResponse({
      resource: overrides.resource ?? RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: SCOPES,
    });
  }
  if (call.url === `${ISSUER}/.well-known/oauth-authorization-server`) {
    return jsonResponse({
      issuer: overrides.issuer ?? ISSUER,
      authorization_endpoint: ENDPOINTS.authorization,
      token_endpoint: ENDPOINTS.token,
      registration_endpoint: ENDPOINTS.registration,
      revocation_endpoint: ENDPOINTS.revocation,
      code_challenge_methods_supported: ["S256"],
    });
  }
  return undefined;
}
