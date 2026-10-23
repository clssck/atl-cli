import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confluenceDeps, confluenceGroups } from "../../src/commands/confluence.ts";
import {
  adfPlainText,
  commentAdd,
  commentUpdate,
  confluenceWriteCommands,
  locateSelection,
  pageCopy,
  pageCreate,
  pageMove,
  pagePermissionsAdd,
  pagePermissionsRemove,
  pagePermissionsSet,
  pagePropertyDelete,
  pagePropertySet,
  pageRestore,
  pageRestrict,
  pageUpdate,
} from "../../src/commands/confluence-write.ts";
import { bodyDeps } from "../../src/commands/write.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { makeContext } from "../helpers/context.ts";
import { withDiagnostics } from "../helpers/stderr.ts";

interface Call {
  method: string;
  path: string;
  url: URL;
  body: unknown;
}

interface Route {
  status: number;
  body: unknown;
}

let configDir: string;
let calls: Call[] = [];
let routes: Map<string, Route> = new Map();

function adf(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    version: 1,
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  });
}

/** A one-paragraph ADF document whose text carries an inline-comment anchor with this id. */
function anchored(id: string): string {
  return JSON.stringify({
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "anchored",
            marks: [{ type: "annotation", attrs: { id, annotationType: "inlineComment" } }],
          },
        ],
      },
    ],
  });
}

/** Routes are keyed `METHOD /path` (path after `/wiki`, no query string). */
function route(method: string, path: string, body: unknown, status = 200): void {
  routes.set(`${method} ${path}`, { status, body });
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "atl-confluence-write-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      sites: {
        "acme.atlassian.net": {
          cloudId: "cloud-1",
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["write:page:confluence"],
          cachedAt: "2026-10-01T00:00:00Z",
        },
      },
    }),
  );
  await writeFile(join(configDir, "body.md"), "Hello **world**\n");
  await writeFile(join(configDir, "body.xhtml"), "<p>Raw <b>storage</b></p>");
  confluenceDeps.fetch = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/ex/confluence/cloud-1/wiki", "");
    const raw = init?.body;
    calls.push({
      method,
      path,
      url,
      body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
    });
    // `GET /path?version=N` routes win over the plain path so one test can serve two versions.
    const versioned = url.searchParams.get("version");
    const hit =
      (versioned === null ? undefined : routes.get(`${method} ${path}?version=${versioned}`)) ??
      routes.get(`${method} ${path}`);
    const response = hit ?? { status: 404, body: { message: `no route ${method} ${path}` } };
    return Promise.resolve(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
});

afterEach(() => {
  calls = [];
  routes = new Map();
});

afterAll(async () => {
  confluenceDeps.fetch = undefined;
  await rm(configDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return makeContext({ ATL_CONFIG_DIR: configDir, ATL_ACCESS_TOKEN: "test-token" }, overrides);
}

function run(
  spec: CommandSpec,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  context: CommandContext = ctx(),
): Promise<unknown> {
  return spec.run(context, { args, rest: [], flags });
}

function bodyFile(name = "body.md"): string {
  return join(configDir, name);
}

function sent(method: string): Call[] {
  return calls.filter((call) => call.method === method);
}

function onlyWrite(method: string): Call {
  const [call, ...rest] = sent(method);
  if (call === undefined || rest.length > 0) {
    throw new Error(`expected exactly one ${method}`);
  }
  return call;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("not an object");
  }
  return value;
}

function errorOf(promise: Promise<unknown>): Promise<AtlError> {
  return promise.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (error: unknown) => {
      if (!(error instanceof AtlError)) {
        throw error;
      }
      return error;
    },
  );
}

const WEBUI = "/spaces/ENG/pages/123456/Runbook";

const CREATED_PAGE = {
  id: "123456",
  status: "current",
  title: "Runbook",
  spaceId: "98765",
  parentId: "100",
  version: { number: 1 },
  _links: { webui: WEBUI },
};

describe("write command registry", () => {
  test("exposes the write commands with side effects", () => {
    expect(confluenceWriteCommands.map((c) => c.name)).toEqual([
      "page.create",
      "page.update",
      "page.move",
      "page.copy",
      "page.restore",
      "page.permissions.add",
      "page.permissions.set",
      "page.permissions.remove",
      "page.restrict",
      "page.property.set",
      "page.property.delete",
      "comment.add",
      "comment.update",
    ]);
    expect(confluenceWriteCommands.every((c) => c.sideEffects === "write")).toBe(true);
  });

  test("group summaries describe reads and writes", () => {
    expect(confluenceGroups.page).toContain("create");
    expect(confluenceGroups.page).toContain("update");
    expect(confluenceGroups.comment).toContain("add");
    expect(confluenceGroups.comment).toContain("update");
  });
});

describe("page.create", () => {
  test("resolves the space key, converts markdown to ADF, and POSTs /pages", async () => {
    route("GET", "/api/v2/spaces", { results: [{ id: "98765", key: "ENG" }] });
    route("POST", "/api/v2/pages", CREATED_PAGE);
    const result = await run(pageCreate, {}, { space: "ENG", title: "Runbook", file: bodyFile() });
    expect(calls[0]?.url.searchParams.get("keys")).toBe("ENG");
    const post = onlyWrite("POST");
    expect(post.path).toBe("/api/v2/pages");
    expect(post.url.searchParams.has("private")).toBe(false);
    const body = asRecord(post.body);
    expect(body).toMatchObject({ spaceId: "98765", title: "Runbook" });
    expect(body).not.toHaveProperty("parentId");
    expect(body).not.toHaveProperty("status");
    const content = asRecord(body.body);
    expect(content.representation).toBe("atlas_doc_format");
    expect(JSON.parse(String(content.value))).toMatchObject({ type: "doc", version: 1 });
    expect(String(content.value)).toContain("world");
    expect(result).toEqual({
      id: "123456",
      title: "Runbook",
      spaceId: "98765",
      parentId: "100",
      version: 1,
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456",
      next: [["atl", "page", "get", "123456"]],
    });
  });

  test("numeric space ids skip the lookup; parent URL, draft status and live subtype are sent", async () => {
    route("POST", "/api/v2/pages", CREATED_PAGE);
    await run(
      pageCreate,
      {},
      {
        space: "98765",
        title: "Child",
        file: bodyFile(),
        parent: "https://acme.atlassian.net/wiki/spaces/ENG/pages/777/Parent",
        status: "draft",
        subtype: "live",
      },
    );
    expect(calls).toHaveLength(1);
    expect(asRecord(onlyWrite("POST").body)).toMatchObject({
      spaceId: "98765",
      parentId: "777",
      status: "draft",
      subtype: "live",
    });
  });

  test("--private adds the private query parameter", async () => {
    route("POST", "/api/v2/pages", CREATED_PAGE);
    await run(pageCreate, {}, { space: "98765", title: "Mine", file: bodyFile(), private: true });
    expect(onlyWrite("POST").url.searchParams.get("private")).toBe("true");
  });

  test("--type blogpost posts to /blogposts and reports a blogpost", async () => {
    route("POST", "/api/v2/blogposts", { ...CREATED_PAGE, id: "555" });
    const result = asRecord(
      await run(
        pageCreate,
        {},
        { space: "98765", title: "Release", file: bodyFile(), type: "blogpost" },
      ),
    );
    expect(onlyWrite("POST").path).toBe("/api/v2/blogposts");
    expect(result.type).toBe("blogpost");
    expect(result.next).toEqual([["atl", "page", "get", "555", "--type", "blogpost"]]);
  });

  test("--parent and --subtype are rejected for blog posts before any request", async () => {
    const error = await errorOf(
      run(
        pageCreate,
        {},
        { space: "98765", title: "x", file: bodyFile(), type: "blogpost", parent: "1" },
      ),
    );
    expect(error.code).toBe("unsupported_for_blogpost");
    expect(error.category).toBe("input");
    expect(calls).toHaveLength(0);
  });

  test("storage files are passed through verbatim", async () => {
    route("POST", "/api/v2/pages", CREATED_PAGE);
    await run(pageCreate, {}, { space: "98765", title: "Raw", file: bodyFile("body.xhtml") });
    expect(asRecord(onlyWrite("POST").body).body).toEqual({
      representation: "storage",
      value: "<p>Raw <b>storage</b></p>",
    });
  });

  test("--plan sends nothing and the plan's next is the argv without --plan", async () => {
    const argv = ["page", "create", "--space", "98765", "--title", "T", "--file", "x.md", "--plan"];
    const plan = asRecord(
      await run(
        pageCreate,
        {},
        { space: "98765", title: "T", file: bodyFile(), private: true },
        ctx({ plan: true, argv }),
      ),
    );
    expect(calls).toHaveLength(0);
    expect(plan.type).toBe("plan");
    expect(plan.method).toBe("POST");
    expect(String(plan.url)).toEndWith("/wiki/api/v2/pages?private=true");
    expect(asRecord(plan.body)).toHaveProperty("sha256");
    expect(plan.next).toEqual([
      ["atl", "page", "create", "--space", "98765", "--title", "T", "--file", "x.md"],
    ]);
  });

  test("a missing --file is a body_file_unreadable input error", async () => {
    const error = await errorOf(
      run(pageCreate, {}, { space: "98765", title: "T", file: join(configDir, "absent.md") }),
    );
    expect(error.code).toBe("body_file_unreadable");
    expect(calls).toHaveLength(0);
  });
});

