/**
 * atl OAuth: replicates the Atlassian Remote MCP login as omp (oh-my-pi) performs it, because
 * omp's resulting token is proven to work against REST. Findings from
 * oh-my-pi/packages/coding-agent/src/mcp/:
 *
 * - Scopes: the protected-resource metadata's `scopes_supported`, joined by spaces, and nothing
 *   else (oauth-discovery.ts:114-117, 384-387; preferred over the auth server's catalogue at
 *   :520-522, :583-584; passed to the flow at oauth-reauth.ts:808). That set includes
 *   `offline_access`.
 * - `audience`: never sent (grep of mcp/ finds none; the flow builds the URL at
 *   oauth-flow.ts:426-481). The design doc's `audience=api.atlassian.com` was a wrong guess.
 * - `resource` (RFC 8707): the protected-resource metadata's `resource`
 *   (oauth-discovery.ts:522-523, 566); sent on authorize (oauth-flow.ts:454-473), on code
 *   exchange (:510-512) and on refresh (:825-828).
 * - `prompt=consent`: added whenever the scope contains `offline_access` (oauth-flow.ts:443-446).
 * - Authorize parameter set, in order: response_type=code, client_id, scope, prompt=consent,
 *   resource, redirect_uri, state, code_challenge, code_challenge_method=S256
 *   (oauth-flow.ts:429-481). PKCE verifier is 32 random bytes base64url (:563-585).
 * - DCR body (oauth-flow.ts:628-639): client_name, redirect_uris [one], grant_types
 *   [authorization_code, refresh_token], response_types [code], token_endpoint_auth_method "none",
 *   application_type "native", and `scope` (the same scope string). atl differs only in
 *   client_name "atl".
 * - Token endpoint auth: client_secret_post style. `client_id` and, when DCR returned one,
 *   `client_secret` are form body fields; no Authorization header (oauth-flow.ts:499-516,
 *   :821-829). Exchange body: grant_type, code, redirect_uri, client_id, code_verifier, resource,
 *   client_secret. Refresh body: grant_type, refresh_token, client_id, resource, client_secret.
 * - Redirect: `http://localhost:<port>/callback` (oauth-flow.ts:97-98, 202-206).
 *
 * Atlassian rotates refresh tokens: every refresh runs under the cross-process lock in lock.ts
 * and persists the new refresh token before releasing it.
 */
import { AtlError } from "../core/errors.ts";
import { buildAuthorizeUrl } from "./authorize.ts";
import { openInBrowser } from "./browser.ts";
import { ensureClient } from "./dcr.ts";
import { DEFAULT_RESOURCE, discover } from "./discovery.ts";
import type { FetchLike } from "../core/http.ts";
import { summarizeToken } from "./jwt.ts";
import { withRefreshLock } from "./lock.ts";
import { DEFAULT_PORT, LOGIN_TIMEOUT_MS, startCallbackServer } from "./loopback.ts";
import { codeChallengeS256, createCodeVerifier, createState } from "./pkce.ts";
import {
  deleteCredentials,
  readCredentials,
  type StoredCredentials,
  type StoredToken,
  writeCredentials,
} from "./store.ts";
import { exchangeCode, refreshAccessToken, revokeToken } from "./tokens.ts";

export { DEFAULT_RESOURCE } from "./discovery.ts";
export { DEFAULT_PORT } from "./loopback.ts";

const LOGIN_NEXT = [["atl", "auth", "login"]] as const;
const DEFAULT_MIN_TTL_SECONDS = 120;

export interface AuthClaims {
  iss?: string;
  threeLo: boolean;
  firstParty: boolean;
  /** cloudIds parsed from `ari:cloud:(confluence|jira)::site/<cloudId>` audiences. */
  audSites: string[];
  mcpToolsets?: string[];
}

/** Never contains a token, client secret or refresh token. */
export interface AuthStatus {
  loggedIn: boolean;
  source: "env" | "stored" | "missing";
  resource: string;
  clientRegistered: boolean;
  /** ISO 8601. */
  expiresAt?: string;
  expiresInSeconds?: number;
  scopes: string[];
  hasRefreshToken: boolean;
  claims?: AuthClaims;
}

interface BaseOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
}

export interface LoginOptions extends BaseOptions {
  port?: number | undefined;
  resource?: string | undefined;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  onAuthorizeUrl?: ((url: string) => void) | undefined;
  /** Overrides the 5 minute wait for the browser callback. */
  timeoutMs?: number | undefined;
}

export interface TokenOptions extends BaseOptions {
  /** Refresh when the stored token expires within this many seconds. Default 120. */
  minTtlSeconds?: number | undefined;
}

function notLoggedIn(): AtlError {
  return new AtlError("Not logged in", {
    code: "not_logged_in",
    category: "auth",
    hint: "Run `atl auth login`, or set ATL_ACCESS_TOKEN.",
    next: LOGIN_NEXT,
  });
}

