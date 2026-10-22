#!/usr/bin/env bun
/**
 * Watch public, unauthenticated signals that identify the Atlassian MCP server version and compare
 * them with the committed baseline in `mcp/upstream.json`.
 *
 * Every source (GitHub server.json, GitHub plugin.json, the MCP registry, each protected-resource
 * probe, the public supported-tools doc) is fetched independently with a 30 s per-request timeout.
 * A source that cannot be fetched or parsed is listed in `unavailable` and keeps its baseline
 * value, so it never shows up as a diff.
 *
 * Usage: bun scripts/mcp-watch.ts [--write] [--issue-body <path>]
 * Exit codes: 0 compared (see `changed` and `unavailable`), 1 usage error, invalid baseline, or
 * `--write` refused while a source is unavailable, 2 every source failed (or one failed and there
 * is no baseline file to take its value from).
 */
import { Type, type Static } from "../src/core/schema.ts";
import { isRecord } from "../src/core/guards.ts";
import type { FetchLike } from "../src/core/http.ts";
import { check, firstIssue } from "../src/core/validate.ts";

export const USER_AGENT = "atl-mcp-watch";
export const SERVER_NAME = "com.atlassian/atlassian-mcp-server";
export const GITHUB_RAW = "https://raw.githubusercontent.com/atlassian/atlassian-mcp-server/main";
export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
/** Markdown source of the public supported-tools page; its tables list every documented tool. */
export const DOCS_URL = "https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools.md";
export const MCP_ORIGIN = "https://mcp.atlassian.com";
/** Always probed; `v3/mcp` is the next major and answers 404 until Atlassian ships it. */
export const PROBED_PATHS: readonly string[] = ["v1/mcp/authv2", "v2/mcp", "v3/mcp"];
export const DEFAULT_SNAPSHOT_PATH = Bun.fileURLToPath(
  new URL("../mcp/upstream.json", import.meta.url),
);
const TIMEOUT_MS = 30_000;
const MAX_REGISTRY_PAGES = 20;

const RemoteSchema = Type.Object({ type: Type.String(), url: Type.String() });
const ResourceSignalSchema = Type.Union([
  Type.Object({ status: Type.Literal(404) }),
  Type.Object({
    status: Type.Literal(200),
    resource: Type.String(),
    authorization_servers: Type.Array(Type.String()),
    scopes_supported: Type.Array(Type.String()),
  }),
]);
/** Shape of the normalized snapshot, which is also the shape of the persisted `mcp/upstream.json`. */
const SnapshotSchema = Type.Object({
  github: Type.Object({
    server: Type.Object({
      name: Type.String(),
      version: Type.String(),
      remotes: Type.Array(RemoteSchema),
    }),
    plugin: Type.Object({ name: Type.String(), version: Type.String() }),
  }),
  registry: Type.Object({
    latest: Type.Union([
      Type.Object({ version: Type.String(), remotes: Type.Array(Type.String()) }),
      Type.Null(),
    ]),
    versions: Type.Array(Type.String()),
  }),
  resources: Type.Record(Type.String(), ResourceSignalSchema),
  docs: Type.Object({ supportedTools: Type.Array(Type.String()) }),
});

export type Remote = Static<typeof RemoteSchema>;
export type ResourceSignal = Static<typeof ResourceSignalSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;

export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export interface Unavailable {
  source: string;
  error: string;
}

export interface Collected {
  snapshot: Snapshot;
  /** Failed sources, sorted by name; their snapshot slots hold the baseline value instead. */
  unavailable: Unavailable[];
  /** How many sources were attempted, to tell "some failed" from "all failed". */
  sources: number;
}

export interface WatchResult {
  changed: boolean;
  fingerprint: string;
  diff: DiffEntry[];
  unavailable: Unavailable[];
  snapshot: Snapshot;
}

/** A source could not be fetched or had an unexpected shape; it is reported as unavailable. */
export class WatchError extends Error {
  constructor(
    readonly code: "fetch_failed" | "bad_response",
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

class UsageError extends Error {}

async function getText(
  fetch: FetchLike,
  url: string,
  accept: string,
  allow404: boolean,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WatchError("fetch_failed", `GET ${url} failed: ${reason}`, url);
  }
  if (allow404 && response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new WatchError("fetch_failed", `GET ${url} returned HTTP ${response.status}`, url);
  }
  return response.text();
}

async function getJson(fetch: FetchLike, url: string, allow404: boolean): Promise<unknown> {
  const text = await getText(fetch, url, "application/json", allow404);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WatchError("bad_response", `GET ${url} returned non-JSON content`, url);
  }
}

