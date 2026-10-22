/**
 * Shared plumbing for the eval scripts: the atl binary under test, subprocess runs, Claude token
 * counts via `omp toks`, the MCP v1 bearer (read from atl's credential store, never printed), a
 * minimal MCP Streamable HTTP client that returns the raw text an MCP host shows the model, and the
 * seed manifest.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/core/guards.ts";
import { credentialsPath } from "../src/core/paths.ts";

export const ATL = "/tmp/atl-eval/bin/atl";
export const ATL_BIN_DIR = "/tmp/atl-eval/bin";
export const ARMS_DIR = "/tmp/atl-eval/arms";
export const OUT = join(import.meta.dir, ".out");
export const MCP_URL = "https://mcp.atlassian.com/v1/mcp/authv2";
const TOKS_DIR = "/tmp/atl-eval/toks";
/** Claude tokenizer reported by `omp toks` for the model family the macro runs use. */
const TOKENIZER = "ClaudeV5";
const REFRESH_MARGIN_MS = 15 * 60_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const proc = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, ms: Math.round(performance.now() - started) };
}

export function atl(...args: string[]): Promise<RunResult> {
  return run([ATL, ...args]);
}

let toksSeq = 0;

/** Claude (v5 tokenizer) token count of `text`, via `omp toks --json` on a temp file. */
export async function claudeTokens(text: string): Promise<number> {
  if (text === "") {
    return 0;
  }
  mkdirSync(TOKS_DIR, { recursive: true });
  const file = join(TOKS_DIR, `${process.pid}-${toksSeq++}.txt`);
  writeFileSync(file, text);
  const result = await run(["omp", "toks", file, "--json"]);
  const parsed: unknown = JSON.parse(result.stdout);
  if (isRecord(parsed) && Array.isArray(parsed.encodings)) {
    for (const entry of parsed.encodings) {
      if (isRecord(entry) && entry.encoding === TOKENIZER && typeof entry.tokens === "number") {
        return entry.tokens;
      }
    }
  }
  throw new Error(`omp toks returned no ${TOKENIZER} count: ${result.stdout.slice(0, 200)}`);
}

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

function storedToken(): StoredToken {
  const path = credentialsPath();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const token = isRecord(parsed) && isRecord(parsed.token) ? parsed.token : undefined;
  if (
    token === undefined ||
    typeof token.accessToken !== "string" ||
    typeof token.expiresAt !== "number"
  ) {
    throw new Error(`${path} has no token.accessToken/expiresAt`);
  }
  return { accessToken: token.accessToken, expiresAt: token.expiresAt };
}

/** atl's access token, refreshed first when it expires within 15 minutes. Never print it. */
export async function bearer(): Promise<string> {
  if (storedToken().expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    const result = await atl("auth", "refresh");
    if (result.code !== 0) {
      throw new Error(`atl auth refresh failed: ${result.stderr.slice(0, 300)}`);
    }
  }
  const token = storedToken();
  if (token.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    throw new Error("atl access token still expires within 15 minutes after refresh");
  }
  return token.accessToken;
}

function sseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.replaceAll(/\r\n?/g, "\n").split(/\n\n+/)) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data !== "") {
      messages.push(JSON.parse(data));
    }
  }
  return messages;
}

/** Minimal MCP v1 session: initialize once, then `tools/call` returning the raw content text. */
export class McpSession {
  #token = "";
  #session: string | undefined;
  #id = 0;

  async #post(body: Record<string, unknown>): Promise<unknown[]> {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(this.#session === undefined ? {} : { "Mcp-Session-Id": this.#session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    this.#session = response.headers.get("mcp-session-id") ?? this.#session;
    if (text === "") {
      return [];
    }
    if (/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
      return sseMessages(text);
    }
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async #request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    const messages = await this.#post({ id, method, params });
    const reply = messages.find((message) => isRecord(message) && message.id === id);
    if (!isRecord(reply)) {
      throw new Error(`MCP ${method}: no reply`);
    }
    if (isRecord(reply.error)) {
      throw new Error(`MCP ${method}: ${JSON.stringify(reply.error).slice(0, 300)}`);
    }
    if (!isRecord(reply.result)) {
      throw new Error(`MCP ${method}: result is not an object`);
    }
    return reply.result;
  }

  async open(): Promise<void> {
    this.#token = await bearer();
    await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "atl-eval", version: "0" },
    });
    await this.#post({ method: "notifications/initialized" });
  }

  /** Text content items joined by newlines: what an MCP host passes to the model. */
  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const result = await this.#request("tools/call", { name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((item) =>
        isRecord(item) && typeof item.text === "string" ? item.text : JSON.stringify(item),
      )
      .join("\n");
    return { text, isError: result.isError === true };
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestIssue {
  key: string;
  type: string;
  summary: string;
  parent: string | null;
  status: string;
  labels: string[];
}

export interface ManifestPage {
  id: string;
  title: string;
  parentId: string;
  ref: string;
}

export interface Needle {
  n: number;
  name: string;
  expected: Record<string, unknown>;
}

export interface Manifest {
  site: string;
  project: string;
  space: string;
  owner: { accountId: string; name: string };
  needles: Needle[];
  jira: { issues: ManifestIssue[] };
  confluence: { pages: ManifestPage[] };
}

function rec(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`manifest ${what} is not an object`);
  }
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`manifest ${what} is not a string`);
  }
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`manifest ${what} is not an array`);
  }
  return value;
}

export function loadManifest(): Manifest {
  const root = rec(JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")), "root");
  const owner = rec(root.owner, "owner");
  return {
    site: str(root.site, "site"),
    project: str(root.project, "project"),
    space: str(root.space, "space"),
    owner: { accountId: str(owner.accountId, "owner.accountId"), name: str(owner.name, "owner.name") },
    needles: list(root.needles, "needles").map((entry) => {
      const item = rec(entry, "needle");
      return { n: Number(item.n), name: str(item.name, "needle.name"), expected: rec(item.expected, "needle.expected") };
    }),
    jira: {
      issues: list(rec(root.jira, "jira").issues, "jira.issues").map((entry) => {
        const item = rec(entry, "issue");
        return {
          key: str(item.key, "issue.key"),
          type: str(item.type, "issue.type"),
          summary: str(item.summary, "issue.summary"),
          parent: typeof item.parent === "string" ? item.parent : null,
          status: str(item.status, "issue.status"),
          labels: list(item.labels, "issue.labels").map((label) => str(label, "issue.label")),
        };
      }),
    },
    confluence: {
      pages: list(rec(root.confluence, "confluence").pages, "confluence.pages").map((entry) => {
        const item = rec(entry, "page");
        return {
          id: str(item.id, "page.id"),
          title: str(item.title, "page.title"),
          parentId: typeof item.parentId === "string" ? item.parentId : "",
          ref: str(item.ref, "page.ref"),
        };
      }),
    },
  };
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function needle(manifest: Manifest, name: string): Record<string, unknown> {
  const found = manifest.needles.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`manifest has no needle ${name}`);
  }
  return found.expected;
}

export function pageByTitle(manifest: Manifest, title: string): ManifestPage {
  const found = manifest.confluence.pages.find((page) => page.title === title);
  if (found === undefined) {
    throw new Error(`manifest has no page titled ${title}`);
  }
  return found;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
