import { planOf } from "./write.ts";
import { Type } from "../core/schema.ts";
import { authStatus } from "../auth/index.ts";
import { discover } from "../auth/discovery.ts";
import {
  defineCommand,
  type CommandContext,
  type CommandInput,
  type CommandSpec,
} from "../core/cli.ts";
import { loadConfig, saveConfig } from "../core/config.ts";
import { AtlError, type NextCommand } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import { keepRaw } from "../core/output.ts";
import {
  buildUrl,
  type FetchLike,
  type HttpClient,
  type HttpMethod,
  type Query,
} from "../core/http.ts";
import { configDir } from "../core/paths.ts";
import { API_ORIGIN, createHttpClient, openSession, refreshSites } from "../core/session.ts";
import { parseSite } from "../resolve/index.ts";
import { VERSION } from "../version.ts";

/** Injection points for tests; production uses the global fetch and the filesystem. */
export interface SiteDeps {
  fetch?: FetchLike;
  readFile?: (path: string) => Promise<string>;
}

const LOGIN: NextCommand = ["atl", "auth", "login"];
const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  status?: number;
  code?: string;
}

async function probe(action: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    if (error instanceof AtlError) {
      return {
        ok: false,
        ...(error.status === undefined ? {} : { status: error.status }),
        code: error.code,
      };
    }
    return { ok: false, code: "internal_error" };
  }
}

const SKIPPED: ProbeResult = { ok: false, code: "skipped_not_logged_in" };

export async function runDoctor(ctx: CommandContext, deps: SiteDeps = {}): Promise<unknown> {
  const status = await authStatus({ env: ctx.env });
  const missing: { step: string; next: NextCommand }[] = [];

  const authServerPromise = probe(() => discover({ resource: status.resource, fetch: deps.fetch }));

  let site: { host: string; cloudId: string } | { error: string; hint: string | undefined };
  let http: HttpClient | undefined;
  let confluenceUrl: string | undefined;
  let jiraUrl: string | undefined;
  if (!status.loggedIn) {
    site = { error: "not_logged_in", hint: "Run `atl auth login`." };
    missing.push({ step: "Log in", next: LOGIN });
  } else {
    try {
      const session = await openSession(ctx, { fetch: deps.fetch });
      http = session.http;
      site = { host: session.site.host, cloudId: session.site.cloudId };
      confluenceUrl = session.confluenceUrl("/api/v2/spaces", { limit: 1 });
      jiraUrl = session.jiraUrl("/rest/api/3/project/search", { maxResults: 1 });
    } catch (error) {
      http = createHttpClient(ctx.env, deps.fetch);
      const cause = error instanceof AtlError ? error : undefined;
      site = { error: cause?.code ?? "internal_error", hint: cause?.hint ?? cause?.message };
      missing.push({ step: "Choose a site", next: cause?.next[0] ?? ["atl", "sites"] });
    }
  }

  const client = http;
  const [authServer, me, confluence, jira] = await Promise.all([
    authServerPromise,
    client
      ? probe(() => client.request({ method: "GET", url: `${API_ORIGIN}/me` }))
      : Promise.resolve(SKIPPED),
    client && confluenceUrl !== undefined
      ? probe(() => client.request({ method: "GET", url: confluenceUrl }))
      : Promise.resolve(SKIPPED),
    client && jiraUrl !== undefined
      ? probe(() => client.request({ method: "GET", url: jiraUrl }))
      : Promise.resolve(SKIPPED),
  ]);

  if (!authServer.ok) {
    missing.push({
      step: "Auth server unreachable (consent flow unavailable); retry later or import a token",
      next: [...LOGIN, "--with-token"],
    });
  }
  if (client && [me, confluence, jira].some((p) => p.status === 401 || p.status === 403)) {
    missing.push({ step: "Re-authenticate: a probe was rejected", next: LOGIN });
  }

  const probes = { authServer, me, confluence, jira };
  if (ctx.full) {
    return {
      version: VERSION,
      configDir: configDir(ctx.env),
      auth: {
        loggedIn: status.loggedIn,
        source: status.source,
        resource: status.resource,
        clientRegistered: status.clientRegistered,
        hasRefreshToken: status.hasRefreshToken,
        ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
        ...(status.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: status.expiresInSeconds }),
      },
      site,
      probes,
      missing,
    };
  }

  // Compact: only failed probes are listed; skipped ones are explained by `missing`.
  const failed: Record<string, Omit<ProbeResult, "ok">> = {};
  for (const [name, result] of Object.entries(probes)) {
    if (!result.ok && result !== SKIPPED) {
      failed[name] = {
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.code === undefined ? {} : { code: result.code }),
      };
    }
  }
  return {
    ok: status.loggedIn && "host" in site && Object.values(probes).every((p) => p.ok),
    version: VERSION,
    configDir: configDir(ctx.env),
    auth: {
      loggedIn: status.loggedIn,
      source: status.source,
      ...(status.expiresInSeconds === undefined
        ? {}
        : { expiresInSeconds: status.expiresInSeconds }),
    },
    site,
    ...(Object.keys(failed).length === 0 ? {} : { probes: failed }),
    ...(missing.length === 0 ? {} : { missing }),
  };
}