function field(value: unknown, key: string, url: string): unknown {
  if (!isRecord(value) || !(key in value)) {
    throw new WatchError("bad_response", `GET ${url}: missing "${key}"`, url);
  }
  return value[key];
}

function stringField(value: unknown, key: string, url: string): string {
  const found = field(value, key, url);
  if (typeof found !== "string") {
    throw new WatchError("bad_response", `GET ${url}: "${key}" is not a string`, url);
  }
  return found;
}

function stringArrayField(value: unknown, key: string, url: string): string[] {
  const found = field(value, key, url);
  if (!Array.isArray(found) || !found.every((item) => typeof item === "string")) {
    throw new WatchError("bad_response", `GET ${url}: "${key}" is not a string array`, url);
  }
  return [...new Set<string>(found)].toSorted();
}

function arrayField(value: unknown, key: string, url: string): unknown[] {
  const found = field(value, key, url);
  if (!Array.isArray(found)) {
    throw new WatchError("bad_response", `GET ${url}: "${key}" is not an array`, url);
  }
  return found;
}

function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

function remotesOf(server: unknown, url: string): Remote[] {
  const remotes = isRecord(server) && "remotes" in server ? arrayField(server, "remotes", url) : [];
  return remotes
    .map((remote) => ({
      type: stringField(remote, "type", url),
      url: stringField(remote, "url", url),
    }))
    .toSorted((a, b) => `${a.url} ${a.type}`.localeCompare(`${b.url} ${b.type}`));
}

async function collectRegistry(fetch: FetchLike): Promise<Snapshot["registry"]> {
  const entries: { version: string; remotes: string[]; isLatest: boolean }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_REGISTRY_PAGES; page++) {
    // The registry answers a percent-encoded "/" in the search value 10+ seconds late; send it literally.
    const cursorParam = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const url = `${REGISTRY_URL}?search=${SERVER_NAME}${cursorParam}`;
    const body = await getJson(fetch, url, false);
    for (const item of arrayField(body, "servers", url)) {
      const server = field(item, "server", url);
      if (stringField(server, "name", url) !== SERVER_NAME) {
        continue;
      }
      const meta = isRecord(item) ? item._meta : undefined;
      const official = isRecord(meta)
        ? meta["io.modelcontextprotocol.registry/official"]
        : undefined;
      entries.push({
        version: stringField(server, "version", url),
        remotes: remotesOf(server, url).map((remote) => remote.url),
        isLatest: isRecord(official) && official.isLatest === true,
      });
    }
    const metadata = isRecord(body) ? body.metadata : undefined;
    const next = isRecord(metadata) ? metadata.nextCursor : undefined;
    if (typeof next !== "string" || next === "") {
      const latest = entries.find((entry) => entry.isLatest);
      return {
        latest: latest === undefined ? null : { version: latest.version, remotes: latest.remotes },
        versions: [...new Set(entries.map((entry) => entry.version))].toSorted(compareVersions),
      };
    }
    cursor = next;
  }
  throw new WatchError(
    "bad_response",
    `registry pagination exceeded ${MAX_REGISTRY_PAGES} pages`,
    REGISTRY_URL,
  );
}

