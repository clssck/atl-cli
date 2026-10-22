import { USER_AGENT } from "../version.ts";
import { AtlError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { type Writer, writeDiagnostic, writeStderr } from "./output.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue =
  | string
  | number
  | boolean
  | undefined
  | readonly (string | number | boolean)[];
export type Query = Readonly<Record<string, QueryValue>>;

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpClientOptions {
  getToken: () => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives one JSONL `retry` diagnostic per retry; defaults to stderr. */
  stderr?: Writer;
}

export interface RequestOptions {
  method: HttpMethod;
  /** Absolute URL; `query` is appended to any existing query string. */
  url: string;
  query?: Query;
  /** JSON-serialized when present. */
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  /** Overrides the default `Accept: application/json`. */
  accept?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
/**
 * Total sleep allowed across one request's retries. Agent harnesses cut foreground commands at
 * about 60 s; with request timeouts on top, longer waits would get the whole command killed, so a
 * Retry-After past the remaining budget fails fast (exit 3) with a hint saying when to retry.
 */
export const RETRY_BUDGET_MS = 20_000;
const BASE_BACKOFF_MS = 500;
const MAX_ERROR_MESSAGE_CHARS = 500;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

function appendQuery(url: URL, query: Query | undefined): void {
  if (query === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "object") {
      for (const element of value) {
        url.searchParams.append(key, String(element));
      }
    } else {
      url.searchParams.append(key, String(value));
    }
  }
}

/** Join `base` and `path` and append `query`; undefined values are dropped, arrays repeat the key. */
export function buildUrl(base: string, path: string, query?: Query): string {
  const joined = /^https?:\/\//i.test(path)
    ? path
    : `${base.replace(/\/+$/, "")}${path === "" || path.startsWith("/") ? path : `/${path}`}`;
  const url = new URL(joined);
  appendQuery(url, query);
  return url.toString();
}

/** `Retry-After` as delay in ms from seconds or an HTTP date; undefined when absent or unparseable. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - now);
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS - 3)}...`
    : text;
}

function describeEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  const parts = ["title", "detail", "message"]
    .map((key) => entry[key])
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(": ") : undefined;
}

/**
 * Pull a human message out of common Atlassian error bodies: `errorMessages[]`, `errors{}` or
 * `errors[]`, `message`, `error_description`, `error`. Non-JSON bodies are used verbatim.
 * Result is truncated to 500 characters; undefined when the body carries nothing useful.
 */
export function extractErrorMessage(bodyText: string): string | undefined {
  const text = bodyText.trim();
  if (text === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return truncate(text);
  }
  if (!isRecord(parsed)) {
    return typeof parsed === "string" ? truncate(parsed) : undefined;
  }

  const parts: string[] = [];
  if (Array.isArray(parsed.errorMessages)) {
    for (const entry of parsed.errorMessages as unknown[]) {
      const described = describeEntry(entry);
      if (described !== undefined) {
        parts.push(described);
      }
    }
  }
  if (Array.isArray(parsed.errors)) {
    for (const entry of parsed.errors as unknown[]) {
      const described = describeEntry(entry);
      if (described !== undefined) {
        parts.push(described);
      }
    }
  } else if (isRecord(parsed.errors)) {
    for (const [key, value] of Object.entries(parsed.errors)) {
      if (typeof value === "string") {
        parts.push(`${key}: ${value}`);
      }
    }
  }
  for (const key of ["message", "error_description", "error"]) {
    const value = parsed[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.length === 0 ? undefined : truncate(parts.join("; "));
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Map a non-2xx response to an AtlError. Never includes headers or tokens. */
export function mapHttpError(
  method: string,
  url: string,
  status: number,
  bodyText: string,
): AtlError {
  const server = extractErrorMessage(bodyText);
  const message = `${method} ${urlPath(url)} failed with HTTP ${status}${server === undefined ? "" : `: ${server}`}`;
  const code = `http_${status}`;
  const serverNote = server === undefined ? "" : ` Server said: ${server}`;

  if (status === 401) {
    return new AtlError(message, {
      code,
      category: "auth",
      status,
      hint: `Token expired, revoked, or missing a required scope.${serverNote}`,
      next: [["atl", "auth", "status"]],
    });
  }
  if (status === 403) {
    return new AtlError(message, {
      code,
      category: "auth",
      status,
      hint: `Access denied: the account lacks permission or the token lacks the scope.${serverNote}`,
      next: [["atl", "auth", "status"]],
    });
  }
  if (status === 404) {
    return new AtlError(message, {
      code,
      category: "api",
      status,
      hint: "Not found: check the id, key, or URL, and that --site points at the right site.",
    });
  }
  if (status === 409) {
    return new AtlError(message, {
      code,
      category: "transient",
      status,
      hint: "Conflict: the resource changed. Re-read it and retry with the current version.",
    });
  }
  if (status === 429 || status >= 500) {
    return new AtlError(message, {
      code,
      category: "transient",
      status,
      hint: "Temporary server-side failure or rate limit. Retry shortly.",
    });
  }
  return new AtlError(message, { code, category: "api", status });
}

function networkError(method: string, url: string, error: unknown, timeoutMs: number): AtlError {
  const path = urlPath(url);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new AtlError(`${method} ${path} timed out after ${timeoutMs} ms`, {
      code: "timeout",
      category: "transient",
      hint: "Raise ATL_TIMEOUT_MS or retry.",
      cause: error,
    });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new AtlError(`${method} ${path} failed: ${detail}`, {
    code: "network_error",
    category: "transient",
    hint: "Network failure; check connectivity and retry.",
    cause: error,
  });
}

export function resolveTimeout(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const fromEnv = Number(process.env.ATL_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

export class HttpClient {
  readonly #getToken: () => Promise<string>;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #stderr: Writer;

  constructor(options: HttpClientOptions) {
    this.#getToken = options.getToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = resolveTimeout(options.timeoutMs);
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.#stderr = options.stderr ?? writeStderr;
  }

  /**
   * Send one request and return parsed JSON, text for non-JSON content, or undefined for 204.
   * GET/HEAD retry on 429/502/503/504 and network/timeout errors (3 attempts total, at most
   * `RETRY_BUDGET_MS` of sleep); writes never retry.
   */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const { method } = options;
    const idempotent = method === "GET" || method === "HEAD";
    const url = buildUrl(options.url, "", options.query);
    const maxAttempts = idempotent ? MAX_ATTEMPTS : 1;
    let slept = 0;

    for (let attempt = 1; ; attempt++) {
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
      const retry = async (waitMs: number, status?: number): Promise<void> => {
        writeDiagnostic(
          { type: "retry", status, attempt, waitMs: Math.round(waitMs), path: urlPath(url) },
          this.#stderr,
        );
        slept += waitMs;
        await this.#sleep(waitMs);
      };

      let response: Response;
      try {
        response = await this.#send(url, options);
      } catch (error) {
        if (error instanceof AtlError) {
          throw error;
        }
        if (attempt < maxAttempts && slept + backoff <= RETRY_BUDGET_MS) {
          await retry(backoff);
          continue;
        }
        throw networkError(method, url, error, this.#timeoutMs);
      }

      if (response.ok) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON boundary; each caller declares the response shape via T
        return (await this.#parse(response, method, url)) as T;
      }

      const { status } = response;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (attempt < maxAttempts && RETRYABLE_STATUSES.has(status)) {
        const waitMs = retryAfter ?? backoff;
        if (slept + waitMs <= RETRY_BUDGET_MS) {
          await response.body?.cancel();
          await retry(waitMs, status);
          continue;
        }
      }
      const error = mapHttpError(method, url, status, await response.text().catch(() => ""));
      if (retryAfter === undefined || error.category !== "transient") {
        throw error;
      }
      const seconds = Math.ceil(retryAfter / 1000);
      throw new AtlError(error.message, {
        code: error.code,
        category: error.category,
        status,
        hint: `Rate limited or unavailable; the server asks to retry after ${seconds} s (Retry-After). Rerun then.`,
      });
    }
  }

  async #send(url: string, options: RequestOptions): Promise<Response> {
    const token = await this.#getToken();
    const headers: Record<string, string> = {
      Accept: options.accept ?? "application/json",
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    };
    const hasBody = options.body !== undefined;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    return this.#fetch(url, {
      method: options.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  async #parse(response: Response, method: string, url: string): Promise<unknown> {
    if (response.status === 204) {
      return undefined;
    }
    const contentType = response.headers.get("content-type") ?? "";
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw networkError(method, url, error, this.#timeoutMs);
    }
    if (!/json/i.test(contentType)) {
      return text;
    }
    if (text.trim() === "") {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new AtlError(`${method} ${urlPath(url)} returned invalid JSON`, {
        code: "invalid_json",
        category: "internal",
        cause: error,
      });
    }
  }
}