/** Applies `mutate` to the stored credentials under the refresh lock. */
async function updateStore(
  env: NodeJS.ProcessEnv,
  mutate: (current: StoredCredentials | undefined) => StoredCredentials | undefined,
): Promise<void> {
  await withRefreshLock(
    async () => {
      const next = mutate(await readCredentials(env));
      if (next === undefined) {
        await deleteCredentials(env);
      } else {
        await writeCredentials(next, env);
      }
    },
    { env },
  );
}

export async function login(options: LoginOptions = {}): Promise<AuthStatus> {
  const env = options.env ?? process.env;
  const discovery = await discover({
    resource: options.resource,
    fetch: options.fetch,
    signal: options.signal,
  });

  const state = createState();
  const listener = startCallbackServer({
    port: options.port ?? DEFAULT_PORT,
    state,
    timeoutMs: options.timeoutMs ?? LOGIN_TIMEOUT_MS,
    signal: options.signal,
  });
  try {
    const stored = await readCredentials(env);
    const { client, registered } = await ensureClient({
      stored,
      discovery,
      redirectUri: listener.redirectUri,
      fetch: options.fetch,
      signal: options.signal,
    });
    const base: StoredCredentials = {
      version: 1,
      resource: discovery.resource,
      issuer: discovery.issuer,
      endpoints: discovery.endpoints,
      client,
    };
    // Persist a new registration right away so a retry reuses it, unless that would drop a
    // still-working session bound to the previous client.
    if (registered && !stored?.token) {
      await updateStore(env, () => base);
    }

    const verifier = createCodeVerifier();
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: discovery.endpoints.authorization,
      clientId: client.clientId,
      scope: discovery.scopesSupported.join(" "),
      resource: discovery.resource,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: codeChallengeS256(verifier),
    });
    options.onAuthorizeUrl?.(authorizeUrl);
    try {
      await (options.openBrowser ?? openInBrowser)(authorizeUrl);
    } catch {
      // Non-fatal: the URL was already reported through onAuthorizeUrl.
    }

    const code = await listener.result;
    const token = await exchangeCode({
      endpoints: discovery.endpoints,
      client,
      resource: discovery.resource,
      code,
      codeVerifier: verifier,
      fetch: options.fetch,
      signal: options.signal,
    });
    await updateStore(env, () => ({ ...base, token }));
  } finally {
    listener.stop();
  }
  return authStatus({ env });
}

/** Rotates the refresh token. Must be called with the refresh lock held. */
async function rotate(
  creds: StoredCredentials,
  env: NodeJS.ProcessEnv,
  options: BaseOptions,
): Promise<StoredToken> {
  const { token, client, endpoints } = creds;
  if (!token?.refreshToken || !client || !endpoints) {
    throw new AtlError("No refresh token is stored", {
      code: "no_refresh_token",
      category: "auth",
      hint: "This credential cannot be refreshed; log in again.",
      next: LOGIN_NEXT,
    });
  }
  const fresh = await refreshAccessToken({
    endpoints,
    client,
    resource: creds.resource,
    refreshToken: token.refreshToken,
    previousScope: token.scope,
    fetch: options.fetch,
    signal: options.signal,
  });
  await writeCredentials({ ...creds, token: fresh }, env);
  return fresh;
}

/**
 * `ATL_ACCESS_TOKEN` wins and is never refreshed. Otherwise the stored token, refreshed under the
 * cross-process lock when it expires within `minTtlSeconds`.
 */
export async function getAccessToken(options: TokenOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const envToken = env.ATL_ACCESS_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const minTtlMs = (options.minTtlSeconds ?? DEFAULT_MIN_TTL_SECONDS) * 1000;
  const stored = await readCredentials(env);
  if (!stored?.token) {
    throw notLoggedIn();
  }
  if (stored.token.expiresAt - Date.now() > minTtlMs) {
    return stored.token.accessToken;
  }
  if (!stored.token.refreshToken) {
    if (stored.token.expiresAt > Date.now()) {
      return stored.token.accessToken;
    }
    throw new AtlError("The stored access token has expired and has no refresh token", {
      code: "token_expired",
      category: "auth",
      next: LOGIN_NEXT,
    });
  }

  return withRefreshLock(
    async () => {
      // Another process may have refreshed while this one waited for the lock.
      const current = await readCredentials(env);
      if (!current?.token) {
        throw notLoggedIn();
      }
      if (current.token.expiresAt - Date.now() > minTtlMs) {
        return current.token.accessToken;
      }
      return (await rotate(current, env, options)).accessToken;
    },
    { env },
  );
}

/** Forced refresh under the same lock. */
export async function refresh(options: BaseOptions = {}): Promise<AuthStatus> {
  const env = options.env ?? process.env;
  await withRefreshLock(
    async () => {
      const current = await readCredentials(env);
      if (!current?.token) {
        throw notLoggedIn();
      }
      await rotate(current, env, options);
    },
    { env },
  );
  return authStatus({ env });
}