describe("inline and stdin bodies", () => {
  afterEach(() => {
    bodyDeps.readStdin = undefined;
  });

  test("page.create --body converts inline markdown to ADF", async () => {
    route("POST", "/api/v2/pages", CREATED_PAGE);
    await run(pageCreate, {}, { space: "98765", title: "Note", body: "Hello **world**" });
    const content = asRecord(asRecord(onlyWrite("POST").body).body);
    expect(content.representation).toBe("atlas_doc_format");
    expect(String(content.value)).toContain("world");
  });

  test("page.create --file - reads stdin", async () => {
    route("POST", "/api/v2/pages", CREATED_PAGE);
    bodyDeps.readStdin = () => Promise.resolve("# Piped heading");
    await run(pageCreate, {}, { space: "98765", title: "Piped", file: "-" });
    const content = asRecord(asRecord(onlyWrite("POST").body).body);
    expect(JSON.parse(String(content.value))).toMatchObject({
      content: [{ type: "heading", content: [{ text: "Piped heading" }] }],
    });
  });

  test("--body-format storage with --body or --file - passes the text through", async () => {
    route("POST", "/api/v2/pages", CREATED_PAGE);
    await run(
      pageCreate,
      {},
      { space: "98765", title: "Raw", body: "<p>inline</p>", bodyFormat: "storage" },
    );
    bodyDeps.readStdin = () => Promise.resolve("<p>piped</p>");
    await run(pageCreate, {}, { space: "98765", title: "Raw", file: "-", bodyFormat: "storage" });
    expect(sent("POST").map((call) => asRecord(call.body).body)).toEqual([
      { representation: "storage", value: "<p>inline</p>" },
      { representation: "storage", value: "<p>piped</p>" },
    ]);
  });

  test("--body with --file is body_conflict and sends nothing", async () => {
    const error = await errorOf(
      run(pageCreate, {}, { space: "98765", title: "T", body: "x", file: bodyFile() }),
    );
    expect(error.code).toBe("body_conflict");
    expect(error.category).toBe("input");
    expect(calls).toHaveLength(0);
  });

  test("page.create and comment.add without a body are body_required", async () => {
    const create = await errorOf(run(pageCreate, {}, { space: "98765", title: "T" }));
    const add = await errorOf(run(commentAdd, { target: "123456" }));
    for (const error of [create, add]) {
      expect(error.code).toBe("body_required");
      expect(error.category).toBe("input");
      expect(error.hint).toContain("--body");
      expect(error.hint).toContain("--file");
    }
    expect(calls).toHaveLength(0);
  });

  test("--plan previews an inline body with sha256, bytes and preview", async () => {
    const argv = ["page", "create", "--space", "98765", "--title", "T", "--body", "Hi", "--plan"];
    const plan = asRecord(
      await run(
        pageCreate,
        {},
        { space: "98765", title: "T", body: "Hi" },
        ctx({ plan: true, argv }),
      ),
    );
    expect(calls).toHaveLength(0);
    expect(plan.type).toBe("plan");
    expect(asRecord(plan.body)).toMatchObject({
      sha256: expect.any(String),
      bytes: expect.any(Number),
      preview: expect.stringContaining("Hi"),
    });
    expect(plan.next).toEqual([
      ["atl", "page", "create", "--space", "98765", "--title", "T", "--body", "Hi"],
    ]);
  });

  test("page.update and comment.update accept --body; page.update counts it as a change", async () => {
    const nothing = await errorOf(run(pageUpdate, { page: "123456" }));
    expect(nothing.code).toBe("nothing_to_update");
    expect(nothing.hint).toContain("--body");
    const conflict = await errorOf(
      run(commentUpdate, { comment: "789" }, { body: "x", file: bodyFile() }),
    );
    expect(conflict.code).toBe("body_conflict");
    expect(calls).toHaveLength(0);
  });
});

