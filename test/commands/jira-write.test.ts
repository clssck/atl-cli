import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToAdf } from "../../src/adf/index.ts";
import { jiraCommands, jiraDeps } from "../../src/commands/jira.ts";
import { jiraWriteCommands } from "../../src/commands/jira-write.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { bodyDeps } from "../../src/commands/write.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const PREFIX = `/ex/jira/${CLOUD}`;
const API = `https://api.atlassian.com${PREFIX}`;

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface Reply {
  status: number;
  body?: unknown;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const TYPES_ROUTE = "GET /rest/api/3/issue/createmeta/ABC/issuetypes";
const TYPES = ok({
  isLast: true,
  issueTypes: [
    { id: "10001", name: "Task" },
    { id: "10002", name: "Bug" },
    { id: "10004", name: "Story" },
  ],
});
const created = (body?: unknown): Reply => ({ status: 201, body });
const noContent: Reply = { status: 204 };

let root: string;
let env: NodeJS.ProcessEnv;
let sent: Sent[];

/** Routes are keyed `METHOD /path` (path relative to the cloud's Jira base). */
function serve(routes: Record<string, Reply>): void {
  jiraDeps.fetch = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.slice(PREFIX.length);
    sent.push({
      method,
      path,
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const forced = new Headers(init?.headers).has("x-force-accept-language");
    const reply =
      (forced ? routes[`EN ${method} ${path}`] : undefined) ?? routes[`${method} ${path}`];
    if (reply === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ errorMessages: [`no route ${method} ${path}`] }), {
          status: 404,
        }),
      );
    }
    if (reply.body === undefined) {
      return Promise.resolve(new Response(null, { status: reply.status }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

const writes = () => sent.filter((s) => s.method !== "GET");

function command(name: string): CommandSpec {
  const spec = jiraWriteCommands.find((c) => c.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

async function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  options: { rest?: string[]; ctx?: Partial<CommandContext> } = {},
): Promise<unknown> {
  return command(name).run(makeContext(env, options.ctx), {
    args,
    rest: options.rest ?? [],
    flags,
  });
}

/** A top-level property of the JSON body of the nth write sent. */
function bodyField(index: number, name: string): unknown {
  const body = writes()[index]?.body;
  return isRecord(body) ? body[name] : undefined;
}

async function file(name: string, content: string): Promise<string> {
  const path = join(root, name);
  await Bun.write(path, content);
  return path;
}

async function failure(promise: Promise<unknown>): Promise<AtlError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AtlError)) {
    throw new Error("expected an AtlError rejection");
  }
  return error;
}

/** The `fields` object of the create request sent for `issue.create --set <entries>`. */
async function fieldsOf(set: string[]): Promise<Record<string, unknown>> {
  serve({ [TYPES_ROUTE]: TYPES, "POST /rest/api/3/issue": created({ id: "1", key: "ABC-1" }) });
  await run("issue.create", {}, { project: "ABC", type: "Task", summary: "S", set });
  const fields = bodyField(0, "fields");
  if (!isRecord(fields)) {
    throw new Error("create request carried no fields");
  }
  return fields;
}

const TRANSITIONS = {
  transitions: [
    { id: "11", name: "Start Progress", to: { id: "3", name: "In Progress" } },
    { id: "21", name: "Resolve", to: { id: "5", name: "Done" } },
    { id: "31", name: "Close", to: { id: "6", name: "Closed" } },
  ],
};

const LINK_TYPES = {
  issueLinkTypes: [
    { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    { id: "10001", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
    { id: "10002", name: "Relates", inward: "relates to", outward: "relates to" },
  ],
};

const REFRESHED = {
  id: "10042",
  key: "ABC-123",
  fields: {
    summary: "New title",
    status: { name: "To Do", statusCategory: { key: "new" } },
    issuetype: { name: "Task" },
    labels: ["web"],
    project: { key: "ABC", name: "Alpha" },
    customfield_10010: "custom",
    description: markdownToAdf("Body"),
  },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-jira-write-test-"));
  env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
  await saveConfig(
    {
      sites: {
        "acme.atlassian.net": {
          cloudId: CLOUD,
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["write:jira-work"],
          cachedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
    env,
  );
  sent = [];
});

afterEach(async () => {
  jiraDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("issue.create", () => {
  test("POSTs project, issue type, summary, description, parent, assignee and --set fields", async () => {
    serve({
      [TYPES_ROUTE]: TYPES,
      "POST /rest/api/3/issue": created({ id: "10050", key: "ABC-50", self: "x" }),
    });
    const desc = await file("desc.md", "Hello **world**");
    const extra = await file("extra.json", JSON.stringify({ components: [{ name: "Backend" }] }));
    const result = await run(
      "issue.create",
      {},
      {
        project: "ABC",
        type: "Bug",
        summary: "Crash on save",
        file: desc,
        parent: "ABC-1",
        assignee: "acc-1",
        set: ['labels=["a","b"]', 'priority={"name":"High"}', "customfield_10010=plain text"],
        fieldsFile: extra,
      },
    );

    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/rest/api/3/issue" });
    expect(writes()[0]?.body).toEqual({
      fields: {
        project: { key: "ABC" },
        issuetype: { id: "10002" },
        summary: "Crash on save",
        description: markdownToAdf("Hello **world**"),
        parent: { key: "ABC-1" },
        assignee: { accountId: "acc-1" },
        labels: ["a", "b"],
        priority: { name: "High" },
        customfield_10010: "plain text",
        components: [{ name: "Backend" }],
      },
    });
    expect(result).toEqual({
      key: "ABC-50",
      url: "https://acme.atlassian.net/browse/ABC-50",
      next: [["atl", "issue", "get", "ABC-50"]],
    });
  });

  test("numeric project and type values are sent as ids", async () => {
    serve({
      "GET /rest/api/3/issue/createmeta/10000/issuetypes": TYPES,
      "POST /rest/api/3/issue": created({ id: "1", key: "ABC-1" }),
    });
    await run("issue.create", {}, { project: "10000", type: "10004", summary: "S" });
    expect(bodyField(0, "fields")).toEqual({
      project: { id: "10000" },
      issuetype: { id: "10004" },
      summary: "S",
    });
  });

  test("--transition resolves by name after creation and POSTs the transition id", async () => {
    serve({
      [TYPES_ROUTE]: TYPES,
      "POST /rest/api/3/issue": created({ id: "10050", key: "ABC-50" }),
      "GET /rest/api/3/issue/ABC-50/transitions": ok(TRANSITIONS),
      "POST /rest/api/3/issue/ABC-50/transitions": noContent,
    });
    const result = await run(
      "issue.create",
      {},
      {
        project: "ABC",
        type: "Task",
        summary: "S",
        transition: "start progress",
      },
    );
    expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /rest/api/3/issue",
      "POST /rest/api/3/issue/ABC-50/transitions",
    ]);
    expect(writes()[1]?.body).toEqual({ transition: { id: "11" } });
    expect(result).toMatchObject({
      key: "ABC-50",
      transitioned: { id: "11", name: "Start Progress", to: "In Progress" },
    });
  });

  test("a failing transition reports that the issue exists and points at issue move", async () => {
    serve({
      [TYPES_ROUTE]: TYPES,
      "POST /rest/api/3/issue": created({ id: "10050", key: "ABC-50" }),
      "GET /rest/api/3/issue/ABC-50/transitions": ok(TRANSITIONS),
    });
    const error = await failure(
      run("issue.create", {}, { project: "ABC", type: "Task", summary: "S", transition: "Nope" }),
    );
    expect(error.code).toBe("unknown_transition");
    expect(error.message).toContain("ABC-50 was created");
    expect(error.next).toEqual([["atl", "issue", "transitions", "ABC-50"]]);
  });

  test("--plan returns the create request without sending it", async () => {
    serve({ [TYPES_ROUTE]: TYPES });
    const plan = await run(
      "issue.create",
      {},
      { project: "ABC", type: "Task", summary: "S", transition: "Done" },
      { ctx: { plan: true, argv: ["issue", "create", "--project", "ABC", "--plan"] } },
    );
    expect(writes()).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: `${API}/rest/api/3/issue`,
      next: [["atl", "issue", "create", "--project", "ABC"]],
      followUp: {
        method: "POST",
        url: `${API}/rest/api/3/issue/<new key>/transitions`,
        transition: "Done",
      },
      body: { preview: expect.stringContaining('"summary":"S"') },
    });
  });

  test("an unknown --type fails locally, listing names, also under --plan", async () => {
    serve({ [TYPES_ROUTE]: TYPES });
    for (const plan of [false, true]) {
      const error = await failure(
        run("issue.create", {}, { project: "ABC", type: "Bogus", summary: "S" }, { ctx: { plan } }),
      );
      expect(error.code).toBe("unknown_issue_type");
      expect(error.category).toBe("input");
      expect(error.message).toContain("Task, Bug, Story");
    }
    expect(writes()).toEqual([]);
  });

  test("--type matches names case-insensitively", async () => {
    serve({ [TYPES_ROUTE]: TYPES, "POST /rest/api/3/issue": created({ id: "1", key: "ABC-1" }) });
    await run("issue.create", {}, { project: "ABC", type: "bUg", summary: "S" });
    expect(bodyField(0, "fields")).toMatchObject({ issuetype: { id: "10002" } });
  });

  test("a dedicated flag colliding with --set is an input error", async () => {
    serve({ [TYPES_ROUTE]: TYPES });
    const error = await failure(
      run(
        "issue.create",
        {},
        { project: "ABC", type: "Task", summary: "S", set: ["summary=other"] },
      ),
    );
    expect(error.code).toBe("duplicate_field");
    expect(error.category).toBe("input");
    expect(writes()).toEqual([]);
  });
});

describe("--set parsing", () => {
  test("values parse as JSON when they can, else stay strings", async () => {
    const fields = await fieldsOf([
      'labels=["a","b"]',
      'priority={"name":"High"}',
      "customfield_1=42",
      "customfield_2=true",
      "customfield_3=null",
      "customfield_4=hello world",
      "customfield_5=a=b",
      "customfield_6=[not json",
    ]);
    expect(fields).toMatchObject({
      labels: ["a", "b"],
      priority: { name: "High" },
      customfield_1: 42,
      customfield_2: true,
      customfield_3: null,
      customfield_4: "hello world",
      customfield_5: "a=b",
      customfield_6: "[not json",
    });
  });

  test("description strings become ADF markdown, ADF objects pass through, summary stays text", async () => {
    serve({
      "PUT /rest/api/3/issue/ABC-1": noContent,
      "GET /rest/api/3/issue/ABC-1": ok(REFRESHED),
    });
    const adf = markdownToAdf("Direct");
    await run(
      "issue.edit",
      { issue: "ABC-1" },
      { set: ["description=Some *text*", "summary=123"] },
    );
    expect(writes()[0]?.body).toEqual({
      fields: { description: markdownToAdf("Some *text*"), summary: "123" },
    });
    sent = [];
    await run("issue.edit", { issue: "ABC-1" }, { set: [`description=${JSON.stringify(adf)}`] });
    expect(writes()[0]?.body).toEqual({ fields: { description: adf } });
  });

  test("--set assignee takes an account id, none, or auto and rejects a name Jira would turn into unassigned", async () => {
    serve({
      "PUT /rest/api/3/issue/ABC-1": noContent,
      "GET /rest/api/3/issue/ABC-1": ok(REFRESHED),
    });
    const id = "62a219658783e7006f627f3b";
    await run("issue.edit", { issue: "ABC-1" }, { set: [`assignee=${id}`] });
    await run("issue.edit", { issue: "ABC-1" }, { set: ["assignee=none"] });
    await run("issue.edit", { issue: "ABC-1" }, { set: ["assignee=auto"] });
    await run("issue.edit", { issue: "ABC-1" }, { set: ['assignee={"accountId":"x"}'] });
    expect(writes().map((w) => w.body)).toEqual([
      { fields: { assignee: { accountId: id } } },
      { fields: { assignee: { accountId: null } } },
      { fields: { assignee: { accountId: "-1" } } },
      { fields: { assignee: { accountId: "x" } } },
    ]);
    sent = [];
    const error = await failure(
      run("issue.edit", { issue: "ABC-1" }, { set: ["assignee=nobody"] }),
    );
    expect(error.code).toBe("invalid_assignee");
    expect(sent).toEqual([]);
  });

  test("an entry without field=value is rejected", async () => {
    serve({});
    const error = await failure(run("issue.edit", { issue: "ABC-1" }, { set: ["labels"] }));
    expect(error.code).toBe("invalid_set");
    expect(sent).toEqual([]);
  });

  test("--fields-file must hold a JSON object", async () => {
    serve({});
    const bad = await file("bad.json", "[1,2]");
    const error = await failure(run("issue.edit", { issue: "ABC-1" }, { fieldsFile: bad }));
    expect(error.code).toBe("invalid_json_file");
  });
});

describe("issue.edit", () => {
  test("PUTs the fields, then GETs and returns the compact refreshed issue", async () => {
    serve({
      "PUT /rest/api/3/issue/ABC-123": noContent,
      "GET /rest/api/3/issue/ABC-123": ok(REFRESHED),
    });
    const desc = await file("desc.md", "Body");
    const result = await run(
      "issue.edit",
      { issue: "ABC-123" },
      {
        summary: "New title",
        file: desc,
        assignee: "acc-9",
        set: ["customfield_10010=custom", "resolution=null"],
      },
    );

    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "PUT /rest/api/3/issue/ABC-123",
      "GET /rest/api/3/issue/ABC-123",
    ]);
    expect(sent[0]?.body).toEqual({
      fields: {
        summary: "New title",
        description: markdownToAdf("Body"),
        assignee: { accountId: "acc-9" },
        customfield_10010: "custom",
        resolution: null,
      },
    });
    expect(sent[1]?.query.get("fields")).toContain("customfield_10010,resolution");
    expect(result).toMatchObject({
      key: "ABC-123",
      summary: "New title",
      description: ["Body"],
      customfield_10010: "custom",
      url: "https://acme.atlassian.net/browse/ABC-123",
    });
  });

  test("--plan returns the PUT plan and sends nothing", async () => {
    serve({});
    const plan = await run(
      "issue.edit",
      { issue: "ABC-123" },
      { summary: "New title" },
      {
        ctx: { plan: true, argv: ["issue", "edit", "ABC-123", "--summary", "New title", "--plan"] },
      },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "PUT",
      url: `${API}/rest/api/3/issue/ABC-123`,
      next: [["atl", "issue", "edit", "ABC-123", "--summary", "New title"]],
    });
  });

  test("with nothing to change it fails before any request", async () => {
    serve({});
    const error = await failure(run("issue.edit", { issue: "ABC-123" }, {}));
    expect(error.code).toBe("nothing_to_edit");
    expect(sent).toEqual([]);
  });

  test("a 409 surfaces as exit 3 with the read command as next", async () => {
    serve({
      "PUT /rest/api/3/issue/ABC-123": { status: 409, body: { errorMessages: ["conflict"] } },
    });
    const error = await failure(run("issue.edit", { issue: "ABC-123" }, { summary: "X" }));
    expect(error.exitCode).toBe(3);
    expect(error.hint).toContain("re-read");
    expect(error.next).toEqual([["atl", "issue", "get", "ABC-123"]]);
  });
});

