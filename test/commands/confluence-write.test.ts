import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confluenceCommands,
  confluenceDeps,
  confluenceGroups,
} from "../../src/commands/confluence.ts";
import {
  adfPlainText,
  commentAdd,
  commentUpdate,
  confluenceWriteCommands,
  locateSelection,
  pageCreate,
  pageUpdate,
} from "../../src/commands/confluence-write.ts";
import { bodyDeps } from "../../src/commands/write.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { makeContext } from "../helpers/context.ts";

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
    const hit = routes.get(`${method} ${path}`);
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
  test("exposes the four write commands with side effects and MCP mappings", () => {
    expect(confluenceWriteCommands.map((c) => c.name)).toEqual([
      "page.create",
      "page.update",
      "comment.add",
      "comment.update",
    ]);
    expect(confluenceWriteCommands.every((c) => c.sideEffects === "write")).toBe(true);
    expect(confluenceWriteCommands.flatMap((c) => c.mcpTools ?? [])).toEqual([
      "createConfluencePage",
      "updateConfluencePage",
      "createConfluenceFooterComment",
      "createConfluenceInlineComment",
    ]);
  });

  test("every read command maps to MCP tools or is a CLI-only addition", () => {
    const mapped = confluenceCommands.filter((c) => c.mcpTools !== undefined).map((c) => c.name);
    expect(mapped).toEqual([
      "page.get",
      "page.tree",
      "space.list",
      "space.pages",
      "comment.list",
      "comment.replies",
      "cql",
    ]);
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

  test("--file replaces the body and bumps the version without fetching the old body", async () => {
    route("GET", "/api/v2/pages/123456", CURRENT);
    route("PUT", "/api/v2/pages/123456", UPDATED);
    const result = await run(
      pageUpdate,
      { page: "123456" },
      { file: bodyFile(), message: "Fix steps" },
    );
    expect(sent("GET")[0]?.url.searchParams.has("body-format")).toBe(false);
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

  test("a footer reply sends parentCommentId only and reads nothing", async () => {
    route("POST", "/api/v2/footer-comments", { ...FOOTER, id: "9002", parentCommentId: "9001" });
    const result = await run(commentAdd, {}, { file: bodyFile(), replyTo: "9001" });
    expect(calls).toHaveLength(1);
    const body = asRecord(onlyWrite("POST").body);
    expect(Object.keys(body).toSorted()).toEqual(["body", "parentCommentId"]);
    expect(body.parentCommentId).toBe("9001");
    expect(result).toMatchObject({ id: "9002", parentCommentId: "9001" });
  });

  test("an inline reply posts to /inline-comments with parentCommentId", async () => {
    route("POST", "/api/v2/inline-comments", { ...INLINE, id: "9101", parentCommentId: "9100" });
    const result = await run(commentAdd, {}, { file: bodyFile(), replyTo: "9100", inline: true });
    const post = onlyWrite("POST");
    expect(post.path).toBe("/api/v2/inline-comments");
    expect(Object.keys(asRecord(post.body)).toSorted()).toEqual(["body", "parentCommentId"]);
    expect(result).toMatchObject({
      type: "inline-comment",
      next: [["atl", "comment", "get", "9101", "--inline"]],
    });
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
      { file: bodyFile(), inline: true, select: "Hello", match: 3 },
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
      { file: bodyFile(), inline: true, select: "alpha" },
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
      { file: bodyFile(), inline: true, select: "once", targetType: "blogpost" },
    );
    expect(asRecord(onlyWrite("POST").body)).toMatchObject({ blogPostId: "555" });
  });

  test("a selection missing from the page is an input error and nothing is posted", async () => {
    route("GET", "/api/v2/pages/123456", {
      id: "123456",
      body: { atlas_doc_format: { value: adf("Some text") } },
    });
    const error = await errorOf(
      run(commentAdd, { target: "123456" }, { file: bodyFile(), inline: true, select: "absent" }),
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
        { file: bodyFile(), inline: true, select: "one", match: 3 },
      ),
    );
    expect(error.code).toBe("match_out_of_range");
    expect(sent("POST")).toHaveLength(0);
  });

  test("flag validation fails before any request", async () => {
    const cases: [Record<string, string>, Record<string, unknown>, string][] = [
      [{}, {}, "missing_target"],
      [{ target: "123456" }, { inline: true }, "missing_flag"],
      [{ target: "123456" }, { select: "x" }, "invalid_flag_combination"],
      [
        { target: "att1" },
        { inline: true, select: "x", targetType: "attachment" },
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
      "--inline",
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
        { file: bodyFile(), inline: true, select: "anchor" },
        ctx({ plan: true, argv }),
      ),
    );
    expect(sent("POST")).toHaveLength(0);
    expect(plan).toMatchObject({ type: "plan", method: "POST" });
    expect(String(plan.url)).toEndWith("/wiki/api/v2/inline-comments");
    expect(plan.next).toEqual([
      ["atl", "comment", "add", "123456", "--inline", "--select", "anchor", "--file", "n.md"],
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

  test("--inline --resolve re-sends the current body and sets resolved", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE_NOW);
    route("PUT", "/api/v2/inline-comments/9100", { ...INLINE_NOW, version: { number: 3 } });
    const result = await run(commentUpdate, { comment: "9100" }, { inline: true, resolve: true });
    const body = asRecord(onlyWrite("PUT").body);
    expect(body).toMatchObject({ version: { number: 3 }, resolved: true });
    expect(body.body).toEqual({ representation: "atlas_doc_format", value: adf("Old comment") });
    expect(result).toMatchObject({
      type: "inline-comment",
      next: [["atl", "comment", "get", "9100", "--inline"]],
    });
  });

  test("--reopen sets resolved to false", async () => {
    route("GET", "/api/v2/inline-comments/9100", INLINE_NOW);
    route("PUT", "/api/v2/inline-comments/9100", INLINE_NOW);
    await run(commentUpdate, { comment: "9100" }, { inline: true, reopen: true, file: bodyFile() });
    expect(asRecord(onlyWrite("PUT").body)).toMatchObject({ resolved: false });
  });

  test("flag validation fails before any request", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ inline: true, resolve: true, reopen: true }, "invalid_flag_combination"],
      [{ resolve: true }, "invalid_flag_combination"],
      [{ inline: true }, "nothing_to_update"],
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
      run(commentUpdate, { comment: "9100" }, { inline: true, file: bodyFile() }),
    );
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe("version_conflict");
    expect(error.next).toEqual([["atl", "comment", "get", "9100", "--inline"]]);
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
});