describe("page.update", () => {
  const CURRENT = {
    id: "123456",
    status: "current",
    title: "Runbook",
    spaceId: "98765",
    version: { number: 4 },
    body: { atlas_doc_format: { representation: "atlas_doc_format", value: adf("Old body") } },
    _links: { webui: WEBUI },
  };
  const UPDATED = { ...CURRENT, version: { number: 5 }, title: "Runbook v2", body: {} };

  test("--file replaces the body and bumps the version", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("PUT", "/api/v2/pages/123456", UPDATED);
    const result = await run(
      pageUpdate,
      { page: "123456" },
      { file: bodyFile(), message: "Fix steps" },
    );
    expect(sent("GET")[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    const put = onlyWrite("PUT");
    const body = asRecord(put.body);
    expect(body).toMatchObject({
      id: "123456",
      status: "current",
      title: "Runbook",
      version: { number: 5, message: "Fix steps" },
    });
    expect(body).not.toHaveProperty("spaceId");
    expect(body).not.toHaveProperty("parentId");
    expect(String(asRecord(body.body).value)).toContain("world");
    expect(result).toMatchObject({
      id: "123456",
      version: 5,
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456",
      next: [["atl", "page", "get", "123456"]],
    });
    expect(asRecord(result).type).toBeUndefined();
  });

  test("a title-only update re-sends the current ADF body", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("PUT", "/api/v2/pages/123456", UPDATED);
    await run(pageUpdate, { page: "123456" }, { title: "Runbook v2" });
    expect(sent("GET")[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    const body = asRecord(onlyWrite("PUT").body);
    expect(body.title).toBe("Runbook v2");
    expect(body.body).toEqual({
      representation: "atlas_doc_format",
      value: adf("Old body"),
    });
    expect(asRecord(body.version)).toEqual({ number: 5 });
  });

  test("a bare blog post id is found on the blog post collection and updated there", async () => {
    const BLOG = { ...CURRENT, id: "777", _links: { webui: "/spaces/ENG/blog/2026/10/22/777" } };
    route("GET", "/api/v2/blogposts/777", BLOG);
    route("PUT", "/api/v2/blogposts/777", { ...BLOG, version: { number: 5 }, body: {} });
    const result = asRecord(await run(pageUpdate, { page: "777" }, { title: "Post v2" }));
    expect(sent("GET").map((call) => call.path)).toEqual([
      "/api/v2/pages/777",
      "/api/v2/blogposts/777",
    ]);
    expect(onlyWrite("PUT").path).toBe("/api/v2/blogposts/777");
    expect(result).toMatchObject({ id: "777", type: "blogpost", version: 5 });
  });

  test("a bare blog post id with --parent is refused before anything is written", async () => {
    route("GET", "/api/v2/blogposts/777", { ...CURRENT, id: "777" });
    const error = await errorOf(run(pageUpdate, { page: "777" }, { parent: "100" }));
    expect(error.code).toBe("unsupported_for_blogpost");
    expect(sent("PUT")).toHaveLength(0);
  });

  test("a bare id missing from both collections reports the page error", async () => {
    const error = await errorOf(run(pageUpdate, { page: "777" }, { title: "T" }));
    expect(error.status).toBe(404);
    expect(error.message).toContain("/pages/777");
    expect(sent("PUT")).toHaveLength(0);
  });

  describe("on a page with inline-comment anchors", () => {
    const ANCHORED_PAGE = { ...CURRENT, body: { atlas_doc_format: { value: anchored("ann-1") } } };

    test("a markdown body would drop the anchors: refused, nothing is written", async () => {
      route("GET", "/api/v2/pages/123456", ANCHORED_PAGE);
      const error = await errorOf(run(pageUpdate, { page: "123456" }, { file: bodyFile() }));
      expect(error.code).toBe("inline_comment_anchors_dropped");
      expect(error.category).toBe("input");
      expect(error.message).toContain("ann-1");
      expect(error.hint).toContain("--force");
      expect(sent("PUT")).toHaveLength(0);
    });

    test("--force saves, lists the dropped anchors, and warns on stderr", async () => {
      route("GET", "/api/v2/pages/123456", ANCHORED_PAGE);
      route("PUT", "/api/v2/pages/123456", UPDATED);
      const { result, diagnostics } = await withDiagnostics(() =>
        run(pageUpdate, { page: "123456" }, { file: bodyFile(), force: true }),
      );
      expect(sent("PUT")).toHaveLength(1);
      expect(asRecord(result).droppedInlineComments).toEqual(["ann-1"]);
      expect(diagnostics).toEqual([
        {
          type: "warning",
          code: "inline_comment_anchors_dropped",
          message: expect.stringContaining("ann-1"),
        },
      ]);
    });

    test("--plan shows the dropped anchors instead of refusing, with a --force hint on stderr", async () => {
      route("GET", "/api/v2/pages/123456", ANCHORED_PAGE);
      const { result, diagnostics } = await withDiagnostics(() =>
        run(
          pageUpdate,
          { page: "123456" },
          { file: bodyFile() },
          ctx({ plan: true, argv: ["page", "update", "123456", "--file", "x.md", "--plan"] }),
        ),
      );
      const plan = asRecord(result);
      expect(plan.type).toBe("plan");
      expect(plan.droppedInlineComments).toEqual(["ann-1"]);
      expect(sent("PUT")).toHaveLength(0);
      expect(diagnostics).toEqual([
        {
          type: "warning",
          code: "inline_comment_anchors_dropped",
          message: expect.stringContaining("ann-1"),
          hint: expect.stringContaining("--force"),
        },
      ]);
    });

    test("ADF and storage bodies that keep the anchors, and title-only updates, are not flagged", async () => {
      route("GET", "/api/v2/pages/123456", ANCHORED_PAGE);
      route("PUT", "/api/v2/pages/123456", UPDATED);
      const adfResult = asRecord(
        await run(pageUpdate, { page: "123456" }, { body: anchored("ann-1"), bodyFormat: "adf" }),
      );
      const storageResult = asRecord(
        await run(
          pageUpdate,
          { page: "123456" },
          {
            body: '<p><ac:inline-comment-marker ac:ref="ann-1">x</ac:inline-comment-marker></p>',
            bodyFormat: "storage",
          },
        ),
      );
      const titleResult = asRecord(await run(pageUpdate, { page: "123456" }, { title: "T" }));
      for (const result of [adfResult, storageResult, titleResult]) {
        expect(result.droppedInlineComments).toBeUndefined();
      }
      expect(sent("PUT")).toHaveLength(3);
    });

    test("an ADF body that lacks one of two anchors is refused naming that one", async () => {
      const two = JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "a",
                marks: [{ type: "annotation", attrs: { id: "ann-1" } }],
              },
              {
                type: "text",
                text: "b",
                marks: [{ type: "annotation", attrs: { id: "ann-2" } }],
              },
            ],
          },
        ],
      });
      route("GET", "/api/v2/pages/123456", {
        ...CURRENT,
        body: { atlas_doc_format: { value: two } },
      });
      const error = await errorOf(
        run(pageUpdate, { page: "123456" }, { body: anchored("ann-1"), bodyFormat: "adf" }),
      );
      expect(error.message).toContain("ann-2");
      expect(error.message).not.toContain("ann-1");
    });
  });

  test("--parent and --space resolve ids and are sent for a move", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("GET", "/api/v2/spaces", { results: [{ id: "98765", key: "ENG" }] });
    route("PUT", "/api/v2/pages/123456", UPDATED);
    await run(
      pageUpdate,
      { page: "123456" },
      { parent: "https://acme.atlassian.net/wiki/spaces/ENG/pages/777/New-parent", space: "ENG" },
    );
    expect(asRecord(onlyWrite("PUT").body)).toMatchObject({ parentId: "777", spaceId: "98765" });
  });

  test("--status draft resets the version to 1", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("PUT", "/api/v2/pages/123456", UPDATED);
    await run(pageUpdate, { page: "123456" }, { status: "draft", title: "WIP" });
    expect(asRecord(onlyWrite("PUT").body)).toMatchObject({
      status: "draft",
      version: { number: 1 },
    });
  });

  describe("on a page that was never published", () => {
    const DRAFT = { ...CURRENT, status: "draft", version: { number: 1 } };

    test("a rename keeps it a draft at version 1", async () => {
      route("GET", "/api/v2/pages/123456", DRAFT);
      route("PUT", "/api/v2/pages/123456", UPDATED);
      await run(pageUpdate, { page: "123456" }, { title: "WIP" });
      expect(asRecord(onlyWrite("PUT").body)).toMatchObject({
        status: "draft",
        title: "WIP",
        version: { number: 1 },
      });
    });

    test("--status current publishes it at version 1", async () => {
      route("GET", "/api/v2/pages/123456", DRAFT);
      route("PUT", "/api/v2/pages/123456", UPDATED);
      await run(pageUpdate, { page: "123456" }, { status: "current" });
      expect(asRecord(onlyWrite("PUT").body)).toMatchObject({
        status: "current",
        version: { number: 1 },
      });
    });

    test("--parent keeps it a draft at version 1", async () => {
      route("GET", "/api/v2/pages/123456", DRAFT);
      route("PUT", "/api/v2/pages/123456", UPDATED);
      await run(pageUpdate, { page: "123456" }, { parent: "777" });
      expect(asRecord(onlyWrite("PUT").body)).toMatchObject({
        status: "draft",
        parentId: "777",
        version: { number: 1 },
      });
    });
  });

  test("--type blogpost routes to /blogposts/{id}", async () => {
    route("GET", "/api/v2/blogposts/555", { ...CURRENT, id: "555" });
    route("PUT", "/api/v2/blogposts/555", { ...UPDATED, id: "555" });
    const result = asRecord(
      await run(pageUpdate, { page: "555" }, { type: "blogpost", title: "Release 2" }),
    );
    expect(onlyWrite("PUT").path).toBe("/api/v2/blogposts/555");
    expect(result.type).toBe("blogpost");
    expect(result.next).toEqual([["atl", "page", "get", "555", "--type", "blogpost"]]);
  });

  test("blog posts reject --parent", async () => {
    const error = await errorOf(
      run(pageUpdate, { page: "555" }, { type: "blogpost", parent: "1" }),
    );
    expect(error.code).toBe("unsupported_for_blogpost");
    expect(calls).toHaveLength(0);
  });

  test("storage files are passed through on update", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("PUT", "/api/v2/pages/123456", UPDATED);
    await run(pageUpdate, { page: "123456" }, { file: bodyFile("body.xhtml") });
    expect(asRecord(onlyWrite("PUT").body).body).toEqual({
      representation: "storage",
      value: "<p>Raw <b>storage</b></p>",
    });
  });

  test("a 409 is a transient version_conflict with a re-read next hint", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("PUT", "/api/v2/pages/123456", { message: "Version mismatch" }, 409);
    const error = await errorOf(run(pageUpdate, { page: "123456" }, { file: bodyFile() }));
    expect(error.category).toBe("transient");
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe("version_conflict");
    expect(error.hint).toContain("re-read");
    expect(error.next).toEqual([["atl", "page", "get", "123456"]]);
    expect(sent("PUT")).toHaveLength(1);
  });

  test("--plan still reads the current version but sends no PUT", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    const argv = ["page", "update", "123456", "--file", "x.md", "--plan"];
    const plan = asRecord(
      await run(pageUpdate, { page: "123456" }, { file: bodyFile() }, ctx({ plan: true, argv })),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(sent("GET")).toHaveLength(1);
    expect(plan).toMatchObject({ type: "plan", method: "PUT" });
    expect(String(plan.url)).toEndWith("/wiki/api/v2/pages/123456");
    expect(plan.next).toEqual([["atl", "page", "update", "123456", "--file", "x.md"]]);
  });

  test("nothing to change is an input error before any request", async () => {
    const error = await errorOf(run(pageUpdate, { page: "123456" }, { message: "noop" }));
    expect(error.code).toBe("nothing_to_update");
    expect(calls).toHaveLength(0);
  });
});