async function collectResource(fetch: FetchLike, path: string): Promise<ResourceSignal> {
  const url = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/${path}`;
  const body = await getJson(fetch, url, true);
  if (body === null) {
    return { status: 404 };
  }
  return {
    status: 200,
    resource: stringField(body, "resource", url),
    authorization_servers: stringArrayField(body, "authorization_servers", url),
    scopes_supported: stringArrayField(body, "scopes_supported", url),
  };
}

/**
 * Tool names from the first column of the page's markdown tables, sorted and deduplicated. A row
 * names a tool as `` `name` ``; a row may name several (`executeRead`, `executeWrite`, ...).
 */
async function collectDocs(fetch: FetchLike): Promise<Snapshot["docs"]> {
  const text = await getText(fetch, DOCS_URL, "text/markdown", false);
  const names = new Set<string>();
  for (const line of text?.split("\n") ?? []) {
    if (line.startsWith("|")) {
      for (const match of (line.split("|")[1] ?? "").matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) {
        names.add(match[1] ?? "");
      }
    }
  }
  if (names.size === 0) {
    throw new WatchError("bad_response", `GET ${DOCS_URL}: no tool names found`, DOCS_URL);
  }
  return { supportedTools: [...names].toSorted() };
}

/**
 * Fetch every source independently and normalize it: arrays sorted, only version-identifying
 * fields kept. A failed source takes its value from `baseline` and is reported unavailable; with no
 * baseline value to take, the failure propagates as a `WatchError`.
 */
export async function collect(
  fetch: FetchLike,
  baseline: Snapshot | null = null,
): Promise<Collected> {
  const unavailable: Unavailable[] = [];
  let sources = 0;
  /** Run one source; on failure record it and return `fallback` instead. */
  const settle = async <T>(
    source: string,
    run: () => Promise<T>,
    fallback: T | undefined,
  ): Promise<T> => {
    sources++;
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof WatchError) || fallback === undefined) {
        throw error;
      }
      unavailable.push({ source, error: error.message });
      return fallback;
    }
  };
  const serverUrl = `${GITHUB_RAW}/server.json`;
  const pluginUrl = `${GITHUB_RAW}/plugin.json`;
  const [server, plugin, registry, docs] = await Promise.all([
    settle(
      "github.server",
      async () => {
        const body = await getJson(fetch, serverUrl, false);
        return {
          name: stringField(body, "name", serverUrl),
          version: stringField(body, "version", serverUrl),
          remotes: remotesOf(body, serverUrl),
        };
      },
      baseline?.github.server,
    ),
    settle(
      "github.plugin",
      async () => {
        const body = await getJson(fetch, pluginUrl, false);
        return {
          name: stringField(body, "name", pluginUrl),
          version: stringField(body, "version", pluginUrl),
        };
      },
      baseline?.github.plugin,
    ),
    settle("registry", () => collectRegistry(fetch), baseline?.registry),
    settle("docs.supportedTools", () => collectDocs(fetch), baseline?.docs),
  ]);
  // Without a fresh server.json, probe what the baseline probed so no resource appears or vanishes.
  const serverFailed = unavailable.some((entry) => entry.source === "github.server");
  const remotePaths = serverFailed
    ? Object.keys(baseline?.resources ?? {})
    : server.remotes
        .filter((remote) => remote.url.startsWith(`${MCP_ORIGIN}/`))
        .map((remote) => remote.url.slice(MCP_ORIGIN.length + 1));
  const paths = [...new Set([...PROBED_PATHS, ...remotePaths])].toSorted();
  const signals = await Promise.all(
    paths.map(async (path) => {
      // A path the baseline never saw has nothing to keep: it is reported and left out.
      const fallback = baseline === null ? undefined : (baseline.resources[path] ?? null);
      const signal = await settle<ResourceSignal | null>(
        `resources[${JSON.stringify(path)}]`,
        () => collectResource(fetch, path),
        fallback,
      );
      return signal === null ? [] : [[path, signal] as const];
    }),
  );
  return {
    snapshot: {
      github: { server, plugin },
      registry,
      resources: Object.fromEntries(signals.flat()),
      docs,
    },
    unavailable: unavailable.toSorted((a, b) => a.source.localeCompare(b.source)),
    sources,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/** JSON with object keys sorted at every depth, so equal snapshots serialize identically. */
export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

export function fingerprint(snapshot: Snapshot): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function joinPath(base: string, key: string): string {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  return base === "" && segment.startsWith(".") ? key : `${base}${segment}`;
}

/** Leaf-level differences between two JSON values; arrays compare as whole values. */
export function diff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
    return keys.flatMap((key) => diff(before[key], after[key], joinPath(path, key)));
  }
  if (canonicalJson(before) === canonicalJson(after)) {
    return [];
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}

function cell(value: unknown): string {
  if (value === null) {
    return "_absent_";
  }
  return `\`${canonicalJson(value).replaceAll("|", "\\|").replaceAll("`", "'")}\``;
}

function listChanges(entry: DiffEntry): string | undefined {
  const { before, after } = entry;
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return undefined;
  }
  const removed = before
    .filter((item) => !after.includes(item))
    .map((item) => `\`-${String(item)}\``);
  const added = after
    .filter((item) => !before.includes(item))
    .map((item) => `\`+${String(item)}\``);
  const changes = [...added, ...removed];
  return changes.length === 0 ? undefined : `- \`${entry.path}\`: ${changes.join(" ")}`;
}

