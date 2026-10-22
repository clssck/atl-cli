import { Type } from "../core/schema.ts";
import { AtlError } from "../core/errors.ts";
import type { Discovery } from "./discovery.ts";
import type { FetchLike } from "../core/http.ts";
import { readJson, responseError, send } from "./http.ts";
import type { StoredClient, StoredCredentials } from "./store.ts";

const RegistrationResponse = Type.Object({
  client_id: Type.String({ minLength: 1 }),
  client_secret: Type.Optional(Type.String()),
});

export interface RegisterOptions {
  registrationEndpoint: string;
  redirectUri: string;
  /** Space-separated scopes, sent as RFC 7591 `scope` the way omp does. */
  scope?: string | undefined;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
}

/** RFC 7591 registration with the same metadata omp sends, under the name "atl". */
export async function registerClient(options: RegisterOptions): Promise<StoredClient> {
  const body: Record<string, unknown> = {
    client_name: "atl",
    redirect_uris: [options.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };
  const scope = options.scope?.trim();
  if (scope) {
    body.scope = scope;
  }

  const what = "Client registration";
  const response = await send(
    options.registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    { fetch: options.fetch, signal: options.signal, what },
  );
  if (!response.ok) {
    throw await responseError(response, what, "registration_failed");
  }
  const data = await readJson(response, RegistrationResponse, what, "registration_failed");
  const client: StoredClient = {
    clientId: data.client_id.trim(),
    redirectUri: options.redirectUri,
    registeredAt: Date.now(),
  };
  if (data.client_secret?.trim()) {
    client.clientSecret = data.client_secret;
  }
  return client;
}

export interface EnsureClientOptions {
  stored: StoredCredentials | undefined;
  discovery: Discovery;
  redirectUri: string;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Reuses the stored registration when it was made for the same redirect URI and issuer;
 * otherwise registers a new client. `registered` tells the caller whether to persist.
 */
export async function ensureClient(
  options: EnsureClientOptions,
): Promise<{ client: StoredClient; registered: boolean }> {
  const { stored, discovery, redirectUri } = options;
  const existing = stored?.client;
  if (existing && existing.redirectUri === redirectUri && stored.issuer === discovery.issuer) {
    return { client: existing, registered: false };
  }
  const registrationEndpoint = discovery.endpoints.registration;
  if (!registrationEndpoint) {
    throw new AtlError("Authorization server does not advertise a registration endpoint", {
      code: "registration_unsupported",
      category: "auth",
    });
  }
  const client = await registerClient({
    registrationEndpoint,
    redirectUri,
    scope: discovery.scopesSupported.join(" "),
    fetch: options.fetch,
    signal: options.signal,
  });
  return { client, registered: true };
}