describe("comment.add", () => {
  const FOOTER = {
    id: "9001",
    status: "current",
    pageId: "123456",
    version: { number: 1, authorId: "acc-1", createdAt: "2026-03-01T10:00:00.000Z" },
    _links: { webui: `${WEBUI}?focusedCommentId=9001` },
  };
  const INLINE = {
    ...FOOTER,
    id: "9100",
    resolutionStatus: "open",
    properties: { inlineOriginalSelection: "Hello" },
  };

  test("a footer comment on a page POSTs pageId and the ADF body", async () => {
    route("POST", "/api/v2/footer-comments", FOOTER);
    const result = await run(commentAdd, { target: "123456" }, { file: bodyFile() });
    const body = asRecord(onlyWrite("POST").body);
    expect(Object.keys(body).toSorted()).toEqual(["body", "pageId"]);
    expect(body.pageId).toBe("123456");
    expect(asRecord(body.body).representation).toBe("atlas_doc_format");
    expect(result).toEqual({
      id: "9001",
      type: "footer-comment",
      pageId: "123456",
      version: 1,
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456?focusedCommentId=9001",
      next: [["atl", "comment", "get", "9001"]],
    });
    expect(asRecord(result).body).toBeUndefined();
  });

  test("blog post references use blogPostId", async () => {
    route("POST", "/api/v2/footer-comments", FOOTER);
    await run(commentAdd, { target: "ari:cloud:confluence::blogpost/555" }, { file: bodyFile() });
    const body = asRecord(onlyWrite("POST").body);
    expect(body.blogPostId).toBe("555");
    expect(body).not.toHaveProperty("pageId");
  });

  test("--target-type blogpost applies to bare ids", async () => {
    route("POST", "/api/v2/footer-comments", FOOTER);
    await run(commentAdd, { target: "555" }, { file: bodyFile(), targetType: "blogpost" });
    expect(asRecord(onlyWrite("POST").body).blogPostId).toBe("555");
  });

  test("attachment and custom-content targets use their own id fields", async () => {
    route("POST", "/api/v2/footer-comments", FOOTER);
    await run(commentAdd, { target: "att42" }, { file: bodyFile(), targetType: "attachment" });
    await run(commentAdd, { target: "cc7" }, { file: bodyFile(), targetType: "custom-content" });
    const [first, second] = sent("POST");
    expect(asRecord(first?.body).attachmentId).toBe("att42");
    expect(asRecord(second?.body).customContentId).toBe("cc7");
  });

  test("a footer reply looks up the parent, sends parentCommentId only, and echoes it", async () => {
    route("GET", "/api/v2/footer-comments/9001", FOOTER);
    route("POST", "/api/v2/footer-comments", { ...FOOTER, id: "9002", parentCommentId: "9001" });
    const result = await run(commentAdd, {}, { file: bodyFile(), replyTo: "9001" });
    expect(sent("GET").map((call) => call.path)).toEqual(["/api/v2/footer-comments/9001"]);
    const body = asRecord(onlyWrite("POST").body);
    expect(Object.keys(body).toSorted()).toEqual(["body", "parentCommentId"]);
    expect(body.parentCommentId).toBe("9001");
    expect(result).toMatchObject({ id: "9002", type: "footer-comment", parentCommentId: "9001" });
  });

  test("a reply to a reply reports the comment replied to, not the thread's top-level comment", async () => {
    route("GET", "/api/v2/footer-comments/9003", {
      ...FOOTER,
      id: "9003",
      parentCommentId: "9001",
    });
    route("POST", "/api/v2/footer-comments", { ...FOOTER, id: "9004", parentCommentId: "9001" });
    const result = await run(commentAdd, {}, { file: bodyFile(), replyTo: "9003" });
    expect(result).toMatchObject({ id: "9004", parentCommentId: "9003" });
  });

  test("a reply to an inline comment is inferred inline when --kind is omitted", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE);
    route("POST", "/api/v2/inline-comments", { ...INLINE, id: "9101", parentCommentId: "9100" });
    const result = await run(commentAdd, {}, { file: bodyFile(), replyTo: "9100" });
    expect(sent("GET").map((call) => call.path)).toEqual([
      "/api/v2/footer-comments/9100",
      "/api/v2/inline-comments/9100",
    ]);
    const post = onlyWrite("POST");
    expect(post.path).toBe("/api/v2/inline-comments");
    expect(Object.keys(asRecord(post.body)).toSorted()).toEqual(["body", "parentCommentId"]);
    expect(result).toMatchObject({
      id: "9101",
      type: "inline-comment",
      parentCommentId: "9100",
      next: [["atl", "comment", "get", "9101", "--kind", "inline"]],
    });
  });

  test("an explicit --kind inline reply to an inline comment posts to /inline-comments", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE);
    route("POST", "/api/v2/inline-comments", { ...INLINE, id: "9101", parentCommentId: "9100" });
    await run(commentAdd, {}, { file: bodyFile(), replyTo: "9100", kind: "inline" });
    expect(onlyWrite("POST").path).toBe("/api/v2/inline-comments");
  });

  test("a --kind that contradicts the parent is an input error and nothing is posted", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE);
    route("GET", "/api/v2/footer-comments/9001", FOOTER);
    const footerOnInline = await errorOf(
      run(commentAdd, {}, { file: bodyFile(), replyTo: "9100", kind: "footer" }),
    );
    const inlineOnFooter = await errorOf(
      run(commentAdd, {}, { file: bodyFile(), replyTo: "9001", kind: "inline" }),
    );
    for (const error of [footerOnInline, inlineOnFooter]) {
      expect(error.code).toBe("comment_kind_mismatch");
      expect(error.category).toBe("input");
    }
    expect(footerOnInline.hint).toContain("--kind inline");
    expect(inlineOnFooter.hint).toContain("--kind footer");
    expect(sent("POST")).toHaveLength(0);
  });

  test("a parent that is neither a footer nor an inline comment is an api comment_not_found", async () => {
    const error = await errorOf(run(commentAdd, {}, { file: bodyFile(), replyTo: "404" }));
    expect(error.code).toBe("comment_not_found");
    expect(error.category).toBe("api");
    expect(sent("POST")).toHaveLength(0);
  });

  test("a reply rejects a target, --select, --match and --target-type", async () => {
    for (const [args, flags] of [
      [{ target: "123456" }, { replyTo: "9001" }],
      [{}, { replyTo: "9001", select: "x" }],
      [{}, { replyTo: "9001", match: 2 }],
      [{}, { replyTo: "9001", targetType: "page" }],
    ] as const) {
      const error = await errorOf(run(commentAdd, args, { file: bodyFile(), ...flags }));
      expect(error.code).toBe("invalid_flag_combination");
    }
    expect(calls).toHaveLength(0);
  });

  test("inline comments compute matchCount and a 0-based matchIndex from the page text", async () => {
    route("GET", "/api/v2/pages/123456", {
      id: "123456",
      body: {
        atlas_doc_format: {
          value: adf("Hello world and Hello again", "Third Hello here", "No match"),
        },
      },
    });
    route("POST", "/api/v2/inline-comments", INLINE);
    const result = await run(
      commentAdd,
      { target: "123456" },
      { file: bodyFile(), kind: "inline", select: "Hello", match: 3 },
    );
    expect(sent("GET")[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    const post = onlyWrite("POST");
    expect(post.path).toBe("/api/v2/inline-comments");
    expect(asRecord(post.body)).toMatchObject({
      pageId: "123456",
      inlineCommentProperties: {
        textSelection: "Hello",
        textSelectionMatchCount: 3,
        textSelectionMatchIndex: 2,
      },
    });
    expect(result).toMatchObject({
      id: "9100",
      type: "inline-comment",
      resolutionStatus: "open",
    });
  });

  test("--match defaults to the first occurrence", async () => {
    route("GET", "/api/v2/pages/123456", {
      id: "123456",
      body: { atlas_doc_format: { value: adf("alpha beta alpha") } },
    });
    route("POST", "/api/v2/inline-comments", INLINE);
    await run(
      commentAdd,
      { target: "123456" },
      { file: bodyFile(), kind: "inline", select: "alpha" },
    );
    expect(asRecord(asRecord(onlyWrite("POST").body).inlineCommentProperties)).toMatchObject({
      textSelectionMatchCount: 2,
      textSelectionMatchIndex: 0,
    });
  });

  test("inline comments on a blog post send blogPostId", async () => {
    route("GET", "/api/v2/blogposts/555", {
      id: "555",
      body: { atlas_doc_format: { value: adf("only once") } },
    });
    route("POST", "/api/v2/inline-comments", INLINE);
    await run(
      commentAdd,
      { target: "555" },
      { file: bodyFile(), kind: "inline", select: "once", targetType: "blogpost" },
    );
    expect(asRecord(onlyWrite("POST").body)).toMatchObject({ blogPostId: "555" });
  });

  test("a selection missing from the page is an input error and nothing is posted", async () => {
    route("GET", "/api/v2/pages/123456", {
      id: "123456",
      body: { atlas_doc_format: { value: adf("Some text") } },
    });
    const error = await errorOf(
      run(commentAdd, { target: "123456" }, { file: bodyFile(), kind: "inline", select: "absent" }),
    );
    expect(error.code).toBe("selection_not_found");
    expect(error.category).toBe("input");
    expect(sent("POST")).toHaveLength(0);
  });

  test("--match beyond the occurrence count is an input error", async () => {
    route("GET", "/api/v2/pages/123456", {
      id: "123456",
      body: { atlas_doc_format: { value: adf("one two one") } },
    });
    const error = await errorOf(
      run(
        commentAdd,
        { target: "123456" },
        { file: bodyFile(), kind: "inline", select: "one", match: 3 },
      ),
    );
    expect(error.code).toBe("match_out_of_range");
    expect(sent("POST")).toHaveLength(0);
  });

  test("flag validation fails before any request", async () => {
    const cases: [Record<string, string>, Record<string, unknown>, string][] = [
      [{}, {}, "missing_target"],
      [{ target: "123456" }, { kind: "inline" }, "missing_flag"],
      [{ target: "123456" }, { select: "x" }, "invalid_flag_combination"],
      [
        { target: "att1" },
        { kind: "inline", select: "x", targetType: "attachment" },
        "invalid_flag_combination",
      ],
    ];
    for (const [args, flags, code] of cases) {
      const error = await errorOf(run(commentAdd, args, { file: bodyFile(), ...flags }));
      expect(error.code).toBe(code);
    }
    expect(calls).toHaveLength(0);
  });

  test("--plan builds the request without POSTing but still reads the page for inline anchors", async () => {
    route("GET", "/api/v2/pages/123456", {
      id: "123456",
      body: { atlas_doc_format: { value: adf("anchor here") } },
    });
    const argv = [
      "comment",
      "add",
      "123456",
      "--kind",
      "inline",
      "--select",
      "anchor",
      "--file",
      "n.md",
      "--dry-run",
    ];
    const plan = asRecord(
      await run(
        commentAdd,
        { target: "123456" },
        { file: bodyFile(), kind: "inline", select: "anchor" },
        ctx({ plan: true, argv }),
      ),
    );
    expect(sent("POST")).toHaveLength(0);
    expect(plan).toMatchObject({ type: "plan", method: "POST" });
    expect(String(plan.url)).toEndWith("/wiki/api/v2/inline-comments");
    expect(plan.next).toEqual([
      [
        "atl",
        "comment",
        "add",
        "123456",
        "--kind",
        "inline",
        "--select",
        "anchor",
        "--file",
        "n.md",
      ],
    ]);
  });
});