describe("issue.comment", () => {
  const COMMENT = {
    id: "10050",
    author: { accountId: "acc-1" },
    created: "c",
    updated: "u",
    body: markdownToAdf("Looks good"),
  };

  test("POSTs an ADF body to the comment collection", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/comment": created(COMMENT) });
    const note = await file("note.md", "Looks good");
    const result = await run("issue.comment", { issue: "ABC-123" }, { file: note });
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: "/rest/api/3/issue/ABC-123/comment",
    });
    expect(writes()[0]?.body).toEqual({ body: markdownToAdf("Looks good") });
    expect(result).toMatchObject({
      id: "10050",
      author: "acc-1",
      body: ["Looks good"],
      issue: "ABC-123",
      url: "https://acme.atlassian.net/browse/ABC-123?focusedCommentId=10050",
    });
  });

  test("--edit PUTs to the comment item and --visibility is sent as {type,value}", async () => {
    serve({ "PUT /rest/api/3/issue/ABC-123/comment/10050": ok(COMMENT) });
    const note = await file("note.md", "Looks good");
    await run(
      "issue.comment",
      { issue: "ABC-123" },
      { file: note, edit: "10050", visibilityType: "role", visibility: "Developers" },
    );
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: "/rest/api/3/issue/ABC-123/comment/10050",
    });
    expect(writes()[0]?.body).toEqual({
      body: markdownToAdf("Looks good"),
      visibility: { type: "role", value: "Developers" },
    });
  });

  test("an ADF JSON file is sent as-is", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/comment": created(COMMENT) });
    const adf = markdownToAdf("Raw ADF");
    const path = await file("note.json", JSON.stringify(adf));
    await run("issue.comment", { issue: "ABC-123" }, { file: path });
    expect(writes()[0]?.body).toEqual({ body: adf });
  });

  test("--visibility-type without --visibility is an input error", async () => {
    serve({});
    const note = await file("note.md", "x");
    const error = await failure(
      run("issue.comment", { issue: "ABC-123" }, { file: note, visibilityType: "group" }),
    );
    expect(error.code).toBe("invalid_visibility");
    expect(sent).toEqual([]);
  });

  test("--plan returns the plan and sends nothing", async () => {
    serve({});
    const note = await file("note.md", "x");
    const plan = await run(
      "issue.comment",
      { issue: "ABC-123" },
      { file: note, edit: "7" },
      {
        ctx: {
          plan: true,
          argv: ["issue", "comment", "ABC-123", "--file", note, "--edit", "7", "--plan"],
        },
      },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "PUT",
      url: `${API}/rest/api/3/issue/ABC-123/comment/7`,
      next: [["atl", "issue", "comment", "ABC-123", "--file", note, "--edit", "7"]],
    });
  });
});

