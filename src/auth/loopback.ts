import { AtlError } from "../core/errors.ts";

export const DEFAULT_PORT = 47923;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PATH = "/callback";

export interface CallbackListener {
  /** Bound port (differs from the request when 0 was given). */
  port: number;
  /** Redirect URI to register and send to the authorize endpoint. Host stays `localhost` like omp's. */
  redirectUri: string;
  /** Resolves with the authorization code; rejects on provider error, timeout or abort. */
  result: Promise<string>;
  /** Idempotent; also invoked automatically when `result` settles. */
  stop(): void;
}

export interface CallbackOptions {
  port?: number | undefined;
  state: string;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/g, (c) => `&#${c.codePointAt(0) ?? 0};`);
}

function page(status: number, title: string, message: string): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    },
  });
}

function providerError(error: string, description: string | null): AtlError {
  const detail = description ? `${error}: ${description}` : error;
  if (error === "access_denied") {
    return new AtlError(`Authorization was denied (${detail})`, {
      code: "consent_denied",
      category: "auth",
    });
  }
  if (error === "server_error" || error === "temporarily_unavailable") {
    return new AtlError(`Atlassian's consent page failed (${detail})`, {
      code: "consent_unreachable",
      category: "transient",
      hint: "Atlassian's consent endpoint is intermittently unavailable (429/5xx during outages); retry shortly.",
    });
  }
  return new AtlError(`Authorization failed (${detail})`, {
    code: "authorization_failed",
    category: "auth",
  });
}

function bindError(error: unknown, port: number): AtlError {
  const inUse =
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
  return new AtlError(
    inUse
      ? `Port ${port} is already in use`
      : `Cannot start the login callback server: ${error instanceof Error ? error.message : String(error)}`,
    {
      code: inUse ? "port_in_use" : "loopback_failed",
      category: "config",
      hint: "Pick another port with --port.",
      cause: error,
    },
  );
}

/**
 * Starts the loopback server on 127.0.0.1 and, at the same port, on ::1, so the `localhost`
 * redirect works whichever address the browser resolves it to. Hosts without IPv6 loopback get
 * IPv4 only. Requests with a wrong `state` get a 400 and are ignored, so a stray request cannot
 * abort a login in progress.
 */
export function startCallbackServer(options: CallbackOptions): CallbackListener {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // Callers attach handlers later (after discovery/registration); avoid an unhandled rejection meanwhile.
  promise.catch(() => {});

  const handle = (request: Request): Response => {
    const url = new URL(request.url);
    if (url.pathname !== CALLBACK_PATH) {
      return page(404, "Not found", "Nothing to see here.");
    }
    if (url.searchParams.get("state") !== options.state) {
      return page(
        400,
        "Login failed",
        "The state parameter did not match. Start the login again from the terminal.",
      );
    }
    const error = url.searchParams.get("error");
    if (error) {
      reject(providerError(error, url.searchParams.get("error_description")));
      return page(
        400,
        "Login failed",
        "Atlassian reported an error. Return to the terminal for details.",
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      return page(400, "Login failed", "The callback carried no authorization code.");
    }
    resolve(code);
    return page(200, "Logged in", "You can close this tab and return to the terminal.");
  };

  const requestedPort = options.port ?? DEFAULT_PORT;
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: requestedPort, fetch: handle });
  } catch (error) {
    throw bindError(error, requestedPort);
  }

  const port = server.port;
  if (port === undefined) {
    void server.stop(true);
    throw new AtlError("Login callback server has no port", {
      code: "loopback_failed",
      category: "internal",
    });
  }

  let server6: Bun.Server<undefined> | undefined;
  try {
    server6 = Bun.serve({ hostname: "::1", port, fetch: handle });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") {
      void server.stop(true);
      throw bindError(error, port);
    }
  }

  const timer = setTimeout(() => {
    reject(
      new AtlError("Timed out waiting for the browser login to complete", {
        code: "login_timeout",
        category: "auth",
        hint: "Open the printed authorize URL, or retry; Atlassian's consent page may be unavailable.",
        next: [["atl", "auth", "login"]],
      }),
    );
  }, timeoutMs);

  const onAbort = () =>
    reject(new AtlError("Login aborted", { code: "aborted", category: "input" }));
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // Non-forced: lets the in-flight callback response finish before closing.
    void server.stop();
    void server6?.stop();
  };
  promise.then(stop, stop);

  return { port, redirectUri: `http://localhost:${port}${CALLBACK_PATH}`, result: promise, stop };
}