describe("comment.update", () => {
  const FOOTER_NOW = {
    id: "9001",
    status: "current",
    pageId: "123456",
    version: { number: 3 },
    body: { atlas_doc_format: { value: adf("Old comment") } },
  };
  const INLINE_NOW = {
    ...FOOTER_NOW,
    id: "9100",
    resolutionStatus: "open",
    version: { number: 2 },
  };

  test("a footer edit GETs the version then PUTs version+1 with the new body", async () => {
    route("GET", "/api/v2/footer-comments/9001", FOOTER_NOW);
    route("PUT", "/api/v2/footer-comments/9001", {
      ...FOOTER_NOW,
      version: { number: 4 },
      _links: { webui: `${WEBUI}?focusedCommentId=9001` },
    });
    const result = await run(commentUpdate, { comment: "9001" }, { file: bodyFile() });
    expect(sent("GET")[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    const body = asRecord(onlyWrite("PUT").body);
    expect(body.version).toEqual({ number: 4 });
    expect(body).not.toHaveProperty("resolved");
    expect(String(asRecord(body.body).value)).toContain("world");
    expect(result).toMatchObject({
      id: "9001",
      type: "footer-comment",
      pageId: "123456",
      version: 4,
      next: [["atl", "comment", "get", "9001"]],
    });
  });

  test("the comment id is read from a focusedCommentId URL on the URL's site", async () => {
    route("GET", "/api/v2/footer-comments/9001", FOOTER_NOW);
    route("PUT", "/api/v2/footer-comments/9001", FOOTER_NOW);
    await run(
      commentUpdate,
      {
        comment:
          "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Runbook?focusedCommentId=9001",
      },
      { file: bodyFile() },
    );
    expect(onlyWrite("PUT").path).toBe("/api/v2/footer-comments/9001");
  });

  test("--kind inline --resolve re-sends the current body and sets resolved", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE_NOW);
    route("PUT", "/api/v2/inline-comments/9100", { ...INLINE_NOW, version: { number: 3 } });
    const result = await run(commentUpdate, { comment: "9100" }, { kind: "inline", resolve: true });
    const body = asRecord(onlyWrite("PUT").body);
    expect(body).toMatchObject({ version: { number: 3 }, resolved: true });
    expect(body.body).toEqual({ representation: "atlas_doc_format", value: adf("Old comment") });
    expect(result).toMatchObject({
      type: "inline-comment",
      next: [["atl", "comment", "get", "9100", "--kind", "inline"]],
    });
  });

  test("--reopen sets resolved to false", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE_NOW);
    route("PUT", "/api/v2/inline-comments/9100", INLINE_NOW);
    await run(
      commentUpdate,
      { comment: "9100" },
      { kind: "inline", reopen: true, file: bodyFile() },
    );
    expect(asRecord(onlyWrite("PUT").body)).toMatchObject({ resolved: false });
  });

  test("flag validation fails before any request", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "inline", resolve: true, reopen: true }, "invalid_flag_combination"],
      [{ resolve: true }, "invalid_flag_combination"],
      [{ kind: "inline" }, "nothing_to_update"],
    ];
    for (const [flags, code] of cases) {
      const error = await errorOf(run(commentUpdate, { comment: "9100" }, flags));
      expect(error.code).toBe(code);
    }
    expect(calls).toHaveLength(0);
  });

  test("a 409 maps to transient exit 3 with a re-read hint for the right kind", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE_NOW);
    route("PUT", "/api/v2/inline-comments/9100", { message: "stale" }, 409);
    const error = await errorOf(
      run(commentUpdate, { comment: "9100" }, { kind: "inline", file: bodyFile() }),
    );
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe("version_conflict");
    expect(error.next).toEqual([["atl", "comment", "get", "9100", "--kind", "inline"]]);
  });

  test("--plan reads the version, sends no PUT, and next drops --plan", async () => {
    route("GET", "/api/v2/footer-comments/9001", FOOTER_NOW);
    const argv = ["comment", "update", "9001", "--file", "x.md", "--plan"];
    const plan = asRecord(
      await run(
        commentUpdate,
        { comment: "9001" },
        { file: bodyFile() },
        ctx({ plan: true, argv }),
      ),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(plan).toMatchObject({ type: "plan", method: "PUT" });
    expect(String(plan.url)).toEndWith("/wiki/api/v2/footer-comments/9001");
    expect(asRecord(plan.body)).toHaveProperty("preview");
    expect(plan.next).toEqual([["atl", "comment", "update", "9001", "--file", "x.md"]]);
  });
});

describe("selection helpers", () => {
  test("adfPlainText joins inline nodes and separates blocks", () => {
    const doc = {
      type: "doc" as const,
      version: 1 as const,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ping " },
            { type: "mention", attrs: { text: "@Ada" } },
            { type: "hardBreak" },
            { type: "text", text: "now", marks: [{ type: "strong" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
            },
          ],
        },
      ],
    };
    expect(adfPlainText(doc)).toBe("Ping @Ada\nnow\na\n\n\n");
  });

  test("locateSelection counts non-overlapping matches and validates --match", () => {
    expect(locateSelection("aaaa", "aa", 2)).toEqual({ count: 2, index: 1 });
    expect(locateSelection("x y x", "x", 1)).toEqual({ count: 2, index: 0 });
    expect(() => locateSelection("x", "y", 1)).toThrow(AtlError);
    expect(() => locateSelection("x", "x", 2)).toThrow(AtlError);
  });

  test("an empty selection is an input error (it would match everywhere)", () => {
    expect(() => locateSelection("text", "", 1)).toThrow("--select is empty");
  });
});

const PAGE_WITH_BODY = {
  id: "123456",
  status: "current",
  title: "Runbook",
  spaceId: "98765",
  parentId: "100",
  version: { number: 3 },
  body: { atlas_doc_format: { value: adf("Original body") } },
  _links: { webui: WEBUI },
};

const SUBJECT = { page: "123456" };

/** Routes the reads that report where a page ended up: its parent, and the parent's children. */
function routePlacement(pageId: string, parentId: string): void {
  route("GET", `/api/v2/pages/${pageId}`, {
    id: pageId,
    title: "Moved",
    parentId,
    parentType: "page",
  });
  route("GET", `/api/v2/pages/${parentId}`, { id: parentId, title: "Target" });
  route("GET", `/api/v2/pages/${parentId}/direct-children`, {
    results: [{ id: "5" }, { id: pageId }],
  });
}

