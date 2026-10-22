import { getAccessToken } from "../auth/index.ts";
import { parseSite } from "../resolve/index.ts";
import type { CommandContext } from "./cli.ts";
import { loadConfig, saveConfig, type SiteEntry } from "./config.ts";
import { AtlError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { buildUrl, HttpClient, type FetchLike, type Query } from "./http.ts";

export const API_ORIGIN = "https://api.atlassian.com";
const ACCESSIBLE_RESOURCES_URL = `${API_ORIGIN}/oauth/token/accessible-resources`;

export interface Site extends SiteEntry {
  /** Canonical host, e.g. `acme.atlassian.net`. */
  host: string;
}

export interface Session {
  http: HttpClient;
  site: Site;
  /** `https://api.atlassian.com/ex/confluence/<cloudId>/wiki<path>` */
  confluenceUrl(path: string, query?: Query): string;
  /** `https://api.atlassian.com/ex/jira/<cloudId><path>` */
  jiraUrl(path: string, query?: Query): string;
  /** Browser URL on the site, e.g. `siteUrl("/wiki/spaces/X/pages/1")`. */
  siteUrl(path: string): string;
}

export interface SessionOptions {
  /** Site derived from the target itself (page or issue URL); outranks `--site`. */
  siteHint?: string | undefined;
  fetch?: FetchLike | undefined;
}

export function createHttpClient(env: NodeJS.ProcessEnv, fetch?: FetchLike): HttpClient {
  return new HttpClient({
    getToken: () => getAccessToken({ env, ...(fetch === undefined ? {} : { fetch }) }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}

/**
 * Fetch accessible-resources, merge duplicate entries per host (union of scopes),
 * and replace the cached site list in config.
 */
export async function refreshSites(http: HttpClient, env: NodeJS.ProcessEnv): Promise<Site[]> {
  const body = await http.request({ method: "GET", url: ACCESSIBLE_RESOURCES_URL });
  if (!Array.isArray(body)) {
    throw new AtlError("accessible-resources returned an unexpected shape", {
      code: "unexpected_response",
      category: "api",
    });
  }
  const cachedAt = new Date().toISOString();
  const byHost = new Map<string, Site>();
  for (const entry of body) {
    if (!isRecord(entry)) {
      continue;
    }
    const { id, url, name, scopes } = entry;
    if (typeof id !== "string" || typeof url !== "string") {
      continue;
    }
    const host = new URL(url).host;
    const entryScopes = Array.isArray(scopes)
      ? scopes.filter((s): s is string => typeof s === "string")
      : [];
    const existing = byHost.get(host);
    if (existing) {
      existing.scopes = [...new Set([...existing.scopes, ...entryScopes])];
      continue;
    }
    byHost.set(host, {
      host,
      cloudId: id,
      name: typeof name === "string" ? name : host,
      url,
      scopes: entryScopes,
      cachedAt,
    });
  }
  const sites = [...byHost.values()];
  const config = await loadConfig(env);
  config.sites = Object.fromEntries(sites.map(({ host, ...entry }) => [host, entry]));
  await saveConfig(config, env);
  return sites;
}

/**
 * Pick the site: target hint > `--site` > `ATL_SITE` > config `defaultSite` > the only
 * accessible site. Unknown hosts trigger one accessible-resources refresh.
 */
export async function resolveSite(
  ctx: Pick<CommandContext, "site" | "env">,
  http: HttpClient,
  siteHint?: string,
): Promise<Site> {
  const config = await loadConfig(ctx.env);
  const requested = siteHint ?? ctx.site ?? ctx.env.ATL_SITE ?? config.defaultSite;
  const wanted = requested === undefined ? undefined : parseSite(requested);

  let sites: Site[] = Object.entries(config.sites ?? {}).map(([host, entry]) =>
    Object.assign({ host }, entry),
  );
  const pick = (): Site | undefined =>
    wanted === undefined
      ? sites.length === 1
        ? sites[0]
        : undefined
      : sites.find((site) => site.host === wanted);

  let site = pick();
  if (site === undefined) {
    sites = await refreshSites(http, ctx.env);
    site = pick();
  }
  if (site !== undefined) {
    return site;
  }

  if (wanted !== undefined) {
    throw new AtlError(`Site ${wanted} is not accessible with the current login`, {
      code: "site_not_accessible",
      category: "config",
      hint: `Accessible sites: ${sites.map((s) => s.host).join(", ") || "none"}`,
      next: [["atl", "sites"]],
    });
  }
  throw new AtlError(
    sites.length === 0 ? "No accessible Atlassian sites" : "Several sites accessible; pick one",
    {
      code: sites.length === 0 ? "no_sites" : "site_required",
      category: "config",
      hint:
        sites.length === 0
          ? "Log in with an account that has Confluence or Jira access."
          : `Pass --site, set ATL_SITE, or run \`atl sites --default <host>\`. Sites: ${sites.map((s) => s.host).join(", ")}`,
      next: [["atl", "sites"]],
    },
  );
}

export async function openSession(
  ctx: Pick<CommandContext, "site" | "env">,
  options: SessionOptions = {},
): Promise<Session> {
  const http = createHttpClient(ctx.env, options.fetch);
  const site = await resolveSite(ctx, http, options.siteHint);
  const confluenceBase = `${API_ORIGIN}/ex/confluence/${site.cloudId}/wiki`;
  const jiraBase = `${API_ORIGIN}/ex/jira/${site.cloudId}`;
  return {
    http,
    site,
    confluenceUrl: (path, query) => buildUrl(confluenceBase, path, query),
    jiraUrl: (path, query) => buildUrl(jiraBase, path, query),
    siteUrl: (path) => buildUrl(site.url, path),
  };
}
