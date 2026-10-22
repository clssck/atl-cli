import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WatchResult,
  collect,
  diff,
  fingerprint,
  GITHUB_RAW,
  main,
  MCP_ORIGIN,
  REGISTRY_URL,
  renderIssueBody,
} from "../../scripts/mcp-watch.ts";
import type { FetchLike } from "../../src/core/http.ts";

const REGISTRY_SEARCH = `${REGISTRY_URL}?search=com.atlassian/atlassian-mcp-server`;

interface Upstream {
  serverVersion: string;
  remotes: string[];
  scopes: string[];
  v3: boolean;
  failUrls?: string[];
}

const BASE: Upstream = {
  serverVersion: "2.0.0",
  remotes: ["https://mcp.atlassian.com/v2/mcp", "https://mcp.atlassian.com/v1/mcp/authv2"],
  scopes: ["read:me", "offline_access", "read:jira-work"],
  v3: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(upstream: Upstream, seen: string[] = []): FetchLike {
  const respond = (input: string, init: RequestInit | undefined): Response => {
    seen.push(input);
    const headers = new Headers(init?.headers);
    if (headers.get("User-Agent") !== "atl-mcp-watch") {
      return new Response("blocked", { status: 403 });
    }
    if (upstream.failUrls?.includes(input)) {
      throw new TypeError("network down");
    }
    if (input === `${GITHUB_RAW}/server.json`) {
      return json({
        name: "com.atlassian/atlassian-mcp-server",
        version: upstream.serverVersion,
        remotes: upstream.remotes.map((url) => ({ type: "streamable-http", url })),
      });
    }
    if (input === `${GITHUB_RAW}/plugin.json`) {
      return json({ name: "atlassian", version: "1.0.0" });
    }
    if (input.startsWith(`${REGISTRY_URL}?search=com.atlassian/atlassian-mcp-server`)) {
      return json({
        servers: [
          {
            server: {
              name: "com.atlassian/atlassian-mcp-server",
              version: "2.0.0",
              remotes: [{ type: "streamable-http", url: "https://mcp.atlassian.com/v2/mcp" }],
            },
            _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
          },
          {
            server: { name: "com.atlassian/atlassian-mcp-server", version: "1.1.3" },
            _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } },
          },
          { server: { name: "other/server", version: "9.9.9" }, _meta: {} },
        ],
        metadata: { count: 3 },
      });
    }
    const prefix = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/`;
    if (input.startsWith(prefix)) {
      const path = input.slice(prefix.length);
      const known = upstream.remotes.some((url) => url === `${MCP_ORIGIN}/${path}`);
      if (!known && !(path === "v3/mcp" && upstream.v3)) {
        return new Response("Not Found", { status: 404 });
      }
      return json({
        resource: `${MCP_ORIGIN}/${path}`,
        authorization_servers: ["https://auth.atlassian.com/tenant"],
        scopes_supported: upstream.scopes,
        bearer_methods_supported: ["header"],
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  return (input, init) => new Promise((resolve) => resolve(respond(input, init)));
}

describe("collect", () => {
  test("normalizes order-independently", async () => {
    const { snapshot: forward } = await collect(fakeFetch(BASE));
    const { snapshot: shuffled } = await collect(
      fakeFetch({
        ...BASE,
        remotes: BASE.remotes.toReversed(),
        scopes: BASE.scopes.toReversed(),
      }),
    );
    expect(fingerprint(shuffled)).toBe(fingerprint(forward));
    expect(forward.resources["v1/mcp/authv2"]).toEqual({
      status: 200,
      resource: "https://mcp.atlassian.com/v1/mcp/authv2",
      authorization_servers: ["https://auth.atlassian.com/tenant"],
      scopes_supported: ["offline_access", "read:jira-work", "read:me"],
    });
    expect(forward.resources["v3/mcp"]).toEqual({ status: 404 });
    expect(forward.registry).toEqual({
      latest: { version: "2.0.0", remotes: ["https://mcp.atlassian.com/v2/mcp"] },
      versions: ["1.1.3", "2.0.0"],
    });
  });

  test("sends the watcher User-Agent on every request", async () => {
    const seen: string[] = [];
    await collect(fakeFetch(BASE, seen));
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  test("keeps the baseline value of a failed source and reports it unavailable", async () => {
    const { snapshot: baseline } = await collect(fakeFetch(BASE));
    const failed = await collect(
      fakeFetch({ ...BASE, serverVersion: "2.1.0", failUrls: [`${GITHUB_RAW}/plugin.json`] }),
      baseline,
    );
    expect(failed.unavailable).toEqual([
      { source: "github.plugin", error: `GET ${GITHUB_RAW}/plugin.json failed: network down` },
    ]);
    expect(failed.snapshot.github.plugin).toEqual(baseline.github.plugin);
    expect(failed.snapshot.github.server.version).toBe("2.1.0");
  });
});

describe("diff", () => {
  const before = collect(fakeFetch(BASE)).then((collected) => collected.snapshot);

  test("detects a version bump", async () => {
    const { snapshot: after } = await collect(fakeFetch({ ...BASE, serverVersion: "2.1.0" }));
    expect(diff(await before, after)).toEqual([
      { path: "github.server.version", before: "2.0.0", after: "2.1.0" },
    ]);
  });

  test("detects a new remote and its resource metadata", async () => {
    const { snapshot: after } = await collect(
      fakeFetch({ ...BASE, remotes: [...BASE.remotes, "https://mcp.atlassian.com/v4/mcp"] }),
    );
    const paths = diff(await before, after).map((entry) => entry.path);
    expect(paths).toContain("github.server.remotes");
    expect(paths).toContain('resources["v4/mcp"]');
  });

  test("detects a scope change", async () => {
    const { snapshot: after } = await collect(
      fakeFetch({ ...BASE, scopes: [...BASE.scopes, "write:jira-work"] }),
    );
    const entries = diff(await before, after);
    expect(entries.map((entry) => entry.path)).toEqual([
      'resources["v1/mcp/authv2"].scopes_supported',
      'resources["v2/mcp"].scopes_supported',
    ]);
    expect(entries[0]?.after).toContain("write:jira-work");
  });

  test("detects a new v3 endpoint", async () => {
    const { snapshot: after } = await collect(fakeFetch({ ...BASE, v3: true }));
    const entries = diff(await before, after);
    expect(entries.every((entry) => entry.path.startsWith('resources["v3/mcp"].'))).toBe(true);
    expect(entries).toContainEqual({ path: 'resources["v3/mcp"].status', before: 404, after: 200 });
  });
});

describe("main", () => {
  let dir: string;
  let snapshotPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-watch-"));
    snapshotPath = join(dir, "upstream.json");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function run(
    argv: string[],
    upstream: Upstream,
  ): Promise<{ code: number; result: WatchResult | undefined; stderr: string }> {
    let out = "";
    let err = "";
    const code = await main(argv, {
      fetch: fakeFetch(upstream),
      snapshotPath,
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
    });
    return { code, result: out === "" ? undefined : JSON.parse(out), stderr: err };
  }

  test("reports changed:false with a stable fingerprint against its own snapshot", async () => {
    const first = await run(["--write"], BASE);
    expect(first.code).toBe(0);
    expect(first.result?.changed).toBe(true);
    const second = await run([], { ...BASE, scopes: BASE.scopes.toReversed() });
    expect(second.code).toBe(0);
    expect(second.result?.changed).toBe(false);
    expect(second.result?.diff).toEqual([]);
    expect(second.result?.fingerprint).toBe(first.result?.fingerprint);
  });

  test("does not touch the snapshot without --write", async () => {
    const { code, result } = await run([], BASE);
    expect(code).toBe(0);
    expect(result?.changed).toBe(true);
    await expect(stat(snapshotPath)).rejects.toThrow();
  });

  describe.each([
    ["github.server", `${GITHUB_RAW}/server.json`],
    ["github.plugin", `${GITHUB_RAW}/plugin.json`],
    ["registry", REGISTRY_SEARCH],
    ['resources["v2/mcp"]', `${MCP_ORIGIN}/.well-known/oauth-protected-resource/v2/mcp`],
  ])("when %s is unavailable", (source, url) => {
    test("exits 0, reports it, and shows no diff against the baseline", async () => {
      const first = await run(["--write"], BASE);
      const partial = await run([], { ...BASE, failUrls: [url] });
      expect(partial.code).toBe(0);
      expect(partial.result?.changed).toBe(false);
      expect(partial.result?.diff).toEqual([]);
      expect(partial.result?.unavailable).toHaveLength(1);
      expect(partial.result?.unavailable[0]?.source).toBe(source);
      expect(partial.result?.unavailable[0]?.error).toContain("network down");
      expect(partial.result?.fingerprint).toBe(first.result?.fingerprint);
    });
  });

  test("reports only the real change when another source is unavailable", async () => {
    await run(["--write"], BASE);
    const partial = await run([], {
      ...BASE,
      serverVersion: "2.1.0",
      failUrls: [`${GITHUB_RAW}/plugin.json`],
    });
    expect(partial.code).toBe(0);
    expect(partial.result?.changed).toBe(true);
    expect(partial.result?.diff).toEqual([
      { path: "github.server.version", before: "2.0.0", after: "2.1.0" },
    ]);
    expect(partial.result?.unavailable.map((entry) => entry.source)).toEqual(["github.plugin"]);
  });

  test("lists unavailable sources in the issue body", async () => {
    await run(["--write"], BASE);
    const bodyPath = join(dir, "issue.md");
    await run(["--issue-body", bodyPath], {
      ...BASE,
      serverVersion: "2.1.0",
      failUrls: [REGISTRY_SEARCH],
    });
    const body = await readFile(bodyPath, "utf8");
    expect(body).toContain("> [!NOTE]");
    expect(body).toContain("> - `registry: GET ");
    expect(body).toContain("network down`");
  });

  test("refuses --write while a source is unavailable and leaves the snapshot alone", async () => {
    await run(["--write"], BASE);
    const before = await readFile(snapshotPath, "utf8");
    const refused = await run(["--write"], {
      ...BASE,
      serverVersion: "2.1.0",
      failUrls: [`${GITHUB_RAW}/plugin.json`],
    });
    expect(refused.code).toBe(1);
    expect(refused.result).toBeUndefined();
    const error = JSON.parse(refused.stderr).error;
    expect(error.code).toBe("write_refused");
    expect(error.message).toContain("github.plugin");
    expect(await readFile(snapshotPath, "utf8")).toBe(before);
  });

  test("exits 2 on a failed source when there is no baseline to keep its value from", async () => {
    const failed = await run(["--write"], { ...BASE, failUrls: [REGISTRY_SEARCH] });
    expect(failed.code).toBe(2);
    expect(JSON.parse(failed.stderr).error.code).toBe("fetch_failed");
    await expect(stat(snapshotPath)).rejects.toThrow();
  });

  test("exits 1 with baseline_invalid when the baseline does not match the snapshot shape", async () => {
    const bad = JSON.stringify({ github: { server: { name: "x" } }, registry: {}, resources: {} });
    await writeFile(snapshotPath, bad);
    const invalid = await run(["--write"], BASE);
    expect(invalid.code).toBe(1);
    expect(invalid.result).toBeUndefined();
    const error = JSON.parse(invalid.stderr).error;
    expect(error.code).toBe("baseline_invalid");
    expect(error.message).toContain("at /github;");
    expect(await readFile(snapshotPath, "utf8")).toBe(bad);
  });

  test("exits 2 on an upstream HTTP error with no baseline and does not write", async () => {
    let err = "";
    const code = await main(["--write"], {
      fetch: () => Promise.resolve(new Response("boom", { status: 503 })),
      snapshotPath,
      stdout: () => {},
      stderr: (text) => (err += text),
    });
    expect(code).toBe(2);
    expect(err).toContain("HTTP 503");
    expect(JSON.parse(err).error.code).toBe("fetch_failed");
    await expect(stat(snapshotPath)).rejects.toThrow();
  });

  test("exits 2 when every source fails with a network error", async () => {
    await run(["--write"], BASE);
    const urls = [
      `${GITHUB_RAW}/server.json`,
      `${GITHUB_RAW}/plugin.json`,
      REGISTRY_SEARCH,
      ...["v1/mcp/authv2", "v2/mcp", "v3/mcp"].map(
        (path) => `${MCP_ORIGIN}/.well-known/oauth-protected-resource/${path}`,
      ),
    ];
    const failed = await run([], { ...BASE, failUrls: urls });
    expect(failed.code).toBe(2);
    expect(failed.result).toBeUndefined();
    expect(JSON.parse(failed.stderr).error.unavailable).toHaveLength(urls.length);
    expect(await readFile(snapshotPath, "utf8")).toContain('"2.0.0"');
  });

  test("exits 1 on bad arguments", async () => {
    expect((await run(["--bogus"], BASE)).code).toBe(1);
    expect((await run(["--issue-body"], BASE)).code).toBe(1);
  });

  test("writes an issue body with the fingerprint marker when changed", async () => {
    await run(["--write"], BASE);
    const bodyPath = join(dir, "issue.md");
    const { result } = await run(["--issue-body", bodyPath], {
      ...BASE,
      serverVersion: "3.0.0",
      v3: true,
    });
    expect(result?.changed).toBe(true);
    const body = await readFile(bodyPath, "utf8");
    expect(body).toContain(`<!-- mcp-watch:${result?.fingerprint} -->`);
    expect(body).toContain('| `github.server.version` | `"2.0.0"` | `"3.0.0"` |');
    expect(body).toContain("atl mcp tools --snapshot --output mcp/tools-v1.json");
    expect(body).toContain("bun test test/parity.test.ts");
    expect(body).toContain("bun scripts/mcp-watch.ts --write");
  });

  test("skips the issue body when nothing changed", async () => {
    await run(["--write"], BASE);
    const bodyPath = join(dir, "issue.md");
    await run(["--issue-body", bodyPath], BASE);
    await expect(stat(bodyPath)).rejects.toThrow();
  });
});

describe("renderIssueBody", () => {
  test("lists added and removed scopes", async () => {
    const { snapshot: before } = await collect(fakeFetch(BASE));
    const { snapshot: after } = await collect(
      fakeFetch({ ...BASE, scopes: ["read:me", "write:jira-work"] }),
    );
    const body = renderIssueBody({
      changed: true,
      fingerprint: fingerprint(after),
      diff: diff(before, after),
      unavailable: [],
      snapshot: after,
    });
    expect(body).toContain("`+write:jira-work`");
    expect(body).toContain("`-read:jira-work`");
  });
});