describe("page.move", () => {
  test("defaults to append, PUTs the v1 move endpoint and reports the new parent and index", async () => {
    route("PUT", "/rest/api/content/123456/move/append/777", { id: "123456" });
    routePlacement("123456", "777");
    const result = await run(pageMove, SUBJECT, { to: "777" });
    expect(onlyWrite("PUT").path).toBe("/rest/api/content/123456/move/append/777");
    expect(onlyWrite("PUT").body).toBeUndefined();
    expect(result).toEqual({
      id: "123456",
      position: "append",
      target: "777",
      parent: { id: "777", title: "Target" },
      index: 1,
      next: [["atl", "page", "get", "123456"]],
    });
  });

  test("a sibling move reports the parent it landed under, not the target", async () => {
    route("PUT", "/rest/api/content/123456/move/after/777", { id: "123456" });
    routePlacement("123456", "50");
    const result = asRecord(await run(pageMove, SUBJECT, { to: "777", position: "after" }));
    expect(result).toMatchObject({ target: "777", parent: { id: "50", title: "Target" } });
  });

  test("a folder parent has no title or index to read; a space-root page has no parent", async () => {
    route("PUT", "/rest/api/content/123456/move/append/777", { id: "123456" });
    route("GET", "/api/v2/pages/123456", { id: "123456", parentId: "f1", parentType: "folder" });
    const folder = asRecord(await run(pageMove, SUBJECT, { to: "777" }));
    expect(folder.parent).toEqual({ id: "f1", type: "folder" });
    expect(folder).not.toHaveProperty("index");
    route("GET", "/api/v2/pages/123456", { id: "123456" });
    const root = asRecord(await run(pageMove, SUBJECT, { to: "777" }));
    expect(root).not.toHaveProperty("parent");
  });

  test("before/after place the page as a sibling; URLs resolve to ids", async () => {
    route("PUT", "/rest/api/content/123456/move/before/777", { id: "123456" });
    routePlacement("123456", "50");
    const result = asRecord(
      await run(
        pageMove,
        { page: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Runbook" },
        { to: "https://acme.atlassian.net/wiki/spaces/ENG/pages/777/Other", position: "before" },
      ),
    );
    expect(onlyWrite("PUT").path).toBe("/rest/api/content/123456/move/before/777");
    expect(result.position).toBe("before");
  });

  test("--full returns the raw API object", async () => {
    route("PUT", "/rest/api/content/123456/move/append/777", { id: "123456", type: "page" });
    const result = await run(pageMove, SUBJECT, { to: "777" }, ctx({ full: true }));
    expect(result).toEqual({ id: "123456", type: "page" });
  });

  test("--plan sends nothing", async () => {
    const argv = ["page", "move", "123456", "--to", "777", "--plan"];
    const plan = asRecord(await run(pageMove, SUBJECT, { to: "777" }, ctx({ plan: true, argv })));
    expect(calls).toHaveLength(0);
    expect(plan.method).toBe("PUT");
    expect(String(plan.url)).toEndWith("/wiki/rest/api/content/123456/move/append/777");
    expect(plan.next).toEqual([["atl", "page", "move", "123456", "--to", "777"]]);
  });

  test("blog posts are rejected as source or target before any request", async () => {
    const source = await errorOf(
      run(
        pageMove,
        { page: "https://acme.atlassian.net/wiki/spaces/ENG/blog/2026/10/01/555/Post" },
        { to: "777" },
      ),
    );
    const target = await errorOf(
      run(pageMove, SUBJECT, {
        to: "https://acme.atlassian.net/wiki/spaces/ENG/blog/2026/10/01/555/Post",
      }),
    );
    expect(source.code).toBe("unsupported_for_blogpost");
    expect(target.code).toBe("unsupported_for_blogpost");
    expect(calls).toHaveLength(0);
  });
});

describe("page.copy", () => {
  test("copies the ADF body beside the original with a default title", async () => {
    route("GET", "/api/v2/pages/123456", PAGE_WITH_BODY);
    routePlacement("999", "100");
    route("POST", "/api/v2/pages", { ...CREATED_PAGE, id: "999", title: "Copy of Runbook" });
    const result = await run(pageCopy, SUBJECT, {});
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(asRecord(onlyWrite("POST").body)).toEqual({
      spaceId: "98765",
      status: "current",
      title: "Copy of Runbook",
      parentId: "100",
      body: { representation: "atlas_doc_format", value: adf("Original body") },
    });
    expect(result).toEqual({
      parent: { id: "100", title: "Target" },
      index: 1,
      id: "999",
      title: "Copy of Runbook",
      spaceId: "98765",
      parentId: "100",
      version: 1,
      url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123456",
      next: [["atl", "page", "get", "999"]],
      copiedFrom: "123456",
    });
  });

  test("--to-parent takes the parent's space; --title overrides the default", async () => {
    route("GET", "/api/v2/pages/123456", PAGE_WITH_BODY);
    route("GET", "/api/v2/pages/777", { id: "777", spaceId: "55" });
    route("POST", "/api/v2/pages", { ...CREATED_PAGE, id: "999" });
    routePlacement("999", "777");
    route("GET", "/api/v2/pages/777", { id: "777", spaceId: "55", title: "Target" });
    await run(pageCopy, SUBJECT, { toParent: "777", title: "Fresh" });
    expect(asRecord(onlyWrite("POST").body)).toMatchObject({
      spaceId: "55",
      parentId: "777",
      title: "Fresh",
    });
  });

  test("--to-space resolves the key and does not inherit the original's parent", async () => {
    route("GET", "/api/v2/pages/123456", PAGE_WITH_BODY);
    route("GET", "/api/v2/spaces", { results: [{ id: "42", key: "OPS" }] });
    route("POST", "/api/v2/pages", { ...CREATED_PAGE, id: "999" });
    routePlacement("999", "100");
    await run(pageCopy, SUBJECT, { toSpace: "OPS", title: "Elsewhere" });
    const body = asRecord(onlyWrite("POST").body);
    expect(body.spaceId).toBe("42");
    expect(body).not.toHaveProperty("parentId");
  });

  test("blog posts copy to /blogposts without a parent", async () => {
    route("GET", "/api/v2/blogposts/555", { ...PAGE_WITH_BODY, id: "555", title: "Post" });
    route("POST", "/api/v2/blogposts", { ...CREATED_PAGE, id: "556" });
    const result = asRecord(await run(pageCopy, { page: "555" }, { type: "blogpost" }));
    const body = asRecord(onlyWrite("POST").body);
    expect(body).not.toHaveProperty("parentId");
    expect(body.title).toBe("Copy of Post");
    expect(result.type).toBe("blogpost");
    expect(sent("GET")).toHaveLength(1);
  });

  test("--to-parent is rejected for blog posts before any request", async () => {
    const error = await errorOf(
      run(pageCopy, { page: "555" }, { type: "blogpost", toParent: "1" }),
    );
    expect(error.code).toBe("unsupported_for_blogpost");
    expect(calls).toHaveLength(0);
  });

  test("an original without a readable body is an unexpected_response error", async () => {
    route("GET", "/api/v2/pages/123456", { id: "123456", title: "Empty", spaceId: "98765" });
    const error = await errorOf(run(pageCopy, SUBJECT, {}));
    expect(error.code).toBe("unexpected_response");
    expect(sent("POST")).toHaveLength(0);
  });

  test("--plan reads the original but sends no write; --full returns the raw page", async () => {
    route("GET", "/api/v2/pages/123456", PAGE_WITH_BODY);
    route("POST", "/api/v2/pages", { ...CREATED_PAGE, id: "999" });
    const plan = asRecord(
      await run(
        pageCopy,
        SUBJECT,
        {},
        ctx({ plan: true, argv: ["page", "copy", "123456", "--plan"] }),
      ),
    );
    expect(sent("POST")).toHaveLength(0);
    expect(plan.type).toBe("plan");
    expect(plan.next).toEqual([["atl", "page", "copy", "123456"]]);
    const raw = asRecord(await run(pageCopy, SUBJECT, {}, ctx({ full: true })));
    expect(raw.version).toEqual({ number: 1 });
    expect(raw).not.toHaveProperty("copiedFrom");
  });
});

describe("page.restore", () => {
  const CURRENT = { ...CREATED_PAGE, title: "Runbook v3", version: { number: 3 } };
  const OLD = {
    ...CREATED_PAGE,
    title: "Runbook v1",
    version: { number: 1 },
    body: { atlas_doc_format: { value: adf("Old body") } },
  };

  function routeVersions(): void {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("GET", "/api/v2/pages/123456?version=1", OLD);
    route("PUT", "/api/v2/pages/123456", { ...CREATED_PAGE, version: { number: 4 } });
  }

  test("re-saves the old body as the next version and keeps the current title", async () => {
    routeVersions();
    const result = await run(pageRestore, SUBJECT, { version: 1 });
    const oldRead = calls.find((call) => call.url.searchParams.get("version") === "1");
    expect(oldRead?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(asRecord(onlyWrite("PUT").body)).toEqual({
      id: "123456",
      status: "current",
      title: "Runbook v3",
      body: { representation: "atlas_doc_format", value: adf("Old body") },
      version: { number: 4, message: "Restored version 1" },
    });
    expect(result).toMatchObject({ id: "123456", version: 4, restoredFrom: 1 });
  });

  test("--restore-title and --message are honoured", async () => {
    routeVersions();
    await run(pageRestore, SUBJECT, { version: 1, restoreTitle: true, message: "Undo" });
    expect(asRecord(onlyWrite("PUT").body)).toMatchObject({
      title: "Runbook v1",
      version: { number: 4, message: "Undo" },
    });
  });

  test("an unknown version surfaces the API 404 and writes nothing", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("GET", "/api/v2/pages/123456?version=99", { message: "Cannot find version [99]" }, 404);
    const error = await errorOf(run(pageRestore, SUBJECT, { version: 99 }));
    expect(error.status).toBe(404);
    expect(sent("PUT")).toHaveLength(0);
  });

  test("a 409 on save is a transient version_conflict with a re-read next", async () => {
    routeVersions();
    route("PUT", "/api/v2/pages/123456", { message: "conflict" }, 409);
    const error = await errorOf(run(pageRestore, SUBJECT, { version: 1 }));
    expect(error.code).toBe("version_conflict");
    expect(error.category).toBe("transient");
    expect(error.next).toEqual([["atl", "page", "get", "123456"]]);
  });

  test("--plan reads both versions but sends no write", async () => {
    routeVersions();
    const argv = ["page", "restore", "123456", "--version", "1", "--plan"];
    const plan = asRecord(
      await run(pageRestore, SUBJECT, { version: 1 }, ctx({ plan: true, argv })),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(plan.method).toBe("PUT");
    expect(plan.next).toEqual([["atl", "page", "restore", "123456", "--version", "1"]]);
  });
});

/** A bare id may be a page or a blog post: the write is preceded by one GET that finds out which. */
function routeProbe(): void {
  route("GET", "/api/v2/pages/123456", { id: "123456" });
}

describe("page.permissions.add", () => {
  beforeEach(routeProbe);

  const RESULTS = {
    results: [
      { operation: "read", principal: { principalType: "user", principalId: "u1" } },
      { operation: "read", principal: { principalType: "group", principalId: "g1" } },
      { operation: "update", principal: { principalType: "user", principalId: "u2" } },
    ],
    _links: { base: "https://acme.atlassian.net/wiki" },
  };

  test("groups principals by operation and returns names for users", async () => {
    route("POST", "/api/v2/pages/123456/permissions", RESULTS);
    route("GET", "/rest/api/user/bulk", {
      results: [{ accountId: "u1", displayName: "Ada" }],
    });
    const result = await run(pagePermissionsAdd, SUBJECT, {
      viewUser: ["u1"],
      viewGroup: ["g1"],
      editUser: ["u2"],
    });
    const post = onlyWrite("POST");
    expect(post.url.search).toBe("");
    expect(post.body).toEqual({
      permissions: [
        {
          operation: "read",
          principals: [
            { principalType: "user", principalId: "u1" },
            { principalType: "group", principalId: "g1" },
          ],
        },
        { operation: "update", principals: [{ principalType: "user", principalId: "u2" }] },
      ],
    });
    expect(result).toEqual({
      id: "123456",
      permissions: [
        { operation: "read", type: "user", id: "u1", name: "Ada" },
        { operation: "read", type: "group", id: "g1" },
        { operation: "update", type: "user", id: "u2" },
      ],
      next: [["atl", "page", "permissions", "list", "123456"]],
    });
  });

  test("--allow-self-lockout is sent as allow-self-lockout=true", async () => {
    route("POST", "/api/v2/pages/123456/permissions", { results: [] });
    await run(pagePermissionsAdd, SUBJECT, { viewUser: ["u1"], allowSelfLockout: true });
    expect(onlyWrite("POST").url.searchParams.get("allow-self-lockout")).toBe("true");
  });

  test("blog posts use /blogposts and carry --type in next", async () => {
    route("POST", "/api/v2/blogposts/555/permissions", { results: [], _links: { next: "/x" } });
    const result = asRecord(
      await run(pagePermissionsAdd, { page: "555" }, { viewGroup: ["g1"], type: "blogpost" }),
    );
    expect(onlyWrite("POST").path).toBe("/api/v2/blogposts/555/permissions");
    expect(result.more).toBe(true);
    expect(result.next).toEqual([
      ["atl", "page", "permissions", "list", "555", "--type", "blogpost"],
    ]);
  });

  test("no principals is an input error before any request", async () => {
    const error = await errorOf(run(pagePermissionsAdd, SUBJECT, {}));
    expect(error.code).toBe("no_principals");
    expect(calls).toHaveLength(0);
  });

  test("--full returns the raw response without a name lookup", async () => {
    route("POST", "/api/v2/pages/123456/permissions", RESULTS);
    const result = await run(
      pagePermissionsAdd,
      SUBJECT,
      { viewUser: ["u1"] },
      ctx({ full: true }),
    );
    expect(result).toEqual(RESULTS);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v2/pages/123456",
      "/api/v2/pages/123456/permissions",
    ]);
  });

  test("--plan sends nothing", async () => {
    const argv = ["page", "permissions", "add", "123456", "--view-user", "u1", "--plan"];
    const plan = asRecord(
      await run(pagePermissionsAdd, SUBJECT, { viewUser: ["u1"] }, ctx({ plan: true, argv })),
    );
    expect(sent("POST")).toHaveLength(0);
    expect(plan.method).toBe("POST");
    expect(plan.next).toEqual([
      ["atl", "page", "permissions", "add", "123456", "--view-user", "u1"],
    ]);
  });
});