export interface LogoutOptions extends BaseOptions {
  /** Revoke at the authorization server before deleting locally. A failed revocation keeps the token. */
  revoke?: boolean;
}

/** Deletes the token and keeps the client registration. */
export async function logout(
  options: LogoutOptions = {},
): Promise<{ revoked: boolean; hadToken: boolean }> {
  const env = options.env ?? process.env;
  return withRefreshLock(
    async () => {
      const current = await readCredentials(env);
      if (!current?.token) {
        return { revoked: false, hadToken: false };
      }
      if (options.revoke) {
        const revocationEndpoint = current.endpoints?.revocation;
        if (!current.client || !revocationEndpoint) {
          throw new AtlError("No revocation endpoint is known for the stored credential", {
            code: "revocation_unsupported",
            category: "auth",
            hint: "Run logout without --revoke to delete the token locally.",
          });
        }
        const { refreshToken, accessToken } = current.token;
        await revokeToken({
          revocationEndpoint,
          client: current.client,
          token: refreshToken ?? accessToken,
          tokenTypeHint: refreshToken ? "refresh_token" : "access_token",
          fetch: options.fetch,
          signal: options.signal,
        });
      }
      const next: StoredCredentials = { ...current };
      delete next.token;
      if (next.client) {
        await writeCredentials(next, env);
      } else {
        await deleteCredentials(env);
      }
      return { revoked: options.revoke === true, hadToken: true };
    },
    { env },
  );
}

export interface ImportTokenOptions {
  env?: NodeJS.ProcessEnv;
  resource?: string | undefined;
}

/** Headless `--with-token`: stores an access token without a refresh token; expiry comes from its `exp`. */
export async function importToken(
  accessToken: string,
  options: ImportTokenOptions = {},
): Promise<AuthStatus> {
  const env = options.env ?? process.env;
  const token = accessToken.trim();
  const claims = summarizeToken(token);
  if (claims?.exp === undefined) {
    throw new AtlError("The value is not a JWT access token with an exp claim", {
      code: "invalid_token",
      category: "input",
    });
  }
  const expiresAt = claims.exp * 1000;
  if (expiresAt <= Date.now()) {
    throw new AtlError("The access token has already expired", {
      code: "token_expired",
      category: "input",
    });
  }
  const imported: StoredToken = {
    accessToken: token,
    expiresAt,
    scope: claims.scopes.join(" "),
    obtainedAt: Date.now(),
  };
  await updateStore(env, (current) => ({
    ...(current ?? { version: 1, resource: options.resource ?? DEFAULT_RESOURCE }),
    token: imported,
  }));
  return authStatus({ env });
}

function describeToken(
  source: "env" | "stored",
  accessToken: string,
  expiresAtMs: number | undefined,
  scopes: string[],
  hasRefreshToken: boolean,
  creds: StoredCredentials | undefined,
): AuthStatus {
  const summary = summarizeToken(accessToken);
  const now = Date.now();
  const expired = expiresAtMs !== undefined && expiresAtMs <= now;
  const status: AuthStatus = {
    loggedIn: !expired || hasRefreshToken,
    source,
    resource: creds?.resource ?? DEFAULT_RESOURCE,
    clientRegistered: creds?.client !== undefined,
    scopes: scopes.length > 0 ? scopes : (summary?.scopes ?? []),
    hasRefreshToken,
  };
  if (expiresAtMs !== undefined) {
    status.expiresAt = new Date(expiresAtMs).toISOString();
    status.expiresInSeconds = Math.round((expiresAtMs - now) / 1000);
  }
  if (summary) {
    const claims: AuthClaims = {
      threeLo: summary.threeLo,
      firstParty: summary.firstParty,
      audSites: summary.audSites,
    };
    if (summary.iss !== undefined) {
      claims.iss = summary.iss;
    }
    if (summary.mcpToolsets !== undefined) {
      claims.mcpToolsets = summary.mcpToolsets;
    }
    status.claims = claims;
  }
  return status;
}

/** Local state only; makes no network calls and exposes no secrets. */
export async function authStatus(options: { env?: NodeJS.ProcessEnv } = {}): Promise<AuthStatus> {
  const env = options.env ?? process.env;
  const creds = await readCredentials(env);
  const envToken = env.ATL_ACCESS_TOKEN?.trim();
  if (envToken) {
    const exp = summarizeToken(envToken)?.exp;
    return describeToken(
      "env",
      envToken,
      exp === undefined ? undefined : exp * 1000,
      [],
      false,
      creds,
    );
  }
  if (!creds?.token) {
    return {
      loggedIn: false,
      source: "missing",
      resource: creds?.resource ?? DEFAULT_RESOURCE,
      clientRegistered: creds?.client !== undefined,
      scopes: [],
      hasRefreshToken: false,
    };
  }
  const { accessToken, expiresAt, scope, refreshToken } = creds.token;
  return describeToken(
    "stored",
    accessToken,
    expiresAt,
    scope.split(/\s+/).filter((s) => s.length > 0),
    refreshToken !== undefined,
    creds,
  );
}
