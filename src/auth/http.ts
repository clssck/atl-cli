import type { Static, TSchema } from "../core/schema.ts";
import { Type } from "../core/schema.ts";
import { AtlError } from "../core/errors.ts";
import { type FetchLike, resolveTimeout } from "../core/http.ts";
import { check } from "../core/validate.ts";
import { USER_AGENT } from "../version.ts";

export interface SendOptions {
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Human label used in error messages, e.g. "token refresh". */
  what: string;
}

export interface SendInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

const TRANSIENT_HINT =
  "Atlassian's auth endpoints return 429/5xx during outages; retry shortly. Existing tokens keep working against REST.";

export function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Sends one request with the atl User-Agent; network failures and timeouts become transient AtlErrors. */
export async function send(url: string, init: SendInit, options: SendOptions): Promise<Response> {
  const fetchFn: FetchLike = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(resolveTimeout(options.timeoutMs));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await fetchFn(url, {
      ...init,
      headers: { ...init.headers, "User-Agent": USER_AGENT },
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new AtlError(`${options.what} aborted`, {
        code: "aborted",
        category: "input",
        cause: error,
      });
    }
    if (timeout.aborted) {
      throw new AtlError(`${options.what} timed out`, {
        code: "request_timeout",
        category: "transient",
        hint: TRANSIENT_HINT,
        cause: error,
      });
    }
    throw new AtlError(`${options.what} failed: network error`, {
      code: "network_error",
      category: "transient",
      hint: TRANSIENT_HINT,
      cause: error,
    });
  }
}

const OAuthErrorBody = Type.Object({
  error: Type.Optional(Type.String()),
  error_description: Type.Optional(Type.String()),
});

async function readOAuthError(response: Response): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (!check(OAuthErrorBody, parsed)) {
    return undefined;
  }
  const { error, error_description: description } = parsed;
  if (error && description) {
    return `${error}: ${description.slice(0, 200)}`;
  }
  return error ?? description?.slice(0, 200);
}

/**
 * Maps a non-2xx response to an AtlError: 429/5xx are `transient` (code `http_<status>`),
 * everything else uses `code` with category `auth`. Only the OAuth `error`/`error_description`
 * fields of the body are surfaced.
 */
export async function responseError(
  response: Response,
  what: string,
  code: string,
): Promise<AtlError> {
  const detail = await readOAuthError(response);
  const suffix = detail ? `: ${detail}` : "";
  if (isTransientStatus(response.status)) {
    return new AtlError(`${what} failed (HTTP ${response.status})${suffix}`, {
      code: `http_${response.status}`,
      category: "transient",
      hint: TRANSIENT_HINT,
      status: response.status,
    });
  }
  return new AtlError(`${what} failed (HTTP ${response.status})${suffix}`, {
    code,
    category: "auth",
    status: response.status,
  });
}

/** Parses a JSON body against a schema; malformed or mismatching bodies become `auth` errors with `code`. */
export async function readJson<S extends TSchema>(
  response: Response,
  schema: S,
  what: string,
  code: string,
): Promise<Static<S>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new AtlError(`${what} returned a non-JSON response`, {
      code,
      category: "auth",
      cause: error,
    });
  }
  if (!check(schema, parsed)) {
    throw new AtlError(`${what} returned an unexpected response shape`, { code, category: "auth" });
  }
  return parsed;
}

export function formBody(params: Record<string, string | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      body.set(key, value);
    }
  }
  return body.toString();
}