function routeBlogPost(): void {
  route("GET", "/api/v2/pages/555", { message: "not a page" }, 404);
  route("GET", "/api/v2/blogposts/555", { id: "555" });
}
describe("bare blog post id on a write that reads nothing first", () => {
  const OPEN = { state: "OPEN" };

  test("page restrict targets the blog post collection", async () => {
    routeBlogPost();
    route("PUT", "/api/v2/blogposts/555/restriction-state", OPEN);
    const result = await run(pageRestrict, { page: "555" }, { state: "open", yes: true });
    expect(onlyWrite("PUT").path).toBe("/api/v2/blogposts/555/restriction-state");
    expect(result).toEqual({ id: "555", state: "open" });
  });

  test("permissions add, set and remove target the blog post collection", async () => {
    routeBlogPost();
    route("POST", "/api/v2/blogposts/555/permissions", { results: [] });
    route("PUT", "/api/v2/blogposts/555/permissions", { results: [] });
    route("DELETE", "/api/v2/blogposts/555/permissions", undefined, 204);
    const page = { page: "555" };
    const added = asRecord(await run(pagePermissionsAdd, page, { viewUser: ["u1"] }));
    await run(pagePermissionsSet, page, { editUser: ["u1"], yes: true });
    await run(pagePermissionsRemove, page, { all: true, yes: true });
    expect(calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([
      "/api/v2/blogposts/555/permissions",
      "/api/v2/blogposts/555/permissions",
      "/api/v2/blogposts/555/permissions",
    ]);
    expect(added.next).toEqual([
      ["atl", "page", "permissions", "list", "555", "--type", "blogpost"],
    ]);
  });

  test("--plan shows the blog post URL", async () => {
    routeBlogPost();
    const plan = asRecord(
      await run(
        pageRestrict,
        { page: "555" },
        { state: "open" },
        ctx({ plan: true, argv: ["page", "restrict", "555", "--state", "open", "--plan"] }),
      ),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(String(plan.url)).toContain("/api/v2/blogposts/555/restriction-state");
  });

  test("a page id stays on /pages after one GET", async () => {
    routeProbe();
    route("PUT", "/api/v2/pages/123456/restriction-state", OPEN);
    await run(pageRestrict, SUBJECT, { state: "open", yes: true });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v2/pages/123456",
      "/api/v2/pages/123456/restriction-state",
    ]);
  });

  test("an explicit --type sends no probe", async () => {
    route("PUT", "/api/v2/blogposts/555/restriction-state", OPEN);
    await run(pageRestrict, { page: "555" }, { state: "open", yes: true, type: "blogpost" });
    expect(calls.map((call) => call.method)).toEqual(["PUT"]);
  });

  test("an id that is neither reports the page error and writes nothing", async () => {
    const error = await errorOf(run(pageRestrict, { page: "9" }, { state: "open", yes: true }));
    expect(error.status).toBe(404);
    expect(sent("PUT")).toHaveLength(0);
  });
});

