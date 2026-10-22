import { Type, type Static } from "../core/schema.ts";
import { AtlError } from "../core/errors.ts";
import type { FetchLike } from "../core/http.ts";
import { formBody, readJson, responseError, send } from "./http.ts";
import { summarizeToken } from "./jwt.ts";
import type { StoredClient, StoredEndpoints, StoredToken } from "./store.ts";

const LOGIN_NEXT = [["atl", "auth", "login"]] as const;

const TokenResponse = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  refresh_token: Type.Optional(Type.String()),
  expires_in: Type.Optional(Type.Number()),
  scope: Type.Optional(Type.String()),
});

const DEFAULT_LIFETIME_SECONDS = 3600;

interface TokenRequestContext {
  endpoints: StoredEndpoints;
  client: StoredClient;
  /** RFC 8707 resource, sent on every token request as omp does. */
  resource: string;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
}

export interface ExchangeCodeOptions extends TokenRequestContext {
  code: string;
  codeVerifier: string;
}

export interface RefreshOptions extends TokenRequestContext {
  refreshToken: string;
  /** Scope to record when the server omits `scope` from the refresh response. */
  previousScope?: string;
}

export interface RevokeOptions extends Omit<TokenRequestContext, "resource" | "endpoints"> {
  revocationEndpoint: string;
  token: string;
  tokenTypeHint: "refresh_token" | "access_token";
}

/** Client credentials go in the form body (client_secret_post), never a Basic header: omp does the same. */
function clientParams(client: StoredClient): Record<string, string | undefined> {
  return { client_id: client.clientId, client_secret: client.clientSecret };
}

function toStoredToken(
  data: Static<typeof TokenResponse>,
  fallbackRefreshToken: string | undefined,
  fallbackScope: string,
): StoredToken {
  const obtainedAt = Date.now();
  const claims = summarizeToken(data.access_token);
  let expiresAt = obtainedAt + DEFAULT_LIFETIME_SECONDS * 1000;
  if (typeof data.expires_in === "number") {
    expiresAt = obtainedAt + data.expires_in * 1000;
  } else if (claims?.exp !== undefined) {
    expiresAt = claims.exp * 1000;
  }

  const token: StoredToken = {
    accessToken: data.access_token,
    expiresAt,
    scope: data.scope ?? (claims?.scopes.length ? claims.scopes.join(" ") : fallbackScope),
    obtainedAt,
  };
  // Atlassian rotates refresh tokens; keep the previous one only if the server sent none.
  const refreshToken =
    data.refresh_token === undefined || data.refresh_token === ""
      ? fallbackRefreshToken
      : data.refresh_token;
  if (refreshToken) {
    token.refreshToken = refreshToken;
  }
  return token;
}

export async function exchangeCode(options: ExchangeCodeOptions): Promise<StoredToken> {
  const what = "Token exchange";
  const response = await send(
    options.endpoints.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: formBody({
        grant_type: "authorization_code",
        code: options.code,
        redirect_uri: options.client.redirectUri,
        client_id: options.client.clientId,
        code_verifier: options.codeVerifier,
        resource: options.resource,
        client_secret: options.client.clientSecret,
      }),
    },
    { fetch: options.fetch, signal: options.signal, what },
  );
  if (!response.ok) {
    throw await responseError(response, what, "token_exchange_failed");
  }
  return toStoredToken(
    await readJson(response, TokenResponse, what, "token_exchange_failed"),
    undefined,
    "",
  );
}

/** The old refresh token is dead once this succeeds; callers must persist the result before releasing the lock. */
export async function refreshAccessToken(options: RefreshOptions): Promise<StoredToken> {
  const what = "Token refresh";
  const response = await send(
    options.endpoints.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: formBody({
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
        ...clientParams(options.client),
        resource: options.resource,
      }),
    },
    { fetch: options.fetch, signal: options.signal, what },
  );
  if (!response.ok) {
    const error = await responseError(response, what, "refresh_failed");
    if (error.category === "transient") {
      throw error;
    }
    throw new AtlError(error.message, {
      code: "refresh_failed",
      category: "auth",
      hint: "The refresh token was rejected; log in again.",
      next: LOGIN_NEXT,
      ...(error.status === undefined ? {} : { status: error.status }),
    });
  }
  const data = await readJson(response, TokenResponse, what, "refresh_failed");
  return toStoredToken(data, options.refreshToken, options.previousScope ?? "");
}

/** RFC 7009 revocation. Throws on any non-2xx so callers can keep the local token. */
export async function revokeToken(options: RevokeOptions): Promise<void> {
  const what = "Token revocation";
  const response = await send(
    options.revocationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: formBody({
        token: options.token,
        token_type_hint: options.tokenTypeHint,
        ...clientParams(options.client),
      }),
    },
    { fetch: options.fetch, signal: options.signal, what },
  );
  if (!response.ok) {
    throw await responseError(response, what, "revoke_failed");
  }
}