describe("issue.move", () => {
  const route = {
    "GET /rest/api/3/issue/ABC-123/transitions": ok(TRANSITIONS),
    "POST /rest/api/3/issue/ABC-123/transitions": noContent,
  };

  test("resolves a transition name case-insensitively", async () => {
    serve(route);
    const result = await run("issue.move", { issue: "ABC-123", transition: "start PROGRESS" });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body).toEqual({ transition: { id: "11" } });
    expect(result).toEqual({
      key: "ABC-123",
      transition: { id: "11", name: "Start Progress" },
      status: "In Progress",
      next: [["atl", "issue", "get", "ABC-123"]],
    });
  });

  test("resolves a target status name", async () => {
    serve(route);
    await run("issue.move", { issue: "ABC-123", transition: "done" });
    expect(writes()[0]?.body).toEqual({ transition: { id: "21" } });
  });

  test("accepts a transition id", async () => {
    serve(route);
    await run("issue.move", { issue: "ABC-123", transition: "31" });
    expect(writes()[0]?.body).toEqual({ transition: { id: "31" } });
  });

  test("an unknown transition lists the available names and sends nothing", async () => {
    serve(route);
    const error = await failure(run("issue.move", { issue: "ABC-123", transition: "Reopen" }));
    expect(error.category).toBe("input");
    expect(error.code).toBe("unknown_transition");
    expect(error.message).toContain("Start Progress (11 -> In Progress)");
    expect(error.message).toContain("Resolve (21 -> Done)");
    expect(error.next).toEqual([["atl", "issue", "transitions", "ABC-123"]]);
    expect(writes()).toEqual([]);
  });

  test("an ambiguous status name asks for a transition id", async () => {
    serve({
      "GET /rest/api/3/issue/ABC-123/transitions": ok({
        transitions: [
          { id: "1", name: "Finish", to: { name: "Done" } },
          { id: "2", name: "Abort", to: { name: "Done" } },
        ],
      }),
    });
    const error = await failure(run("issue.move", { issue: "ABC-123", transition: "Done" }));
    expect(error.code).toBe("ambiguous_transition");
    expect(writes()).toEqual([]);
  });

  test("sends fields and update from files", async () => {
    serve(route);
    const update = await file("update.json", JSON.stringify({ labels: [{ add: "shipped" }] }));
    const history = await file("history.json", JSON.stringify({ type: "cli" }));
    await run(
      "issue.move",
      { issue: "ABC-123", transition: "Resolve" },
      {
        set: ['resolution={"name":"Done"}'],
        updateFile: update,
        historyMetadataFile: history,
      },
    );
    expect(writes()[0]?.body).toEqual({
      transition: { id: "21" },
      fields: { resolution: { name: "Done" } },
      update: { labels: [{ add: "shipped" }] },
      historyMetadata: { type: "cli" },
    });
  });

  test("--comment is posted through the comment API after the transition and its id reported", async () => {
    serve({ ...route, "POST /rest/api/3/issue/ABC-123/comment": created({ id: "900" }) });
    const result = await run(
      "issue.move",
      { issue: "ABC-123", transition: "Resolve" },
      { comment: "Done because" },
    );
    expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /rest/api/3/issue/ABC-123/transitions",
      "POST /rest/api/3/issue/ABC-123/comment",
    ]);
    expect(writes()[0]?.body).toEqual({ transition: { id: "21" } });
    expect(writes()[1]?.body).toEqual({ body: markdownToAdf("Done because") });
    expect(result).toMatchObject({ key: "ABC-123", comment: { id: "900" } });
  });

  test("a failed transition posts no comment; a failed comment says the transition happened", async () => {
    serve({
      "GET /rest/api/3/issue/ABC-123/transitions": ok(TRANSITIONS),
      "POST /rest/api/3/issue/ABC-123/transitions": {
        status: 400,
        body: { errorMessages: ["no"] },
      },
    });
    await failure(run("issue.move", { issue: "ABC-123", transition: "Resolve" }, { comment: "x" }));
    expect(writes().map((w) => w.path)).toEqual(["/rest/api/3/issue/ABC-123/transitions"]);

    sent = [];
    serve({
      ...route,
      "POST /rest/api/3/issue/ABC-123/comment": { status: 403, body: { errorMessages: ["no"] } },
    });
    const error = await failure(
      run("issue.move", { issue: "ABC-123", transition: "Resolve" }, { comment: "x" }),
    );
    expect(error.message).toContain("was transitioned, but the comment was not posted");
    expect(error.next).toEqual([["atl", "issue", "get", "ABC-123"]]);
  });

  test("--plan resolves the transition, sends no write, and shows the comment as followUp", async () => {
    serve(route);
    const plan = await run(
      "issue.move",
      { issue: "ABC-123", transition: "Close" },
      { comment: "why" },
      {
        ctx: {
          plan: true,
          argv: ["issue", "move", "ABC-123", "Close", "--comment", "why", "--plan"],
        },
      },
    );
    expect(writes()).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: `${API}/rest/api/3/issue/ABC-123/transitions`,
      followUp: { method: "POST", url: `${API}/rest/api/3/issue/ABC-123/comment` },
      next: [["atl", "issue", "move", "ABC-123", "Close", "--comment", "why"]],
    });
  });

  test("--plan still resolves the transition but sends no write", async () => {
    serve(route);
    const plan = await run(
      "issue.move",
      { issue: "ABC-123", transition: "Close" },
      {},
      { ctx: { plan: true, argv: ["issue", "move", "ABC-123", "Close", "--plan"] } },
    );
    expect(writes()).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: `${API}/rest/api/3/issue/ABC-123/transitions`,
      next: [["atl", "issue", "move", "ABC-123", "Close"]],
    });
  });

  describe("localized account", () => {
    const localized = ok({
      transitions: [
        { id: "11", name: "Elintézendő", to: { name: "Teendő" } },
        { id: "21", name: "Folyamatban", to: { name: "Folyamatban" } },
      ],
    });
    const english = ok({
      transitions: [
        { id: "11", name: "To Do", to: { name: "To Do" } },
        { id: "21", name: "In Progress", to: { name: "In Progress" } },
      ],
    });
    const hungarian = {
      "GET /rest/api/3/issue/ABC-123/transitions": localized,
      "EN GET /rest/api/3/issue/ABC-123/transitions": english,
      "POST /rest/api/3/issue/ABC-123/transitions": noContent,
    };

    test("localized and English transition and status names resolve to the same transition", async () => {
      serve(hungarian);
      for (const wanted of [
        "Folyamatban",
        "In Progress",
        "in progress",
        "Elintézendő",
        "To Do",
        "Teendő",
      ]) {
        await run("issue.move", { issue: "ABC-123", transition: wanted });
      }
      expect(
        writes().map(
          (w) => isRecord(w.body) && isRecord(w.body.transition) && w.body.transition.id,
        ),
      ).toEqual(["21", "21", "21", "11", "11", "11"]);
    });

    test("an unknown name lists both forms", async () => {
      serve(hungarian);
      const error = await failure(run("issue.move", { issue: "ABC-123", transition: "Nope" }));
      expect(error.code).toBe("unknown_transition");
      expect(error.message).toContain("Elintézendő / To Do (11 -> Teendő / To Do)");
    });
  });
});