const doctor = defineCommand({
  name: "doctor",
  summary: "Diagnose auth, site selection and API reachability; never fails on probe errors",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl doctor"],
  run: (ctx) => runDoctor(ctx),
});

// ---------------------------------------------------------------------------
// sites
// ---------------------------------------------------------------------------

export const SitesFlags = Type.Object({
  default: Type.Optional(
    Type.String({ description: "Save this site (host, URL or name) as the default" }),
  ),
});

export async function runSites(
  ctx: CommandContext,
  input: CommandInput<typeof SitesFlags>,
  deps: SiteDeps = {},
): Promise<unknown> {
  const sites = await refreshSites(createHttpClient(ctx.env, deps.fetch), ctx.env);
  const wanted = input.flags.default;
  const config = await loadConfig(ctx.env);
  if (wanted !== undefined) {
    const host = parseSite(wanted);
    const match =
      sites.find((site) => site.host === host) ??
      sites.find((site) => site.name.toLowerCase() === wanted.trim().toLowerCase());
    if (match === undefined) {
      throw new AtlError(`Site ${wanted} is not accessible with the current login`, {
        code: "unknown_site",
        category: "input",
        hint: `Accessible sites: ${sites.map((site) => site.host).join(", ") || "none"}`,
        next: [["atl", "sites"]],
      });
    }
    config.defaultSite = match.host;
    await saveConfig(config, ctx.env);
  }
  if (ctx.full) {
    return {
      items: sites.map(({ host, name, cloudId, url, scopes }) => ({
        host,
        name,
        cloudId,
        url,
        scopes,
        default: host === config.defaultSite,
      })),
      nextCursor: null,
    };
  }
  // url is always https://<host>; scopes are per-site detail available with --full.
  return {
    items: sites.map(({ host, name, cloudId }) =>
      host === config.defaultSite
        ? { host, name, cloudId, default: true }
        : { host, name, cloudId },
    ),
  };
}

const sites = defineCommand({
  name: "sites",
  summary: "List accessible Atlassian sites; --default saves one",
  mcpTools: ["getAccessibleAtlassianResources"],
  args: [],
  flags: SitesFlags,
  sideEffects: "local",
  examples: ["atl sites", "atl sites --default acme.atlassian.net"],
  run: (ctx, input) => runSites(ctx, input),
});

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

export async function runWhoami(ctx: CommandContext, deps: SiteDeps = {}): Promise<unknown> {
  const raw = await createHttpClient(ctx.env, deps.fetch).request({
    method: "GET",
    url: `${API_ORIGIN}/me`,
  });
  if (ctx.full || !isRecord(raw)) {
    return raw;
  }
  return {
    accountId: raw.account_id,
    name: raw.name,
    email: raw.email,
    nickname: raw.nickname,
    accountStatus: raw.account_status,
  };
}

const whoami = defineCommand({
  name: "whoami",
  summary: "Show the authenticated Atlassian account",
  mcpTools: ["atlassianUserInfo"],
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl whoami", "atl whoami --full"],
  run: (ctx) => runWhoami(ctx),
});

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

export const ApiFlags = Type.Object({
  query: Type.Optional(
    Type.Array(Type.String(), { description: "Query parameter as key=value; repeatable" }),
  ),
  bodyFile: Type.Optional(Type.String({ description: "Path to a JSON request body" })),
  yes: Type.Optional(Type.Boolean({ description: "Confirm a non-GET request" })),
});

function parseQuery(pairs: readonly string[]): Query {
  const query: Record<string, string | string[]> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new AtlError(`Invalid --query "${pair}"`, {
        code: "invalid_query",
        category: "input",
        hint: "Use --query key=value",
      });
    }
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else {
      query[key] = [...(Array.isArray(existing) ? existing : [existing]), value];
    }
  }
  return query;
}