export function renderIssueBody(result: WatchResult): string {
  const listLines = result.diff.flatMap((entry) => listChanges(entry) ?? []);
  const unavailableLines =
    result.unavailable.length === 0
      ? []
      : [
          "> [!NOTE]",
          "> These sources were unavailable on this run and kept their baseline values, so they",
          "> were not compared:",
          ...result.unavailable.map(
            (entry) =>
              `> - \`${`${entry.source}: ${entry.error}`.replaceAll("`", "'").replaceAll(/\s+/g, " ")}\``,
          ),
          "",
        ];
  return [
    `<!-- mcp-watch:${result.fingerprint} -->`,
    "The public Atlassian MCP signals differ from the baseline in `mcp/upstream.json`",
    "(GitHub `atlassian/atlassian-mcp-server` server.json/plugin.json, the MCP registry,",
    "`https://mcp.atlassian.com/.well-known/oauth-protected-resource/*`, and the public",
    "supported-tools page).",
    "",
    ...unavailableLines,
    "## Diff",
    "",
    "| Path | Before | After |",
    "| --- | --- | --- |",
    ...result.diff.map(
      (entry) => `| \`${entry.path}\` | ${cell(entry.before)} | ${cell(entry.after)} |`,
    ),
    ...(listLines.length === 0 ? [] : ["", "### List changes", "", ...listLines]),
    "",
    "## Upgrade checklist",
    "",
    "- [ ] Re-snapshot the v1 tool surface: `atl mcp tools --snapshot --output mcp/tools-v1.json`",
    "- [ ] Refresh the v2 catalog (throwaway `ATL_CONFIG_DIR`, `atl auth login --resource https://mcp.atlassian.com/v2/mcp`, then with `ATL_MCP_URL=https://mcp.atlassian.com/v2/mcp`): `atl mcp tools --snapshot --pretty --output mcp/tools-v2.json` and `atl mcp tools --catalog --pretty --output mcp/operations-v2.json`",
    "- [ ] Run `bun test test/parity.test.ts`",
    "- [ ] Map every new or renamed tool to a command (`mcpTools` in `defineCommand`)",
    "- [ ] Update README.md and docs/design.md",
    "- [ ] Accept the new baseline: `bun scripts/mcp-watch.ts --write`",
    "",
    `Fingerprint: \`${result.fingerprint}\``,
    "",
  ].join("\n");
}

class BaselineError extends Error {}

/** Read and validate the persisted baseline; `null` when the file does not exist yet. */
async function readBaseline(path: string): Promise<Snapshot | null> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BaselineError(`${path} is not valid JSON`);
  }
  if (!check(SnapshotSchema, parsed)) {
    const at = firstIssue(SnapshotSchema, parsed)?.path;
    const where = at === undefined || at === "" ? "root" : at;
    throw new BaselineError(
      `${path} does not match the snapshot shape at ${where}; restore it from git or regenerate it with --write`,
    );
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): { write: boolean; issueBody: string | undefined } {
  let write = false;
  let issueBody: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--write") {
      write = true;
    } else if (arg === "--issue-body") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--issue-body requires a path");
      }
      issueBody = value;
      index++;
    } else {
      throw new UsageError(`unknown argument: ${arg ?? ""}`);
    }
  }
  return { write, issueBody };
}

export interface WatchDeps {
  fetch?: FetchLike;
  snapshotPath?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Run the watcher; returns the process exit code. */
export async function main(argv: readonly string[], deps: WatchDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const snapshotPath = deps.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  let args: { write: boolean; issueBody: string | undefined };
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    stderr(`${JSON.stringify({ error: { code: "usage", message: error.message } })}\n`);
    return 1;
  }
  let baseline: Snapshot | null;
  try {
    baseline = await readBaseline(snapshotPath);
  } catch (error) {
    if (!(error instanceof BaselineError)) {
      throw error;
    }
    stderr(`${JSON.stringify({ error: { code: "baseline_invalid", message: error.message } })}\n`);
    return 1;
  }
  let collected: Collected;
  try {
    collected = await collect(deps.fetch ?? fetch, baseline);
  } catch (error) {
    if (!(error instanceof WatchError)) {
      throw error;
    }
    stderr(
      `${JSON.stringify({ error: { code: error.code, message: error.message, url: error.url } })}\n`,
    );
    return 2;
  }
  const { snapshot, unavailable, sources } = collected;
  if (unavailable.length === sources) {
    stderr(
      `${JSON.stringify({ error: { code: "all_unavailable", message: "every source failed", unavailable } })}\n`,
    );
    return 2;
  }
  if (args.write && unavailable.length > 0) {
    const names = unavailable.map((entry) => entry.source).join(", ");
    stderr(
      `${JSON.stringify({
        error: {
          code: "write_refused",
          message: `refusing --write while ${unavailable.length} source(s) are unavailable (${names}); rerun when every source answers`,
          unavailable,
        },
      })}\n`,
    );
    return 1;
  }
  const changes = diff(sortKeys(baseline), sortKeys(snapshot));
  const result: WatchResult = {
    changed: changes.length > 0,
    fingerprint: fingerprint(snapshot),
    diff: changes,
    unavailable,
    snapshot,
  };
  if (args.write) {
    await Bun.write(snapshotPath, `${canonicalJson(snapshot, 2)}\n`);
  }
  if (args.issueBody !== undefined && result.changed) {
    await Bun.write(args.issueBody, renderIssueBody(result));
  }
  stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