describe("issue.log", () => {
  const WORKLOG = {
    id: "10200",
    issueId: "10042",
    timeSpent: "2h 30m",
    timeSpentSeconds: 9000,
    started: "2026-03-09T09:00:00.000+0000",
    author: { accountId: "acc-1" },
  };

  test("POSTs the joined time, ISO started and an ADF comment", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/worklog": created(WORKLOG) });
    const note = await file("work.md", "Pairing");
    const result = await run(
      "issue.log",
      { issue: "ABC-123" },
      { started: "2026-03-09T10:00:00+01:00", commentFile: note },
      { rest: ["2h", "30m"] },
    );
    expect(writes()[0]).toMatchObject({
      method: "POST",
      path: "/rest/api/3/issue/ABC-123/worklog",
    });
    expect(writes()[0]?.body).toEqual({
      timeSpent: "2h 30m",
      started: "2026-03-09T09:00:00.000+0000",
      comment: markdownToAdf("Pairing"),
    });
    expect(result).toEqual({
      id: "10200",
      issue: "ABC-123",
      timeSpent: "2h 30m",
      started: "2026-03-09T09:00:00+0000",
      author: "acc-1",
    });
  });

  test("a Jira-formatted --started is passed through unchanged", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/worklog": created(WORKLOG) });
    await run(
      "issue.log",
      { issue: "ABC-123" },
      { started: "2026-03-09T09:00:00.000+0100" },
      { rest: ["1h"] },
    );
    expect(bodyField(0, "started")).toBe("2026-03-09T09:00:00.000+0100");
  });

  test("--edit PUTs to the worklog item; time may be omitted; visibility is forwarded", async () => {
    serve({ "PUT /rest/api/3/issue/ABC-123/worklog/10200": ok(WORKLOG) });
    await run(
      "issue.log",
      { issue: "ABC-123" },
      { edit: "10200", visibilityType: "group", visibility: "devs" },
    );
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: "/rest/api/3/issue/ABC-123/worklog/10200",
    });
    expect(writes()[0]?.body).toEqual({ visibility: { type: "group", value: "devs" } });
  });

  test("a new worklog without time fails before any request", async () => {
    serve({});
    const error = await failure(run("issue.log", { issue: "ABC-123" }, {}));
    expect(error.code).toBe("missing_time");
    expect(sent).toEqual([]);
  });

  test.each(["notatime", "2x", "h", "1..5h", "2h,30m", "2h30m"])(
    "invalid duration %p fails before any request",
    async (bad) => {
      serve({});
      const error = await failure(run("issue.log", { issue: "ABC-123" }, {}, { rest: [bad] }));
      expect(error.code).toBe("invalid_time_spent");
      expect(error.category).toBe("input");
      expect(sent).toEqual([]);
    },
  );

  test.each(["1d", "1.5h", "2h 30m", "1w 2d 3h 4m"])("duration %p is accepted", async (good) => {
    serve({ "POST /rest/api/3/issue/ABC-123/worklog": created(WORKLOG) });
    await run("issue.log", { issue: "ABC-123" }, {}, { rest: good.split(" ") });
    expect(bodyField(0, "timeSpent")).toBe(good);
  });

  test("an unparseable --started is an input error", async () => {
    serve({});
    const error = await failure(
      run("issue.log", { issue: "ABC-123" }, { started: "yesterday-ish" }, { rest: ["1h"] }),
    );
    expect(error.code).toBe("invalid_started");
  });

  test("--plan sends nothing", async () => {
    serve({});
    const plan = await run(
      "issue.log",
      { issue: "ABC-123" },
      {},
      { rest: ["1h"], ctx: { plan: true, argv: ["issue", "log", "ABC-123", "1h", "--plan"] } },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      next: [["atl", "issue", "log", "ABC-123", "1h"]],
    });
  });
});

