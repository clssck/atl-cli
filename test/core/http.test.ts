import { describe, expect, test } from "bun:test";
import { AtlError, type ErrorCategory } from "../../src/core/errors.ts";
import {
  HttpClient,
  buildUrl,
  extractErrorMessage,
  parseRetryAfter,
  type FetchLike,
} from "../../src/core/http.ts";
import { USER_AGENT } from "../../src/version.ts";

interface Recorded {
  url: string;
  init: RequestInit;
}

function harness(responses: (Response | Error)[]): {
  client: HttpClient;
  calls: Recorded[];
  sleeps: number[];
} {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchFake: FetchLike = (url, init) => {
    calls.push({ url, init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("fake fetch exhausted"));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  };
  const client = new HttpClient({
    getToken: () => Promise.resolve("tok-123"),
    fetch: fetchFake,
    timeoutMs: 1000,
    stderr: () => {},
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { client, calls, sleeps };
}

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** Index into an array, failing the test instead of yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}`);
  }
  return item;
}

async function failure(promise: Promise<unknown>): Promise<AtlError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AtlError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected rejection");
}

const URL_ = "https://api.atlassian.com/ex/confluence/cid/wiki/api/v2/pages/1";

describe("buildUrl", () => {
  test("joins base and path, drops undefined, repeats arrays", () => {
    const url = buildUrl("https://api.atlassian.com/ex/jira/cid/", "/rest/api/3/search", {
      jql: "a = b",
      limit: 5,
      skip: undefined,
      fields: ["summary", "status"],
      expand: true,
    });
    expect(url).toBe(
      "https://api.atlassian.com/ex/jira/cid/rest/api/3/search?jql=a+%3D+b&limit=5&fields=summary&fields=status&expand=true",
    );
  });

  test("path without leading slash and no query", () => {
    expect(buildUrl("https://x.test/base", "p")).toBe("https://x.test/base/p");
  });
});

describe("request", () => {
  test("sends auth, accept, user agent; parses JSON; content-type only with a body", async () => {
    const { client, calls } = harness([json({ ok: 1 }), json({ id: 2 })]);
    expect(await client.request({ method: "GET", url: URL_, query: { a: "b" } })).toEqual({
      ok: 1,
    });
    expect(await client.request({ method: "POST", url: URL_, body: { t: 1 } })).toEqual({ id: 2 });

    const get = at(calls, 0);
    expect(get.url).toBe(`${URL_}?a=b`);
    expect(get.init.headers).toMatchObject({
      Authorization: "Bearer tok-123",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    });
    expect(get.init.headers).not.toHaveProperty("Content-Type");
    const post = at(calls, 1);
    expect(post.init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(post.init.body).toBe('{"t":1}');
  });

  test("204 is undefined; non-JSON content is text; accept can be overridden", async () => {
    const { client, calls } = harness([
      new Response(null, { status: 204 }),
      new Response("plain", { headers: { "content-type": "text/plain" } }),
    ]);
    expect(await client.request({ method: "DELETE", url: URL_ })).toBeUndefined();
    expect(await client.request({ method: "GET", url: URL_, accept: "text/plain" })).toBe("plain");
    expect(at(calls, 1).init.headers).toMatchObject({ Accept: "text/plain" });
  });
});

describe("error mapping", () => {
  const cases: [number, unknown, { category: ErrorCategory; code: string }][] = [
    [401, { message: "scope does not match" }, { category: "auth", code: "http_401" }],
    [403, { message: "Forbidden" }, { category: "auth", code: "http_403" }],
    [404, { errorMessages: ["Issue does not exist"] }, { category: "api", code: "http_404" }],
    [409, { message: "Version conflict" }, { category: "transient", code: "http_409" }],
    [400, { errors: { summary: "required" } }, { category: "api", code: "http_400" }],
    [422, { message: "bad" }, { category: "api", code: "http_422" }],
  ];

  for (const [status, body, expected] of cases) {
    test(`HTTP ${status} -> ${expected.category}/${expected.code}`, async () => {
      const { client, calls } = harness([json(body, { status })]);
      const error = await failure(
        client.request({ method: "POST", url: `${URL_}?secret=1`, body: {} }),
      );
      expect(error.category).toBe(expected.category);
      expect(error.code).toBe(expected.code);
      expect(error.status).toBe(status);
      expect(error.message).toContain("POST /ex/confluence/cid/wiki/api/v2/pages/1");
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("tok-123");
      expect(calls).toHaveLength(1);
    });
  }

  test("401 hint carries the server message and points at auth status", async () => {
    const { client } = harness([
      json({ message: "Unauthorized; scope does not match" }, { status: 401 }),
    ]);
    const error = await failure(client.request({ method: "GET", url: URL_ }));
    expect(error.hint).toContain("scope does not match");
    expect(error.hint).toContain("expired");
    expect(error.next).toEqual([["atl", "auth", "status"]]);
    expect(error.exitCode).toBe(1);
  });

  test("409 hint says to re-read and retry; exit code 3", async () => {
    const { client } = harness([json({}, { status: 409 })]);
    const error = await failure(client.request({ method: "PUT", url: URL_, body: {} }));
    expect(error.hint).toContain("Re-read");
    expect(error.exitCode).toBe(3);
  });

  test("429 and 5xx are transient on writes (no retry)", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { client, calls, sleeps } = harness([json({}, { status })]);
      const error = await failure(client.request({ method: "POST", url: URL_, body: {} }));
      expect(error.category).toBe("transient");
      expect(error.code).toBe(`http_${status}`);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  test("500 on GET is transient but not retried", async () => {
    const { client, calls } = harness([json({}, { status: 500 })]);
    const error = await failure(client.request({ method: "GET", url: URL_ }));
    expect(error.category).toBe("transient");
    expect(calls).toHaveLength(1);
  });

  test("timeout and network failures on writes say the outcome is unknown, on reads they stay retryable", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const a = await failure(
      harness([timeout]).client.request({ method: "POST", url: URL_, body: {} }),
    );
    expect(a.code).toBe("write_outcome_unknown");
    expect(a.category).toBe("transient");
    expect(a.exitCode).toBe(3);
    expect(a.hint).toContain("may have been applied");
    expect(a.hint).not.toMatch(/safe to retry|or retry\./);
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const reset = await failure(
        harness([new TypeError("fetch failed")]).client.request({ method, url: URL_ }),
      );
      expect(reset.code).toBe("write_outcome_unknown");
      expect(reset.exitCode).toBe(3);
    }
    const read = await failure(
      harness([timeout, timeout, timeout]).client.request({ method: "GET", url: URL_ }),
    );
    expect(read.code).toBe("timeout");
    expect(read.hint).toContain("retry");
  });

  test("invalid JSON in a 200 is an internal error", async () => {
    const { client } = harness([
      new Response("{nope", { headers: { "content-type": "application/json" } }),
    ]);
    const error = await failure(client.request({ method: "GET", url: URL_ }));
    expect(error.code).toBe("invalid_json");
  });
});

describe("retries", () => {
  test("GET retries 503 honoring Retry-After seconds, then succeeds", async () => {
    const { client, calls, sleeps } = harness([
      json({}, { status: 503, headers: { "retry-after": "2" } }),
      json({ ok: true }),
    ]);
    expect(await client.request({ method: "GET", url: URL_ })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  test("a Retry-After beyond the retry budget fails fast with a when-to-retry hint", async () => {
    const { client, calls, sleeps } = harness([
      json({ message: "slow down" }, { status: 429, headers: { "retry-after": "999" } }),
      json({}),
    ]);
    const error = await failure(client.request({ method: "GET", url: URL_ }));
    expect(error.category).toBe("transient");
    expect(error.exitCode).toBe(3);
    expect(error.status).toBe(429);
    expect(error.hint).toContain("999 s");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("the budget is total across retries: the second wait that would exceed it stops", async () => {
    const { client, calls, sleeps } = harness([
      json({}, { status: 503, headers: { "retry-after": "12" } }),
      json({}, { status: 503, headers: { "retry-after": "12" } }),
      json({}),
    ]);
    const error = await failure(client.request({ method: "GET", url: URL_ }));
    expect(error.exitCode).toBe(3);
    expect(error.hint).toContain("12 s");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([12_000]);
  });

  test("retries within the budget succeed and emit one retry diagnostic each", async () => {
    const stderr: string[] = [];
    const sleeps: number[] = [];
    const queue = [
      json({}, { status: 429, headers: { "retry-after": "8" } }),
      json({}, { status: 503, headers: { "retry-after": "10" } }),
      json({ ok: true }),
    ];
    const client = new HttpClient({
      getToken: () => Promise.resolve("tok-123"),
      fetch: () => Promise.resolve(queue.shift() ?? json({})),
      timeoutMs: 1000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      stderr: (text) => {
        stderr.push(text);
      },
    });
    expect(await client.request({ method: "GET", url: `${URL_}?secret=1` })).toEqual({ ok: true });
    expect(sleeps).toEqual([8000, 10_000]);
    expect(stderr.map((line) => JSON.parse(line))).toEqual([
      { type: "retry", status: 429, attempt: 1, waitMs: 8000, path: new URL(URL_).pathname },
      { type: "retry", status: 503, attempt: 2, waitMs: 10_000, path: new URL(URL_).pathname },
    ]);
    expect(stderr.join("")).not.toContain("secret");
  });

  test("without Retry-After uses jittered exponential backoff", async () => {
    const { client, sleeps } = harness([
      json({}, { status: 502 }),
      json({}, { status: 502 }),
      json({}),
    ]);
    await client.request({ method: "GET", url: URL_ });
    expect(sleeps).toHaveLength(2);
    expect(at(sleeps, 0)).toBeGreaterThanOrEqual(250);
    expect(at(sleeps, 0)).toBeLessThanOrEqual(500);
    expect(at(sleeps, 1)).toBeGreaterThanOrEqual(500);
    expect(at(sleeps, 1)).toBeLessThanOrEqual(1000);
  });

  test("gives up after 3 attempts total with a transient error", async () => {
    const { client, calls } = harness([
      json({}, { status: 503 }),
      json({}, { status: 503 }),
      json({ message: "still down" }, { status: 503 }),
      json({}),
    ]);
    const error = await failure(client.request({ method: "GET", url: URL_ }));
    expect(calls).toHaveLength(3);
    expect(error.category).toBe("transient");
    expect(error.status).toBe(503);
    expect(error.message).toContain("still down");
  });

  test("GET retries network errors; HEAD too", async () => {
    const { client, calls } = harness([new TypeError("fetch failed"), json({ ok: 1 })]);
    expect(await client.request({ method: "GET", url: URL_ })).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    const head = harness([new TypeError("x"), new Response(null, { status: 204 })]);
    expect(await head.client.request({ method: "HEAD", url: URL_ })).toBeUndefined();
  });

  test("POST is never retried, even on 503 with Retry-After or network errors", async () => {
    const { client, calls, sleeps } = harness([
      json({}, { status: 503, headers: { "retry-after": "1" } }),
      json({ ok: true }),
    ]);
    const error = await failure(client.request({ method: "POST", url: URL_, body: { a: 1 } }));
    expect(error.status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);

    const net = harness([new TypeError("fetch failed"), json({})]);
    await failure(net.client.request({ method: "PUT", url: URL_, body: {} }));
    expect(net.calls).toHaveLength(1);
  });

  test("non-retryable statuses on GET are not retried", async () => {
    const { client, calls } = harness([json({}, { status: 404 }), json({})]);
    await failure(client.request({ method: "GET", url: URL_ }));
    expect(calls).toHaveLength(1);
  });
});

const API_URL = "https://api.atlassian.com/ex/jira/c1/rest/api/3/attachment/content/1";
const MEDIA_URL = "https://api.media.atlassian.com/file/abc/binary?token=signed";

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function header(call: Recorded, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

describe("requestRaw", () => {
  test("sends the token to the API origin and returns the unread response", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const { client, calls } = harness([new Response(bytes)]);
    const response = await client.requestRaw({ method: "GET", url: API_URL });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const call = at(calls, 0);
    expect(header(call, "authorization")).toBe("Bearer tok-123");
    expect(header(call, "user-agent")).toBe(USER_AGENT);
    expect(header(call, "accept")).toBe("*/*");
    expect(call.init.redirect).toBe("manual");
  });

  test("multipart body and extra headers pass through; no JSON content-type is set", async () => {
    const { client, calls } = harness([json([{ id: "1" }])]);
    const form = new FormData();
    form.append("file", new File(["hi"], "a.txt"));
    await client.requestRaw({
      method: "POST",
      url: API_URL,
      body: form,
      accept: "application/json",
      headers: { "X-Atlassian-Token": "no-check", Authorization: "Bearer attacker" },
    });
    const call = at(calls, 0);
    expect(call.init.body).toBe(form);
    expect(header(call, "content-type")).toBeNull();
    expect(header(call, "x-atlassian-token")).toBe("no-check");
    expect(header(call, "accept")).toBe("application/json");
    expect(header(call, "authorization")).toBe("Bearer tok-123");
  });

  test("a cross-origin redirect hop carries no Authorization, even one passed by the caller", async () => {
    const { client, calls } = harness([redirect(MEDIA_URL), new Response("payload")]);
    const response = await client.requestRaw({
      method: "GET",
      url: API_URL,
      headers: { Authorization: "Bearer attacker" },
    });
    expect(await response.text()).toBe("payload");
    expect(calls.map((c) => c.url)).toEqual([API_URL, MEDIA_URL]);
    expect(header(at(calls, 0), "authorization")).toBe("Bearer tok-123");
    expect(header(at(calls, 1), "authorization")).toBeNull();
  });

  test("a redirect back to the API origin is authorized again", async () => {
    const { client, calls } = harness([redirect(MEDIA_URL), redirect(API_URL), new Response("ok")]);
    await client.requestRaw({ method: "GET", url: API_URL });
    expect(header(at(calls, 1), "authorization")).toBeNull();
    expect(header(at(calls, 2), "authorization")).toBe("Bearer tok-123");
  });

  test("a redirect to http is refused before anything is sent to it", async () => {
    const { client, calls } = harness([redirect("http://api.atlassian.com/steal"), json({})]);
    const error = await failure(client.requestRaw({ method: "GET", url: API_URL }));
    expect(error.code).toBe("insecure_url");
    expect(calls).toHaveLength(1);
  });

  test("an http request URL is refused outright", async () => {
    const { client, calls } = harness([json({})]);
    const error = await failure(
      client.requestRaw({ method: "GET", url: "http://api.atlassian.com/x" }),
    );
    expect(error.code).toBe("insecure_url");
    expect(calls).toHaveLength(0);
  });

  test("303 turns a POST into a bodyless GET; 307 keeps method and body", async () => {
    const see = harness([redirect("/next", 303), new Response("ok")]);
    await see.client.requestRaw({ method: "POST", url: API_URL, body: "x" });
    expect(at(see.calls, 1).init.method).toBe("GET");
    expect(at(see.calls, 1).init.body).toBeUndefined();

    const keep = harness([redirect("/next", 307), new Response("ok")]);
    await keep.client.requestRaw({ method: "POST", url: API_URL, body: "x" });
    expect(at(keep.calls, 1).init.method).toBe("POST");
    expect(at(keep.calls, 1).init.body).toBe("x");
  });

  test("redirect loops stop with too_many_redirects", async () => {
    const { client, calls } = harness(Array.from({ length: 10 }, () => redirect(API_URL)));
    const error = await failure(client.requestRaw({ method: "GET", url: API_URL }));
    expect(error.code).toBe("too_many_redirects");
    expect(calls).toHaveLength(6);
  });

  test("non-2xx maps like request: status, category, server message", async () => {
    const { client } = harness([
      json({ errorMessages: ["Issue does not exist"] }, { status: 404 }),
    ]);
    const error = await failure(client.requestRaw({ method: "GET", url: API_URL }));
    expect(error.code).toBe("http_404");
    expect(error.status).toBe(404);
    expect(error.category).toBe("api");
    expect(error.message).toBe(
      "GET /ex/jira/c1/rest/api/3/attachment/content/1 failed with HTTP 404: Issue does not exist",
    );

    const denied = harness([json({}, { status: 403 })]);
    expect(
      (await failure(denied.client.requestRaw({ method: "GET", url: API_URL }))).category,
    ).toBe("auth");
  });

  test("a non-2xx behind a redirect is mapped against the requested URL", async () => {
    const { client } = harness([redirect(MEDIA_URL), new Response("gone", { status: 410 })]);
    const error = await failure(client.requestRaw({ method: "GET", url: API_URL }));
    expect(error.status).toBe(410);
    expect(error.message).toContain("/attachment/content/1");
  });

  test("GET retries on 503 within the budget; POST sends once", async () => {
    const get = harness([json({}, { status: 503 }), new Response("ok")]);
    expect(await (await get.client.requestRaw({ method: "GET", url: API_URL })).text()).toBe("ok");
    expect(get.calls).toHaveLength(2);
    expect(get.sleeps).toHaveLength(1);

    const post = harness([json({}, { status: 503 }), new Response("ok")]);
    const error = await failure(
      post.client.requestRaw({ method: "POST", url: API_URL, body: "x" }),
    );
    expect(error.status).toBe(503);
    expect(post.calls).toHaveLength(1);
  });

  test("network errors on a POST say the outcome is unknown", async () => {
    const { client } = harness([new TypeError("fetch failed")]);
    const error = await failure(client.requestRaw({ method: "POST", url: API_URL, body: "x" }));
    expect(error.code).toBe("write_outcome_unknown");
  });
});

describe("parseRetryAfter", () => {
  test("seconds, HTTP date, junk, absent", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-10-21T10:00:00Z");
    expect(parseRetryAfter("Wed, 21 Oct 2026 10:00:07 GMT", now)).toBe(7000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 09:00:00 GMT", now)).toBe(0);
  });
});

describe("extractErrorMessage", () => {
  test("common Atlassian shapes", () => {
    expect(extractErrorMessage('{"errorMessages":["a","b"],"errors":{"summary":"req"}}')).toBe(
      "a; b; summary: req",
    );
    expect(extractErrorMessage('{"message":"m"}')).toBe("m");
    expect(extractErrorMessage('{"error":"invalid_grant","error_description":"expired"}')).toBe(
      "expired; invalid_grant",
    );
    expect(extractErrorMessage('{"errors":[{"status":400,"title":"Bad","detail":"why"}]}')).toBe(
      "Bad: why",
    );
  });

  test("non-JSON text is used verbatim; empty and shapeless give undefined", () => {
    expect(extractErrorMessage("upstream timeout")).toBe("upstream timeout");
    expect(extractErrorMessage("  ")).toBeUndefined();
    expect(extractErrorMessage('{"unrelated":1}')).toBeUndefined();
  });

  test("truncates to 500 characters", () => {
    const message = extractErrorMessage(JSON.stringify({ message: "x".repeat(2000) }));
    expect(message?.length).toBe(500);
    expect(message?.endsWith("...")).toBe(true);
  });

  test("an HTML error page reduces to its title, never the markup or CSS", () => {
    const page = `<!doctype html><html lang="en"><head><title>HTTP Status 429 &ndash; Too Many Requests</title><style type="text/css">body {font-family:Tahoma;} ${"h1 {color:white;} ".repeat(40)}</style></head><body><h1>HTTP Status 429 - Too Many Requests</h1><hr class="line" /><p><b>Type</b> Status Report</p></body></html>`;
    expect(extractErrorMessage(page)).toBe("HTTP Status 429 &ndash; Too Many Requests");
    expect(
      extractErrorMessage("<html><body><h1>Bad &amp; gateway</h1><p>x</p></body></html>"),
    ).toBe("Bad & gateway");
    const stripped = extractErrorMessage(
      `<html><body><style>.a{}</style><div>Service <b>unavailable</b></div>${"<p>word </p>".repeat(100)}</body></html>`,
    );
    expect(stripped?.startsWith("Service unavailable word word")).toBe(true);
    expect(stripped?.length).toBeLessThanOrEqual(200);
    expect(stripped).not.toContain("<");
  });

  test("a rate-limited response with an HTML body keeps the message short and the Retry-After hint", async () => {
    const page = `<html><head><title>HTTP Status 429 - Too Many Requests</title><style>${"x".repeat(900)}</style></head><body></body></html>`;
    const { client } = harness([
      new Response(page, {
        status: 429,
        headers: { "content-type": "text/html", "retry-after": "533" },
      }),
    ]);
    const error = await failure(client.request({ method: "POST", url: URL_, body: {} }));
    expect(error.message).toBe(
      "POST /ex/confluence/cid/wiki/api/v2/pages/1 failed with HTTP 429: HTTP Status 429 - Too Many Requests",
    );
    expect(error.hint).toContain("533");
  });
});
