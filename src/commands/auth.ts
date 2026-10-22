import { Type } from "../core/schema.ts";
import {
  authStatus,
  DEFAULT_PORT,
  DEFAULT_RESOURCE,
  importToken,
  login,
  logout,
  refresh,
  type AuthStatus,
} from "../auth/index.ts";
import {
  defineCommand,
  type CommandContext,
  type CommandInput,
  type CommandSpec,
} from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import type { FetchLike } from "../core/http.ts";
import { writeDiagnostic } from "../core/output.ts";
import { shortTs } from "./common.ts";
import { createHttpClient, refreshSites } from "../core/session.ts";

export const authGroups: Readonly<Record<string, string>> = {
  auth: "Log in, inspect, refresh and revoke credentials",
};

/** Injection points for tests; production uses the process streams and global fetch. */
export interface AuthDeps {
  fetch?: FetchLike;
  readStdin?: () => Promise<string>;
  stdinIsTty?: () => boolean;
}

export const LoginFlags = Type.Object({
  port: Type.Optional(
    Type.Integer({ description: `Loopback callback port (default ${DEFAULT_PORT})` }),
  ),
  resource: Type.Optional(
    Type.String({ description: `OAuth resource URL (default ${DEFAULT_RESOURCE})` }),
  ),
  withToken: Type.Optional(
    Type.Boolean({ description: "Read an access token from stdin instead of opening a browser" }),
  ),
});

export async function runLogin(
  ctx: CommandContext,
  input: CommandInput<typeof LoginFlags>,
  deps: AuthDeps = {},
): Promise<{ status: AuthStatus; sites: { host: string; name: string; cloudId: string }[] }> {
  const { flags } = input;
  const resource = flags.resource ?? DEFAULT_RESOURCE;
  let status: AuthStatus;
  if (flags.withToken) {
    const isTty = (deps.stdinIsTty ?? (() => process.stdin.isTTY))();
    const raw = isTty ? "" : await (deps.readStdin ?? (() => Bun.stdin.text()))();
    const token = raw.trim();
    if (token === "") {
      throw new AtlError("No access token on stdin", {
        code: "token_missing",
        category: "input",
        hint: 'Pipe the token in, e.g. `printf %s "$TOKEN" | atl auth login --with-token`.',
      });
    }
    status = await importToken(token, { env: ctx.env, resource });
  } else {
    status = await login({
      env: ctx.env,
      port: flags.port ?? DEFAULT_PORT,
      resource,
      fetch: deps.fetch,
      onAuthorizeUrl: (url) =>
        writeDiagnostic({ type: "auth_url", url, hint: "Open this URL to approve access" }),
    });
  }
  const sites = await refreshSites(createHttpClient(ctx.env, deps.fetch), ctx.env);
  return {
    status,
    sites: sites.map(({ host, name, cloudId }) => ({ host, name, cloudId })),
  };
}

/**
 * Compact status: scopes as one space-joined string, no claims block, default resource and
 * sub-second timestamps dropped. `--full` returns the raw status.
 */
function statusView(ctx: CommandContext, status: AuthStatus): unknown {
  if (ctx.full) {
    return status;
  }
  return {
    loggedIn: status.loggedIn,
    source: status.source,
    ...(status.resource === DEFAULT_RESOURCE ? {} : { resource: status.resource }),
    clientRegistered: status.clientRegistered,
    hasRefreshToken: status.hasRefreshToken,
    ...(status.expiresAt === undefined ? {} : { expiresAt: shortTs(status.expiresAt) }),
    ...(status.expiresInSeconds === undefined ? {} : { expiresInSeconds: status.expiresInSeconds }),
    ...(status.scopes.length === 0 ? {} : { scopes: status.scopes.join(" ") }),
  };
}

const authLogin = defineCommand({
  name: "auth.login",
  summary: "Log in via the Atlassian MCP OAuth flow (or import a token from stdin)",
  args: [],
  flags: LoginFlags,
  sideEffects: "local",
  examples: ["atl auth login", 'printf %s "$TOKEN" | atl auth login --with-token'],
  run: async (ctx, input) => {
    const result = await runLogin(ctx, input);
    return { ...result, status: statusView(ctx, result.status) };
  },
});

const authStatusCommand = defineCommand({
  name: "auth.status",
  summary: "Show local credential state; makes no network calls",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl auth status"],
  run: async (ctx) => statusView(ctx, await authStatus({ env: ctx.env })),
});

const authRefresh = defineCommand({
  name: "auth.refresh",
  summary: "Force a token refresh",
  args: [],
  flags: Type.Object({}),
  sideEffects: "local",
  examples: ["atl auth refresh"],
  run: async (ctx) => statusView(ctx, await refresh({ env: ctx.env })),
});

const authLogout = defineCommand({
  name: "auth.logout",
  summary: "Delete the stored token, optionally revoking it first",
  args: [],
  flags: Type.Object({
    revoke: Type.Optional(
      Type.Boolean({ description: "Revoke at the authorization server first" }),
    ),
  }),
  sideEffects: "local",
  examples: ["atl auth logout", "atl auth logout --revoke"],
  run: (ctx, input) => logout({ env: ctx.env, revoke: input.flags.revoke === true }),
});

export const authCommands: readonly CommandSpec[] = [
  authLogin,
  authStatusCommand,
  authRefresh,
  authLogout,
];