describe("issue.link", () => {
  const route = {
    "GET /rest/api/3/issueLinkType": ok(LINK_TYPES),
    "POST /rest/api/3/issueLink": created(),
  };

  test("a type name links the first issue as inwardIssue and the second as outwardIssue", async () => {
    serve(route);
    const result = await run("issue.link", { from: "ABC-1", type: "blocks", to: "ABC-2" });
    expect(writes()[0]?.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "ABC-1" },
      outwardIssue: { key: "ABC-2" },
    });
    expect(result).toEqual({
      type: "Blocks",
      issue: "ABC-1",
      relation: "blocks",
      linked: "ABC-2",
      next: [["atl", "issue", "links", "ABC-1"]],
    });
  });

  test("an outward phrase reads 'A <phrase> B'", async () => {
    serve(route);
    await run("issue.link", { from: "ABC-1", type: "Duplicates", to: "ABC-2" });
    expect(writes()[0]?.body).toEqual({
      type: { name: "Duplicate" },
      inwardIssue: { key: "ABC-1" },
      outwardIssue: { key: "ABC-2" },
    });
  });

  test("an inward phrase swaps the direction so 'A is blocked by B' means B blocks A", async () => {
    serve(route);
    const result = await run("issue.link", { from: "ABC-1", type: "Is Blocked By", to: "ABC-2" });
    expect(writes()[0]?.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "ABC-2" },
      outwardIssue: { key: "ABC-1" },
    });
    expect(result).toMatchObject({ issue: "ABC-1", relation: "is blocked by", linked: "ABC-2" });
  });

  test("a type id works and symmetric phrases do not swap", async () => {
    serve(route);
    await run("issue.link", { from: "ABC-1", type: "10002", to: "ABC-2" });
    expect(writes()[0]?.body).toMatchObject({
      type: { name: "Relates" },
      inwardIssue: { key: "ABC-1" },
      outwardIssue: { key: "ABC-2" },
    });
    sent = [];
    await run("issue.link", { from: "ABC-1", type: "relates to", to: "ABC-2" });
    expect(writes()[0]?.body).toMatchObject({
      inwardIssue: { key: "ABC-1" },
      outwardIssue: { key: "ABC-2" },
    });
  });

  test("URLs and ids are resolved to {key} or {id}, and --comment-file adds a comment", async () => {
    serve(route);
    const note = await file("why.md", "Same root cause");
    await run(
      "issue.link",
      { from: "https://acme.atlassian.net/browse/ABC-1", type: "Blocks", to: "10042" },
      { commentFile: note },
    );
    expect(writes()[0]?.body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "ABC-1" },
      outwardIssue: { id: "10042" },
      comment: { body: markdownToAdf("Same root cause") },
    });
  });

  test("an unknown type lists the available types and sends nothing", async () => {
    serve(route);
    const error = await failure(run("issue.link", { from: "ABC-1", type: "Causes", to: "ABC-2" }));
    expect(error.code).toBe("unknown_link_type");
    expect(error.category).toBe("input");
    expect(error.message).toContain("Blocks (blocks / is blocked by)");
    expect(error.next).toEqual([["atl", "issue", "link-types"]]);
    expect(writes()).toEqual([]);
  });

  test("--plan resolves the type but sends no write", async () => {
    serve(route);
    const plan = await run(
      "issue.link",
      { from: "ABC-1", type: "blocks", to: "ABC-2" },
      {},
      { ctx: { plan: true, argv: ["issue", "link", "ABC-1", "blocks", "ABC-2", "--plan"] } },
    );
    expect(sent.map((s) => s.method)).toEqual(["GET"]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: `${API}/rest/api/3/issueLink`,
      next: [["atl", "issue", "link", "ABC-1", "blocks", "ABC-2"]],
    });
  });
});