export async function runApi(
  ctx: CommandContext,
  input: CommandInput<typeof ApiFlags>,
  deps: SiteDeps = {},
): Promise<unknown> {
  const requested = (input.args.method ?? "").toUpperCase();
  const method = METHODS.find((candidate) => candidate === requested);
  const path = input.args.path ?? "";
  const { flags } = input;
  if (method === undefined) {
    throw new AtlError(`Unsupported method ${input.args.method}`, {
      code: "invalid_method",
      category: "input",
      hint: `Use one of ${METHODS.join(", ")}.`,
    });
  }

  let absolute: string | undefined;
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    if (parsed.protocol !== "https:" || parsed.host !== "api.atlassian.com") {
      throw new AtlError("Refusing to send credentials to a host other than api.atlassian.com", {
        code: "foreign_host",
        category: "input",
        hint: "Use a path like /wiki/api/v2/spaces or /rest/api/3/project/search.",
      });
    }
    absolute = parsed.toString();
  } else if (!path.startsWith("/")) {
    throw new AtlError(`Path must start with / or be an api.atlassian.com URL: ${path}`, {
      code: "invalid_path",
      category: "input",
      hint: "Routes: /wiki/... (Confluence), /rest/... (Jira), /me and /oauth/... (account).",
    });
  }

  const query = flags.query === undefined ? undefined : parseQuery(flags.query);
  let body: unknown;
  if (flags.bodyFile !== undefined) {
    const file = flags.bodyFile;
    const bodyText = await (deps.readFile ?? ((p) => Bun.file(p).text()))(file).catch(
      (cause: unknown) => {
        throw new AtlError(`Cannot read --body-file ${file}`, {
          code: "body_file_unreadable",
          category: "input",
          cause,
        });
      },
    );
    try {
      body = JSON.parse(bodyText);
    } catch (cause) {
      throw new AtlError(`--body-file ${file} is not valid JSON`, {
        code: "invalid_body",
        category: "input",
        cause,
      });
    }
  }

  const readOnly = method === "GET" || method === "HEAD";
  const argv = (...extra: string[]): NextCommand => [
    "atl",
    ...(ctx.site === undefined ? [] : ["--site", ctx.site]),
    "api",
    method,
    path,
    ...(flags.query ?? []).flatMap((pair) => ["--query", pair]),
    ...(flags.bodyFile === undefined ? [] : ["--body-file", flags.bodyFile]),
    ...extra,
  ];
  if (!readOnly && flags.yes !== true && !ctx.plan) {
    throw new AtlError(`${method} ${path} changes data and needs confirmation`, {
      code: "confirmation_required",
      category: "input",
      hint: "Preview with --plan, then re-run with --yes.",
      next: [argv("--plan")],
    });
  }

  let url: string;
  let client: HttpClient;
  if (absolute !== undefined || path === "/me" || path.startsWith("/oauth/")) {
    url = absolute ?? buildUrl(API_ORIGIN, path);
    client = createHttpClient(ctx.env, deps.fetch);
  } else {
    const session = await openSession(ctx, { fetch: deps.fetch });
    client = session.http;
    if (path.startsWith("/wiki/")) {
      url = buildUrl(`${API_ORIGIN}/ex/confluence/${session.site.cloudId}`, path);
    } else if (path.startsWith("/rest/")) {
      url = buildUrl(`${API_ORIGIN}/ex/jira/${session.site.cloudId}`, path);
    } else {
      throw new AtlError(`Unroutable path ${path}`, {
        code: "invalid_path",
        category: "input",
        hint: "Routes: /wiki/... (Confluence), /rest/... (Jira), /me and /oauth/... (account).",
      });
    }
  }

  if (!readOnly && ctx.plan) {
    return planOf(
      {
        method,
        url,
        ...(query === undefined ? {} : { query }),
        ...(body === undefined ? {} : { body }),
      },
      [argv("--yes")],
    );
  }
  return keepRaw(
    await client.request({
      method,
      url,
      ...(query === undefined ? {} : { query }),
      ...(body === undefined ? {} : { body }),
    }),
  );
}

const api = defineCommand({
  name: "api",
  summary: "Raw authenticated request to Confluence, Jira or the account API",
  args: [
    {
      name: "method",
      description: "HTTP method: GET, HEAD, POST, PUT, PATCH, DELETE",
      required: true,
    },
    {
      name: "path",
      description:
        "/wiki/... (Confluence), /rest/... (Jira), /me, /oauth/..., or an api.atlassian.com URL",
      required: true,
    },
  ],
  flags: ApiFlags,
  sideEffects: "write",
  examples: [
    "atl api GET /wiki/api/v2/spaces --query limit=1",
    "atl api GET /rest/api/3/project/search --query maxResults=5",
    "atl api POST /rest/api/3/issue --body-file issue.json --plan",
  ],
  run: (ctx, input) => runApi(ctx, input),
});

export const siteCommands: readonly CommandSpec[] = [doctor, sites, whoami, api];