describe("page.permissions.set", () => {
  beforeEach(routeProbe);

  const argv = ["page", "permissions", "set", "123456", "--edit-user", "u2"];

  test("needs --yes: nothing is sent and the error suggests a plan", async () => {
    const error = await errorOf(
      run(pagePermissionsSet, SUBJECT, { editUser: ["u2"] }, ctx({ argv })),
    );
    expect(error.code).toBe("confirmation_required");
    expect(error.next).toEqual([["atl", ...argv, "--plan"]]);
    expect(calls).toHaveLength(0);
  });

  test("--plan works without --yes and its next carries --yes", async () => {
    const plan = asRecord(
      await run(
        pagePermissionsSet,
        SUBJECT,
        { editUser: ["u2"] },
        ctx({ plan: true, argv: [...argv, "--plan"] }),
      ),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(plan.method).toBe("PUT");
    expect(plan.next).toEqual([["atl", ...argv, "--yes"]]);
  });

  test("--yes PUTs the complete replacement set", async () => {
    route("PUT", "/api/v2/pages/123456/permissions", {
      results: [{ operation: "update", principal: { principalType: "user", principalId: "u2" } }],
    });
    route("GET", "/rest/api/user/bulk", { results: [{ accountId: "u2", displayName: "Bob" }] });
    const result = asRecord(
      await run(pagePermissionsSet, SUBJECT, { editUser: ["u2"], yes: true }, ctx({ argv })),
    );
    expect(onlyWrite("PUT").body).toEqual({
      permissions: [
        { operation: "update", principals: [{ principalType: "user", principalId: "u2" }] },
      ],
    });
    expect(result.permissions).toEqual([
      { operation: "update", type: "user", id: "u2", name: "Bob" },
    ]);
  });

  test("an empty grant set is rejected: use remove --all to clear", async () => {
    const error = await errorOf(run(pagePermissionsSet, SUBJECT, { yes: true }));
    expect(error.code).toBe("no_principals");
    expect(calls).toHaveLength(0);
  });
});

describe("page.permissions.remove", () => {
  beforeEach(routeProbe);

  const argv = ["page", "permissions", "remove", "123456", "--user", "u1"];

  test("filters by principal and operation, and needs --yes", async () => {
    route("DELETE", "/api/v2/pages/123456/permissions", undefined, 204);
    const denied = await errorOf(
      run(pagePermissionsRemove, SUBJECT, { user: "u1" }, ctx({ argv })),
    );
    expect(denied.code).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
    const result = await run(
      pagePermissionsRemove,
      SUBJECT,
      { user: "u1", operation: "update", yes: true },
      ctx({ argv }),
    );
    const del = onlyWrite("DELETE");
    expect(del.url.searchParams.get("principal-type")).toBe("user");
    expect(del.url.searchParams.get("principal-id")).toBe("u1");
    expect(del.url.searchParams.get("operation")).toBe("update");
    expect(result).toEqual({
      id: "123456",
      removed: "user:u1",
      operation: "update",
      next: [["atl", "page", "permissions", "list", "123456"]],
    });
  });

  test("--group filters by group; --all sends no filters", async () => {
    route("DELETE", "/api/v2/pages/123456/permissions", undefined, 204);
    await run(pagePermissionsRemove, SUBJECT, { group: "g1", yes: true });
    expect(onlyWrite("DELETE").url.searchParams.get("principal-type")).toBe("group");
    calls = [];
    const result = asRecord(await run(pagePermissionsRemove, SUBJECT, { all: true, yes: true }));
    expect(onlyWrite("DELETE").url.search).toBe("");
    expect(result.removed).toBe("all");
  });

  test("--plan needs no --yes and its next adds it", async () => {
    const plan = asRecord(
      await run(
        pagePermissionsRemove,
        SUBJECT,
        { user: "u1" },
        ctx({ plan: true, argv: [...argv, "--plan"] }),
      ),
    );
    expect(sent("DELETE")).toHaveLength(0);
    expect(plan.method).toBe("DELETE");
    expect(plan.next).toEqual([["atl", ...argv, "--yes"]]);
  });

  test("rejects ambiguous or empty selections before any request", async () => {
    const codes = await Promise.all(
      [
        {},
        { user: "u1", group: "g1" },
        { user: "u1", all: true },
        { operation: "read", all: true },
      ].map(async (flags) => (await errorOf(run(pagePermissionsRemove, SUBJECT, flags))).code),
    );
    expect(codes).toEqual([
      "nothing_to_remove",
      "conflicting_flags",
      "conflicting_flags",
      "operation_needs_principal",
    ]);
    expect(calls).toHaveLength(0);
  });

  test("--allow-self-lockout is forwarded", async () => {
    route("DELETE", "/api/v2/pages/123456/permissions", undefined, 204);
    await run(pagePermissionsRemove, SUBJECT, { all: true, yes: true, allowSelfLockout: true });
    expect(onlyWrite("DELETE").url.searchParams.get("allow-self-lockout")).toBe("true");
  });
});

describe("page.restrict", () => {
  beforeEach(routeProbe);

  const argv = ["page", "restrict", "123456", "--state", "edit-restricted"];
  const STATE = {
    state: "EDIT_RESTRICTED",
    createdAt: "2026-10-01T10:00:00.123Z",
    createdBy: "u1",
  };

  test("needs --yes; with it PUTs the API enum and names the actor", async () => {
    route("PUT", "/api/v2/pages/123456/restriction-state", STATE);
    route("GET", "/rest/api/user/bulk", { results: [{ accountId: "u1", displayName: "Ada" }] });
    const denied = await errorOf(
      run(pageRestrict, SUBJECT, { state: "edit-restricted" }, ctx({ argv })),
    );
    expect(denied.code).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
    const result = await run(
      pageRestrict,
      SUBJECT,
      { state: "edit-restricted", yes: true },
      ctx({ argv }),
    );
    expect(onlyWrite("PUT").body).toEqual({ state: "EDIT_RESTRICTED" });
    expect(result).toEqual({
      id: "123456",
      state: "edit-restricted",
      by: "Ada",
      at: "2026-10-01T10:00:00Z",
    });
  });

  test("a 404 says the caller lacks restriction permission, not that the id is wrong", async () => {
    route(
      "PUT",
      "/api/v2/pages/123456/restriction-state",
      { message: "User must have permissions to update restrictions on the content" },
      404,
    );
    const error = await errorOf(
      run(pageRestrict, SUBJECT, { state: "edit-restricted", yes: true }, ctx({ argv })),
    );
    expect(error.code).toBe("http_404");
    expect(error.category).toBe("api");
    expect(error.hint).toContain("permission");
    expect(error.hint).not.toContain("check the id");
    route("POST", "/api/v2/pages/123456/permissions", { message: "no" }, 404);
    const grant = await errorOf(run(pagePermissionsAdd, SUBJECT, { editUser: ["u1"] }));
    expect(grant.hint).toBe(error.hint);
  });

  test("open and view-restricted map to OPEN and VIEW_RESTRICTED; OPEN has no actor", async () => {
    route("PUT", "/api/v2/pages/123456/restriction-state", { state: "OPEN" });
    const open = await run(pageRestrict, SUBJECT, { state: "open", yes: true });
    expect(onlyWrite("PUT").body).toEqual({ state: "OPEN" });
    expect(open).toEqual({ id: "123456", state: "open" });
    expect(calls.some((call) => call.path.endsWith("/user/bulk"))).toBe(false);
    calls = [];
    route("PUT", "/api/v2/pages/123456/restriction-state", { state: "VIEW_RESTRICTED" });
    await run(pageRestrict, SUBJECT, { state: "view-restricted", yes: true });
    expect(onlyWrite("PUT").body).toEqual({ state: "VIEW_RESTRICTED" });
  });

  test("--allow-self-lockout, blog posts and --full", async () => {
    route("PUT", "/api/v2/blogposts/555/restriction-state", { state: "OPEN" });
    const raw = await run(
      pageRestrict,
      { page: "555" },
      { state: "open", yes: true, allowSelfLockout: true, type: "blogpost" },
      ctx({ full: true }),
    );
    const put = onlyWrite("PUT");
    expect(put.path).toBe("/api/v2/blogposts/555/restriction-state");
    expect(put.url.searchParams.get("allow-self-lockout")).toBe("true");
    expect(raw).toEqual({ state: "OPEN" });
  });

  test("--plan needs no --yes and its next adds it", async () => {
    const plan = asRecord(
      await run(
        pageRestrict,
        SUBJECT,
        { state: "edit-restricted" },
        ctx({ plan: true, argv: [...argv, "--plan"] }),
      ),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(plan.method).toBe("PUT");
    expect(plan.next).toEqual([["atl", ...argv, "--yes"]]);
  });
});

describe("page.property.set", () => {
  const PROPS = "/api/v2/pages/123456/properties";
  const ARGS = { page: "123456", key: "nm-owner" };

  test("creates a missing property with POST and reports it as created", async () => {
    route("GET", PROPS, { results: [] });
    route("POST", PROPS, {
      id: "p1",
      key: "nm-owner",
      value: { tier: 3 },
      version: { number: 1 },
    });
    const result = await run(pagePropertySet, ARGS, { value: '{"tier":3}' });
    expect(sent("GET")[0]?.url.searchParams.get("key")).toBe("nm-owner");
    expect(onlyWrite("POST").body).toEqual({ key: "nm-owner", value: { tier: 3 } });
    expect(result).toEqual({
      id: "p1",
      key: "nm-owner",
      value: { tier: 3 },
      version: 1,
      action: "created",
      next: [["atl", "page", "properties", "123456", "--key", "nm-owner"]],
    });
  });

  test("a bare blog post id writes the property under blogposts", async () => {
    const BLOG_PROPS = "/api/v2/blogposts/777/properties";
    route("GET", BLOG_PROPS, { results: [] });
    route("POST", BLOG_PROPS, { id: "p1", key: "nm-owner", value: 1, version: { number: 1 } });
    const result = asRecord(
      await run(pagePropertySet, { page: "777", key: "nm-owner" }, { value: "1" }),
    );
    expect(onlyWrite("POST").path).toBe(BLOG_PROPS);
    expect(result.next).toEqual([
      ["atl", "page", "properties", "777", "--key", "nm-owner", "--type", "blogpost"],
    ]);
  });

  test("replaces an existing property with PUT and the next version", async () => {
    route("GET", PROPS, {
      results: [
        { id: "other", key: "nm-owner-old", version: { number: 9 } },
        { id: "p1", key: "nm-owner", value: { tier: 2 }, version: { number: 2 } },
      ],
    });
    route("PUT", `${PROPS}/p1`, {
      id: "p1",
      key: "nm-owner",
      value: { tier: 3 },
      version: { number: 3 },
    });
    const result = asRecord(await run(pagePropertySet, ARGS, { value: '{"tier":3}' }));
    expect(onlyWrite("PUT").body).toEqual({
      key: "nm-owner",
      value: { tier: 3 },
      version: { number: 3 },
    });
    expect(sent("POST")).toHaveLength(0);
    expect(result).toMatchObject({ id: "p1", version: 3, action: "updated" });
  });

  test("--value-file takes any JSON value, including a scalar", async () => {
    route("GET", PROPS, { results: [] });
    route("POST", PROPS, { id: "p2", key: "nm-owner", value: 42, version: { number: 1 } });
    const file = join(configDir, "value.json");
    await writeFile(file, "42\n");
    await run(pagePropertySet, ARGS, { valueFile: file });
    expect(asRecord(onlyWrite("POST").body).value).toBe(42);
  });

  test("a bad or missing value is an input error before any request", async () => {
    const invalid = await errorOf(run(pagePropertySet, ARGS, { value: "not json" }));
    const none = await errorOf(run(pagePropertySet, ARGS, {}));
    const both = await errorOf(run(pagePropertySet, ARGS, { value: "1", valueFile: "x.json" }));
    const absent = await errorOf(
      run(pagePropertySet, ARGS, { valueFile: join(configDir, "absent.json") }),
    );
    expect([invalid.code, none.code, both.code, absent.code]).toEqual([
      "invalid_json",
      "value_required",
      "value_required",
      "input_file_unreadable",
    ]);
    for (const error of [invalid, none, both, absent]) {
      expect(error.category).toBe("input");
    }
    expect(calls).toHaveLength(0);
  });

  test("blog posts use /blogposts and carry --type in next", async () => {
    route("GET", "/api/v2/blogposts/555/properties", { results: [] });
    route("POST", "/api/v2/blogposts/555/properties", {
      id: "p3",
      key: "k",
      version: { number: 1 },
    });
    const result = asRecord(
      await run(pagePropertySet, { page: "555", key: "k" }, { value: "true", type: "blogpost" }),
    );
    expect(onlyWrite("POST").path).toBe("/api/v2/blogposts/555/properties");
    expect(result.next).toEqual([
      ["atl", "page", "properties", "555", "--key", "k", "--type", "blogpost"],
    ]);
  });

  test("--plan reads the property but sends no write", async () => {
    route("GET", PROPS, { results: [{ id: "p1", key: "nm-owner", version: { number: 2 } }] });
    const argv = ["page", "property", "set", "123456", "nm-owner", "--value", "1", "--plan"];
    const plan = asRecord(
      await run(pagePropertySet, ARGS, { value: "1" }, ctx({ plan: true, argv })),
    );
    expect(sent("PUT")).toHaveLength(0);
    expect(plan.method).toBe("PUT");
    expect(String(plan.url)).toEndWith(`${PROPS}/p1`);
    expect(plan.next).toEqual([["atl", ...argv.slice(0, -1)]]);
  });

  test("a 409 is a transient version_conflict that re-reads the property", async () => {
    route("GET", PROPS, { results: [{ id: "p1", key: "nm-owner", version: { number: 2 } }] });
    route("PUT", `${PROPS}/p1`, { message: "stale" }, 409);
    const error = await errorOf(run(pagePropertySet, ARGS, { value: "1" }));
    expect(error.code).toBe("version_conflict");
    expect(error.next).toEqual([["atl", "page", "properties", "123456", "--key", "nm-owner"]]);
  });
});

describe("page.property.delete", () => {
  const PROPS = "/api/v2/pages/123456/properties";
  const ARGS = { page: "123456", key: "nm-owner" };
  const argv = ["page", "property", "delete", "123456", "nm-owner"];

  test("needs --yes; with it DELETEs the property found by key", async () => {
    route("GET", PROPS, { results: [{ id: "p1", key: "nm-owner", version: { number: 2 } }] });
    route("DELETE", `${PROPS}/p1`, undefined, 204);
    const denied = await errorOf(run(pagePropertyDelete, ARGS, {}, ctx({ argv })));
    expect(denied.code).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
    const result = await run(pagePropertyDelete, ARGS, { yes: true });
    expect(onlyWrite("DELETE").path).toBe(`${PROPS}/p1`);
    expect(result).toEqual({ id: "123456", deleted: "nm-owner", propertyId: "p1" });
  });

  test("an unknown key is an api property_not_found and deletes nothing", async () => {
    route("GET", PROPS, { results: [] });
    const error = await errorOf(run(pagePropertyDelete, ARGS, { yes: true }));
    expect(error.code).toBe("property_not_found");
    expect(error.category).toBe("api");
    expect(sent("DELETE")).toHaveLength(0);
  });

  test("--plan needs no --yes and its next adds it", async () => {
    route("GET", PROPS, { results: [{ id: "p1", key: "nm-owner", version: { number: 2 } }] });
    const plan = asRecord(
      await run(pagePropertyDelete, ARGS, {}, ctx({ plan: true, argv: [...argv, "--plan"] })),
    );
    expect(sent("DELETE")).toHaveLength(0);
    expect(plan.method).toBe("DELETE");
    expect(plan.next).toEqual([["atl", ...argv, "--yes"]]);
  });
});