describe("inline and stdin bodies", () => {
  const COMMENT_ROUTE = "POST /rest/api/3/issue/ABC-123/comment";
  const COMMENT = { id: "10050", author: { accountId: "acc-1" }, body: markdownToAdf("hi") };

  afterEach(() => {
    bodyDeps.readStdin = undefined;
  });

  test("--body markdown is converted to ADF in the request", async () => {
    serve({ [COMMENT_ROUTE]: created(COMMENT) });
    await run("issue.comment", { issue: "ABC-123" }, { body: "Deployed to **staging**" });
    expect(writes()[0]?.body).toEqual({ body: markdownToAdf("Deployed to **staging**") });
  });

  test("--file - reads the body from stdin", async () => {
    serve({ [COMMENT_ROUTE]: created(COMMENT) });
    bodyDeps.readStdin = () => Promise.resolve("# From stdin");
    await run("issue.comment", { issue: "ABC-123" }, { file: "-" });
    expect(writes()[0]?.body).toEqual({ body: markdownToAdf("# From stdin") });
  });

  test("--body-format adf treats inline text as ADF JSON", async () => {
    serve({ [COMMENT_ROUTE]: created(COMMENT) });
    const adf = markdownToAdf("Raw ADF");
    await run(
      "issue.comment",
      { issue: "ABC-123" },
      { body: JSON.stringify(adf), bodyFormat: "adf" },
    );
    expect(writes()[0]?.body).toEqual({ body: adf });
  });

  test("invalid inline ADF is invalid_body", async () => {
    serve({});
    const error = await failure(
      run("issue.comment", { issue: "ABC-123" }, { body: "{nope", bodyFormat: "adf" }),
    );
    expect(error.code).toBe("invalid_body");
    expect(sent).toEqual([]);
  });

  test("--body and --file together are body_conflict", async () => {
    serve({});
    const note = await file("note.md", "x");
    const error = await failure(
      run("issue.comment", { issue: "ABC-123" }, { body: "x", file: note }),
    );
    expect(error.code).toBe("body_conflict");
    expect(error.category).toBe("input");
    expect(sent).toEqual([]);
  });

  test("a required body that is missing is body_required with both forms in the hint", async () => {
    serve({});
    const error = await failure(run("issue.comment", { issue: "ABC-123" }));
    expect(error.code).toBe("body_required");
    expect(error.category).toBe("input");
    expect(error.hint).toContain("--body");
    expect(error.hint).toContain("--file");
    expect(sent).toEqual([]);
  });

  test("storage is rejected for Jira via --body and via --file -", async () => {
    serve({});
    for (const flags of [
      { body: "<p>x</p>", bodyFormat: "storage" },
      { file: "-", bodyFormat: "storage" },
    ]) {
      bodyDeps.readStdin = () => Promise.resolve("<p>x</p>");
      const error = await failure(run("issue.comment", { issue: "ABC-123" }, flags));
      expect(error.code).toBe("unsupported_body_format");
    }
    expect(sent).toEqual([]);
  });

  test("--plan previews an inline body with sha256, bytes and preview", async () => {
    serve({});
    const plan = await run(
      "issue.comment",
      { issue: "ABC-123" },
      { body: "Deployed to staging" },
      {
        ctx: {
          plan: true,
          argv: ["issue", "comment", "ABC-123", "--body", "Deployed to staging", "--plan"],
        },
      },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "POST",
      url: `${API}/rest/api/3/issue/ABC-123/comment`,
      body: { sha256: expect.any(String), bytes: expect.any(Number), preview: expect.any(String) },
      next: [["atl", "issue", "comment", "ABC-123", "--body", "Deployed to staging"]],
    });
  });

  test("issue.create and issue.edit accept --body as the description", async () => {
    serve({
      [TYPES_ROUTE]: TYPES,
      "POST /rest/api/3/issue": created({ id: "1", key: "ABC-9" }),
      "PUT /rest/api/3/issue/ABC-123": noContent,
      "GET /rest/api/3/issue/ABC-123": ok({ id: "1", key: "ABC-123", fields: {} }),
    });
    await run("issue.create", {}, { project: "ABC", type: "Task", summary: "S", body: "Details" });
    await run("issue.edit", { issue: "ABC-123" }, { body: "New details" });
    expect(bodyField(0, "fields")).toMatchObject({ description: markdownToAdf("Details") });
    expect(bodyField(1, "fields")).toEqual({ description: markdownToAdf("New details") });
  });

  test("--comment on move, log and link is converted to ADF; --comment-file - reads stdin", async () => {
    serve({
      "GET /rest/api/3/issue/ABC-123/transitions": ok({
        transitions: [{ id: "21", name: "Resolve", to: { name: "Done" } }],
      }),
      "POST /rest/api/3/issue/ABC-123/transitions": noContent,
      "POST /rest/api/3/issue/ABC-123/comment": created({ id: "900" }),
      "POST /rest/api/3/issue/ABC-123/worklog": created({ id: "1", timeSpent: "1h" }),
      "GET /rest/api/3/issueLinkType": ok({
        issueLinkTypes: [{ id: "1", name: "Blocks", outward: "blocks", inward: "is blocked by" }],
      }),
      "POST /rest/api/3/issueLink": created(),
    });
    await run("issue.move", { issue: "ABC-123", transition: "Resolve" }, { comment: "Shipped" });
    await run("issue.log", { issue: "ABC-123" }, { comment: "Pairing" }, { rest: ["1h"] });
    bodyDeps.readStdin = () => Promise.resolve("Same root cause");
    await run("issue.link", { from: "ABC-123", type: "blocks", to: "ABC-2" }, { commentFile: "-" });
    const bodies = writes().map((w) => w.body);
    expect(bodies[0]).toEqual({ transition: { id: "21" } });
    expect(bodies[1]).toEqual({ body: markdownToAdf("Shipped") });
    expect(bodies[2]).toMatchObject({ timeSpent: "1h", comment: markdownToAdf("Pairing") });
    expect(bodies[3]).toMatchObject({ comment: { body: markdownToAdf("Same root cause") } });
  });

  test("--comment with --comment-file is body_conflict; --comment-file storage is rejected", async () => {
    serve({});
    const note = await file("why.md", "x");
    const conflict = await failure(
      run(
        "issue.link",
        { from: "ABC-1", type: "blocks", to: "ABC-2" },
        { comment: "x", commentFile: note },
      ),
    );
    expect(conflict.code).toBe("body_conflict");
    expect(conflict.message).toContain("--comment");
    const storage = await failure(
      run(
        "issue.log",
        { issue: "ABC-123" },
        { comment: "x", bodyFormat: "storage" },
        { rest: ["1h"] },
      ),
    );
    expect(storage.code).toBe("unsupported_body_format");
    expect(sent).toEqual([]);
  });
});

describe("parity", () => {
  test("write command names do not collide with read command names", () => {
    const reads = new Set(jiraCommands.map((c) => c.name));
    expect(jiraWriteCommands.filter((c) => reads.has(c.name))).toEqual([]);
  });
});

/** Run a command under `--plan` with the argv a user would have typed. */
function planCtx(...argv: string[]): Partial<CommandContext> {
  return { plan: true, argv: [...argv, "--plan"] };
}

describe("issue.delete", () => {
  test("without --yes it refuses and sends nothing", async () => {
    serve({ "DELETE /rest/api/3/issue/ABC-123": noContent });
    const error = await failure(run("issue.delete", { issue: "ABC-123" }));
    expect(error.code).toBe("confirmation_required");
    expect(sent).toEqual([]);
  });

  test("--yes deletes; --delete-subtasks is sent as the deleteSubtasks query", async () => {
    serve({ "DELETE /rest/api/3/issue/ABC-123": noContent });
    expect(await run("issue.delete", { issue: "ABC-123" }, { yes: true })).toEqual({
      deleted: "ABC-123",
    });
    expect(sent[0]?.query.has("deleteSubtasks")).toBe(false);

    sent = [];
    expect(
      await run("issue.delete", { issue: "ABC-123" }, { yes: true, deleteSubtasks: true }),
    ).toEqual({ deleted: "ABC-123", subtasks: "deleted" });
    expect(sent[0]?.method).toBe("DELETE");
    expect(sent[0]?.query.get("deleteSubtasks")).toBe("true");
  });

  test("--plan needs no --yes, sends nothing and its next carries --yes", async () => {
    serve({});
    const plan = await run(
      "issue.delete",
      { issue: "ABC-123" },
      { deleteSubtasks: true },
      { ctx: planCtx("issue", "delete", "ABC-123", "--delete-subtasks") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "DELETE",
      url: `${API}/rest/api/3/issue/ABC-123?deleteSubtasks=true`,
      next: [["atl", "issue", "delete", "ABC-123", "--delete-subtasks", "--yes"]],
    });
  });

  test("a parent with subtasks is rejected by the API and surfaces as an api error", async () => {
    serve({
      "DELETE /rest/api/3/issue/ABC-123": {
        status: 400,
        body: { errorMessages: ["has subtasks; specify deleteSubtasks"] },
      },
    });
    const error = await failure(run("issue.delete", { issue: "ABC-123" }, { yes: true }));
    expect(error.code).toBe("http_400");
    expect(error.message).toContain("deleteSubtasks");
  });
});

describe("issue.comment-delete", () => {
  test("without --yes it refuses; with --yes it deletes that comment", async () => {
    serve({ "DELETE /rest/api/3/issue/ABC-123/comment/10050": noContent });
    const refused = await failure(
      run("issue.comment-delete", { issue: "ABC-123", commentId: "10050" }),
    );
    expect(refused.code).toBe("confirmation_required");
    expect(sent).toEqual([]);

    expect(
      await run("issue.comment-delete", { issue: "ABC-123", commentId: "10050" }, { yes: true }),
    ).toEqual({ deleted: "10050", issue: "ABC-123" });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "DELETE /rest/api/3/issue/ABC-123/comment/10050",
    ]);
  });

  test("--plan sends nothing", async () => {
    serve({});
    const plan = await run(
      "issue.comment-delete",
      { issue: "ABC-123", commentId: "10050" },
      {},
      { ctx: planCtx("issue", "comment-delete", "ABC-123", "10050") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      next: [["atl", "issue", "comment-delete", "ABC-123", "10050", "--yes"]],
    });
  });
});

describe("issue.remote-link.add", () => {
  test("POSTs a web link object with optional globalId, relationship, summary and icon", async () => {
    serve({
      "POST /rest/api/3/issue/ABC-123/remotelink": created({ id: 10002, self: "https://x/10002" }),
    });
    const result = await run(
      "issue.remote-link.add",
      { issue: "ABC-123" },
      {
        url: "https://example.com/runbook",
        title: "Runbook",
        summary: "How to recover",
        relationship: "documented in",
        globalId: "runbook-1",
        iconUrl: "https://example.com/i.png",
      },
    );
    expect(writes()[0]?.body).toEqual({
      globalId: "runbook-1",
      relationship: "documented in",
      object: {
        url: "https://example.com/runbook",
        title: "Runbook",
        summary: "How to recover",
        icon: { url16x16: "https://example.com/i.png" },
      },
    });
    expect(result).toEqual({
      id: "10002",
      issue: "ABC-123",
      next: [["atl", "issue", "links", "ABC-123", "--remote"]],
    });
  });

  test("the minimal body carries only url and title; --full returns the raw response", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/remotelink": created({ id: 7, self: "https://x/7" }) });
    const result = await run(
      "issue.remote-link.add",
      { issue: "ABC-123" },
      { url: "https://example.com", title: "Example" },
      { ctx: { full: true } },
    );
    expect(writes()[0]?.body).toEqual({ object: { url: "https://example.com", title: "Example" } });
    expect(result).toEqual({ id: 7, self: "https://x/7" });
  });

  test("--plan sends nothing", async () => {
    serve({});
    const plan = await run(
      "issue.remote-link.add",
      { issue: "ABC-123" },
      { url: "https://example.com", title: "Example" },
      { ctx: planCtx("issue", "remote-link", "add", "ABC-123") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({ type: "plan", method: "POST" });
  });
});

describe("issue.remote-link.delete", () => {
  test("without --yes it refuses; with --yes it deletes that link id", async () => {
    serve({ "DELETE /rest/api/3/issue/ABC-123/remotelink/10014": noContent });
    const refused = await failure(
      run("issue.remote-link.delete", { issue: "ABC-123", linkId: "10014" }),
    );
    expect(refused.code).toBe("confirmation_required");
    expect(sent).toEqual([]);
    const result = await run(
      "issue.remote-link.delete",
      { issue: "ABC-123", linkId: "10014" },
      { yes: true },
    );
    expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      "DELETE /rest/api/3/issue/ABC-123/remotelink/10014",
    ]);
    expect(result).toMatchObject({ deleted: "10014", issue: "ABC-123" });
  });

  test("--global-id deletes by the globalId query; a link id and --global-id are exclusive", async () => {
    serve({ "DELETE /rest/api/3/issue/ABC-123/remotelink": noContent });
    await run(
      "issue.remote-link.delete",
      { issue: "ABC-123" },
      { globalId: "runbook-1", yes: true },
    );
    expect(writes()[0]?.query.get("globalId")).toBe("runbook-1");
    const neither = await failure(
      run("issue.remote-link.delete", { issue: "ABC-123" }, { yes: true }),
    );
    expect(neither.code).toBe("invalid_selection");
    const both = await failure(
      run(
        "issue.remote-link.delete",
        { issue: "ABC-123", linkId: "1" },
        { globalId: "g", yes: true },
      ),
    );
    expect(both.code).toBe("invalid_selection");
    expect(writes()).toHaveLength(1);
  });

  test("--plan sends nothing", async () => {
    serve({});
    const plan = await run(
      "issue.remote-link.delete",
      { issue: "ABC-123", linkId: "10014" },
      {},
      { ctx: planCtx("issue", "remote-link", "delete", "ABC-123", "10014") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({ type: "plan", method: "DELETE" });
  });
});

describe("property.set", () => {
  test("PUTs the parsed JSON value to the entity's property path", async () => {
    serve({
      "PUT /rest/api/3/issue/ABC-123/properties/team.meta": created(),
      "PUT /rest/api/3/comment/10050/properties/k": noContent,
    });
    const issue = await run(
      "property.set",
      { entity: "issue", id: "ABC-123", key: "team.meta" },
      { value: '{"owner":"web","n":[1,2]}' },
    );
    expect(writes()[0]?.body).toEqual({ owner: "web", n: [1, 2] });
    expect(issue).toEqual({
      entity: "issue",
      id: "ABC-123",
      key: "team.meta",
      next: [["atl", "property", "get", "issue", "ABC-123", "team.meta"]],
    });

    await run("property.set", { entity: "comment", id: "10050", key: "k" }, { value: "3" });
    expect(writes()[1]?.body).toBe(3);
    await run("property.set", { entity: "comment", id: "10050", key: "k" }, { value: '"text"' });
    expect(writes()[2]?.body).toBe("text");
  });

  test("--file supplies the value; worklog and dashboard-item need their extra flags", async () => {
    serve({
      "PUT /rest/api/3/issue/ABC-123/worklog/9001/properties/k": noContent,
      "PUT /rest/api/3/dashboard/10/items/20/properties/k": noContent,
    });
    const path = await file("v.json", '{"a":true}');
    await run(
      "property.set",
      { entity: "worklog", id: "9001", key: "k" },
      { file: path, issue: "ABC-123" },
    );
    expect(writes()[0]?.body).toEqual({ a: true });
    await run(
      "property.set",
      { entity: "dashboard-item", id: "10", key: "k" },
      { value: "null", item: "20" },
    );
    expect(writes()[1]?.body).toBeNull();

    const noIssue = await failure(
      run("property.set", { entity: "worklog", id: "9001", key: "k" }, { value: "1" }),
    );
    expect(noIssue.code).toBe("missing_issue");
    const noItem = await failure(
      run("property.set", { entity: "dashboard-item", id: "10", key: "k" }, { value: "1" }),
    );
    expect(noItem.code).toBe("missing_item");
  });

  test("path segments are encoded", async () => {
    serve({ "PUT /rest/api/3/issue/ABC-123/properties/a%2Fb%20c": noContent });
    await run("property.set", { entity: "issue", id: "ABC-123", key: "a/b c" }, { value: "1" });
    expect(writes()).toHaveLength(1);
  });

  test("invalid input is rejected before any request", async () => {
    serve({});
    const base = { entity: "issue", id: "ABC-123", key: "k" };
    expect((await failure(run("property.set", base, { value: "{oops" }))).code).toBe(
      "invalid_property_value",
    );
    expect((await failure(run("property.set", base, {}))).code).toBe("property_value_required");
    expect((await failure(run("property.set", base, { value: "1", file: "x.json" }))).code).toBe(
      "property_value_required",
    );
    expect(
      (await failure(run("property.set", { ...base, entity: "user" }, { value: "1" }))).code,
    ).toBe("invalid_property_entity");
    expect(
      (await failure(run("property.set", { ...base, entity: "project" }, { value: "1" }))).code,
    ).toBe("invalid_property_entity");
    expect(
      (await failure(run("property.set", base, { file: join(root, "missing.json") }))).code,
    ).toBe("input_file_unreadable");
    expect(sent).toEqual([]);
  });

  test("--plan describes the PUT and sends nothing", async () => {
    serve({});
    const plan = await run(
      "property.set",
      { entity: "issue", id: "ABC-123", key: "k" },
      { value: '{"a":1}' },
      { ctx: planCtx("property", "set", "issue", "ABC-123", "k", "--value", '{"a":1}') },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({
      type: "plan",
      method: "PUT",
      url: `${API}/rest/api/3/issue/ABC-123/properties/k`,
      body: { preview: '{"a":1}' },
    });
  });
});

describe("version.related-work.set", () => {
  test("without --id it creates (POST) with category, title and url", async () => {
    serve({
      "POST /rest/api/3/version/10000/relatedwork": ok({
        relatedWorkId: "rw-1",
        category: "Design docs",
        title: "Spec",
        url: "https://example.com/spec",
      }),
    });
    const result = await run(
      "version.related-work.set",
      { version: "10000" },
      { category: "Design docs", title: "Spec", url: "https://example.com/spec" },
    );
    expect(writes()[0]?.body).toEqual({
      category: "Design docs",
      title: "Spec",
      url: "https://example.com/spec",
    });
    expect(result).toEqual({
      id: "rw-1",
      category: "Design docs",
      title: "Spec",
      url: "https://example.com/spec",
      next: [["atl", "version", "related-work", "list", "10000"]],
    });
  });

  test("with --id it updates (PUT) that related work", async () => {
    serve({
      "PUT /rest/api/3/version/10000/relatedwork": ok({ relatedWorkId: "rw-1", category: "Other" }),
    });
    await run(
      "version.related-work.set",
      { version: "10000" },
      { id: "rw-1", category: "Other", title: "New" },
    );
    expect(writes()[0]?.method).toBe("PUT");
    expect(writes()[0]?.body).toEqual({ category: "Other", relatedWorkId: "rw-1", title: "New" });
  });

  test("an unknown version is an api error; --plan sends nothing", async () => {
    serve({});
    const error = await failure(
      run("version.related-work.set", { version: "99" }, { category: "Other" }),
    );
    expect(error.code).toBe("http_404");
    sent = [];
    const plan = await run(
      "version.related-work.set",
      { version: "99" },
      { category: "Other" },
      { ctx: planCtx("version", "related-work", "set", "99") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({ type: "plan", method: "POST" });
  });
});

describe("issue.watch / issue.unwatch", () => {
  test("watch with no --account sends no body (the caller watches)", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/watchers": noContent });
    expect(await run("issue.watch", { issue: "ABC-123" })).toEqual({
      issue: "ABC-123",
      watching: true,
    });
    expect(writes()[0]?.body).toBeUndefined();
  });

  test("watch --account sends the account id as a bare JSON string", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/watchers": noContent });
    expect(await run("issue.watch", { issue: "ABC-123" }, { account: "acc-1" })).toEqual({
      issue: "ABC-123",
      watching: true,
      account: "acc-1",
    });
    expect(writes()[0]?.body).toBe("acc-1");
  });

  test("unwatch --account DELETEs with the accountId query", async () => {
    serve({ "DELETE /rest/api/3/issue/ABC-123/watchers": noContent });
    expect(await run("issue.unwatch", { issue: "ABC-123" }, { account: "acc-1" })).toEqual({
      issue: "ABC-123",
      watching: false,
    });
    expect(sent[0]?.query.get("accountId")).toBe("acc-1");
  });

  test("unwatch without --account resolves the caller from /me (Jira's /myself needs another scope)", async () => {
    const urls: string[] = [];
    jiraDeps.fetch = (input, init) => {
      urls.push(`${init?.method ?? "GET"} ${input}`);
      return Promise.resolve(
        input === "https://api.atlassian.com/me"
          ? new Response(JSON.stringify({ account_id: "me-1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(null, { status: 204 }),
      );
    };
    await run("issue.unwatch", { issue: "ABC-123" });
    expect(urls).toEqual([
      "GET https://api.atlassian.com/me",
      `DELETE ${API}/rest/api/3/issue/ABC-123/watchers?accountId=me-1`,
    ]);
  });

  test("--plan sends no write", async () => {
    serve({});
    const plan = await run(
      "issue.watch",
      { issue: "ABC-123" },
      {},
      { ctx: planCtx("issue", "watch", "ABC-123") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({ type: "plan", method: "POST" });
  });
});

describe("issue.notify", () => {
  test("maps --to tokens onto the notify recipients object", async () => {
    serve({ "POST /rest/api/3/issue/ABC-123/notify": noContent });
    const to = ["reporter", "watchers", "user:acc-1", "user:acc-2", "group:devs"];
    const result = await run(
      "issue.notify",
      { issue: "ABC-123" },
      { subject: "Deployed", body: "Shipped", htmlBody: "<b>Shipped</b>", to },
    );
    expect(writes()[0]?.body).toEqual({
      subject: "Deployed",
      textBody: "Shipped",
      htmlBody: "<b>Shipped</b>",
      to: {
        reporter: true,
        watchers: true,
        users: [{ accountId: "acc-1" }, { accountId: "acc-2" }],
        groups: [{ name: "devs" }],
      },
    });
    expect(result).toEqual({ notified: "ABC-123", to });
  });

  test("an unknown recipient or no recipient fails before any request", async () => {
    serve({});
    const bad = await failure(
      run("issue.notify", { issue: "ABC-123" }, { subject: "s", body: "b", to: ["everyone"] }),
    );
    expect(bad.code).toBe("invalid_recipient");
    const none = await failure(
      run("issue.notify", { issue: "ABC-123" }, { subject: "s", body: "b", to: [] }),
    );
    expect(none.code).toBe("recipients_required");
    expect(sent).toEqual([]);
  });

  test("--plan sends nothing; an API rejection surfaces", async () => {
    serve({});
    const plan = await run(
      "issue.notify",
      { issue: "ABC-123" },
      { subject: "s", body: "b", to: ["assignee"] },
      { ctx: planCtx("issue", "notify", "ABC-123") },
    );
    expect(sent).toEqual([]);
    expect(plan).toMatchObject({ type: "plan", method: "POST" });

    serve({
      "POST /rest/api/3/issue/ABC-123/notify": {
        status: 400,
        body: { errorMessages: ["No recipients"] },
      },
    });
    const error = await failure(
      run("issue.notify", { issue: "ABC-123" }, { subject: "s", body: "b", to: ["assignee"] }),
    );
    expect(error.code).toBe("http_400");
  });
});
