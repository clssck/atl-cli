import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraCommands, jiraDeps } from "../../src/commands/jira.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { makeContext } from "../helpers/context.ts";
import { AtlError } from "../../src/core/errors.ts";
import { prune } from "../../src/core/output.ts";
import { isRecord } from "../../src/core/guards.ts";
import { saveConfig } from "../../src/core/config.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const API = `https://api.atlassian.com/ex/jira/${CLOUD}`;

interface Call {
  path: string;
  query: URLSearchParams;
}

let root: string;
let ctx: CommandContext;
let calls: Call[];

/** Responses served in order, one per request to the same route. */
class Sequence {
  readonly pages: readonly unknown[];
  constructor(pages: readonly unknown[]) {
    this.pages = pages;
  }
}

function sequence(...pages: unknown[]): Sequence {
  return new Sequence(pages);
}

function respond(routes: Record<string, unknown>): void {
  const served = new Map<string, number>();
  const prefix = `/ex/jira/${CLOUD}`;
  jiraDeps.fetch = (input) => {
    const url = new URL(input);
    const path = url.pathname.slice(prefix.length);
    calls.push({ path, query: url.searchParams });
    const route = routes[path];
    if (route === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ errorMessages: ["no route"] }), { status: 404 }),
      );
    }
    let payload: unknown = route;
    if (route instanceof Sequence) {
      const n = served.get(path) ?? 0;
      served.set(path, n + 1);
      payload = route.pages[n];
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function command(name: string): CommandSpec {
  const spec = jiraCommands.find((c) => c.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

/** Narrow a command result to a plain object. */
function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected an object result");
  }
  return value;
}

/** The `items` of a paged command result, each narrowed to a plain object. */
function itemsOf(value: unknown): Record<string, unknown>[] {
  const items = recordOf(value).items;
  if (!Array.isArray(items)) {
    throw new Error("expected a result with an items array");
  }
  return items.map((item: unknown) => recordOf(item));
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

async function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  overrides: Partial<CommandContext> = {},
): Promise<unknown> {
  const context = { ...ctx, ...overrides };
  const result = await command(name).run(context, { args, rest: [], flags });
  return context.full ? result : prune(result);
}

const doc = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const ISSUE = {
  id: "10042",
  key: "ABC-123",
  fields: {
    summary: "Login fails on Safari",
    status: {
      id: "3",
      name: "In Progress",
      statusCategory: { key: "indeterminate", name: "In Progress" },
    },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: { accountId: "acc-1", displayName: "Ada Lovelace", avatarUrls: { "48x48": "x" } },
    reporter: { accountId: "acc-2", displayName: "Grace Hopper" },
    labels: ["web", "auth"],
    parent: { id: "10001", key: "ABC-100", fields: { summary: "Auth epic" } },
    project: { key: "ABC", name: "Alpha" },
    created: "2026-10-01T09:00:00.000+0000",
    updated: "2026-10-02T09:00:00.000+0000",
    description: doc("Steps to reproduce"),
  },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-jira-test-"));
  const env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
  await saveConfig(
    {
      sites: {
        "acme.atlassian.net": {
          cloudId: CLOUD,
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["read:jira-work"],
          cachedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
    env,
  );
  ctx = makeContext(env);
  calls = [];
});

afterEach(async () => {
  jiraDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("issue.get", () => {
  test("requests the default field set and compacts the issue", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    const result = await run("issue.get", { issue: "ABC-123" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("fields")).toBe(
      "summary,status,issuetype,priority,assignee,reporter,labels,parent,created,updated,description,project",
    );
    expect(result).toEqual({
      key: "ABC-123",
      id: "10042",
      summary: "Login fails on Safari",
      status: "In Progress",
      statusCategory: "indeterminate",
      type: "Bug",
      priority: "High",
      assignee: { accountId: "acc-1", name: "Ada Lovelace" },
      reporter: { accountId: "acc-2", name: "Grace Hopper" },
      labels: ["web", "auth"],
      parent: { key: "ABC-100", summary: "Auth epic" },
      project: { key: "ABC", name: "Alpha" },
      created: "2026-10-01T09:00:00+0000",
      updated: "2026-10-02T09:00:00+0000",
      description: ["Steps to reproduce"],
      url: "https://acme.atlassian.net/browse/ABC-123",
    });
  });

  test("--format adf returns the ADF document; null assignee, parent, and priority are omitted", async () => {
    respond({
      "/rest/api/3/issue/10042": {
        ...ISSUE,
        fields: { ...ISSUE.fields, assignee: null, parent: null, priority: null },
      },
    });
    const result = recordOf(await run("issue.get", { issue: "10042" }, { format: "adf" }));
    expect("assignee" in result).toBe(false);
    expect("parent" in result).toBe(false);
    expect("priority" in result).toBe(false);
    expect(result.description).toEqual(doc("Steps to reproduce"));
  });

  test("--issue-fields overrides the field selector and drops description when not requested", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    const result = recordOf(
      await run("issue.get", { issue: "ABC-123" }, { issueFields: "summary, status" }),
    );
    expect(calls[0]?.query.get("fields")).toBe("summary,status");
    expect("description" in result).toBe(false);
  });

  test("--comments N fetches the N newest comments", async () => {
    respond({
      "/rest/api/3/issue/ABC-123": ISSUE,
      "/rest/api/3/issue/ABC-123/comment": {
        startAt: 0,
        maxResults: 2,
        total: 5,
        comments: [
          {
            id: "900",
            author: { accountId: "acc-2", displayName: "G" },
            created: "c2",
            updated: "u2",
            body: doc("Second"),
          },
          {
            id: "899",
            author: { accountId: "acc-1", displayName: "A" },
            created: "c1",
            updated: "u1",
            body: doc("First"),
          },
        ],
      },
    });
    const result = recordOf(await run("issue.get", { issue: "ABC-123" }, { comments: 2 }));
    expect(calls[1]?.path).toBe("/rest/api/3/issue/ABC-123/comment");
    expect(calls[1]?.query.get("orderBy")).toBe("-created");
    expect(calls[1]?.query.get("maxResults")).toBe("2");
    expect(result.comments).toEqual([
      { id: "900", author: "G", created: "c2", updated: "u2", body: ["Second"] },
      { id: "899", author: "A", created: "c1", updated: "u1", body: ["First"] },
    ]);
  });

  test("no comment request without --comments", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    const result = recordOf(await run("issue.get", { issue: "ABC-123" }));
    expect(calls).toHaveLength(1);
    expect("comments" in result).toBe(false);
  });

  test("a browse URL selects its site and key", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    await run("issue.get", { issue: "https://acme.atlassian.net/browse/ABC-123" });
    expect(calls[0]?.path).toBe("/rest/api/3/issue/ABC-123");
  });

  test("--full returns the raw issue", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    const result = await run("issue.get", { issue: "ABC-123" }, {}, { full: true });
    expect(result).toEqual(ISSUE);
  });
});

describe("issue.transitions", () => {
  test("maps transitions", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/transitions": {
        transitions: [
          {
            id: "31",
            name: "Done",
            hasScreen: false,
            isAvailable: true,
            to: { id: "10002", name: "Done", statusCategory: { key: "done", name: "Done" } },
          },
        ],
      },
    });
    expect(await run("issue.transitions", { issue: "ABC-123" })).toEqual({
      items: [{ id: "31", name: "Done", to: "Done" }],
    });
  });

  test("keeps hasScreen when true and isAvailable when false", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/transitions": {
        transitions: [
          { id: "41", name: "Review", hasScreen: true, isAvailable: false, to: { name: "Review" } },
        ],
      },
    });
    expect(await run("issue.transitions", { issue: "ABC-123" })).toEqual({
      items: [{ id: "41", name: "Review", to: "Review", hasScreen: true, isAvailable: false }],
    });
  });
});

describe("issue.links", () => {
  test("maps inward and outward links", async () => {
    respond({
      "/rest/api/3/issue/ABC-123": {
        id: "10042",
        key: "ABC-123",
        fields: {
          issuelinks: [
            {
              id: "500",
              type: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
              outwardIssue: {
                id: "10050",
                key: "ABC-200",
                fields: { summary: "Deploy", status: { name: "To Do" } },
              },
            },
            {
              id: "501",
              type: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
              inwardIssue: {
                id: "10051",
                key: "XYZ-7",
                fields: { summary: "Upstream", status: { name: "Done" } },
              },
            },
          ],
        },
      },
    });
    const result = await run("issue.links", { issue: "ABC-123" });
    expect(calls[0]?.query.get("fields")).toBe("issuelinks");
    expect(result).toEqual({
      items: [
        {
          id: "500",
          type: "Blocks",
          relation: "blocks",
          key: "ABC-200",
          summary: "Deploy",
          status: "To Do",
        },
        {
          id: "501",
          type: "Blocks",
          relation: "is blocked by",
          key: "XYZ-7",
          summary: "Upstream",
          status: "Done",
        },
      ],
    });
  });

  test("--remote lists remote links", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/remotelink": [
        {
          id: 10000,
          globalId: "system=https://example.com&id=1",
          relationship: "mentioned in",
          application: { type: "com.acme", name: "Acme Wiki" },
          object: { url: "https://example.com/1", title: "Runbook" },
        },
      ],
    });
    expect(await run("issue.links", { issue: "ABC-123" }, { remote: true })).toEqual({
      items: [
        {
          id: "10000",
          globalId: "system=https://example.com&id=1",
          title: "Runbook",
          url: "https://example.com/1",
          relationship: "mentioned in",
          application: "Acme Wiki",
        },
      ],
    });
  });
});

describe("issue.link-types", () => {
  test("maps link types", async () => {
    respond({
      "/rest/api/3/issueLinkType": {
        issueLinkTypes: [
          { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks", self: "x" },
        ],
      },
    });
    expect(await run("issue.link-types", {})).toEqual({
      items: [{ id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" }],
    });
  });
});

describe("issue.comments", () => {
  test("paginates by startAt and renders markdown bodies", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/comment": sequence(
        {
          startAt: 0,
          maxResults: 1,
          total: 2,
          comments: [
            { id: "1", author: { accountId: "a" }, created: "c", updated: "u", body: doc("one") },
          ],
        },
        {
          startAt: 1,
          maxResults: 1,
          total: 2,
          comments: [
            { id: "2", author: { accountId: "b" }, created: "c", updated: "u", body: doc("two") },
          ],
        },
      ),
    });
    const result = recordOf(await run("issue.comments", { issue: "ABC-123" }, { all: true }));
    expect(itemsOf(result).map((c) => [c.id, c.body])).toEqual([
      ["1", ["one"]],
      ["2", ["two"]],
    ]);
    expect(result.nextCursor).toBeUndefined();
    expect(calls.map((c) => c.query.get("startAt"))).toEqual(["0", "1"]);
    expect(calls[0]?.query.get("maxResults")).toBe("100");
  });
});

describe("jql", () => {
  const page1 = {
    issues: [{ id: "1", key: "ABC-1", fields: { summary: "One", description: doc("Body one") } }],
    nextPageToken: "tok-2",
  };
  const page2 = {
    issues: [{ id: "2", key: "ABC-2", fields: { summary: "Two", description: doc("Body two") } }],
    isLast: true,
  };

  test("follows nextPageToken, sends jql and fields, omits description by default", async () => {
    respond({ "/rest/api/3/search/jql": sequence(page1, page2) });
    const result = recordOf(
      await run("jql", { query: 'project = "ABC" ORDER BY created' }, { all: true }),
    );
    const items = itemsOf(result);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query.get("jql")).toBe('project = "ABC" ORDER BY created');
    expect(calls[0]?.query.get("fields")).toBe(
      "summary,status,issuetype,priority,assignee,updated",
    );
    expect(calls[0]?.query.get("maxResults")).toBe("100");
    expect(calls[0]?.query.has("nextPageToken")).toBe(false);
    expect(calls[1]?.query.get("nextPageToken")).toBe("tok-2");
    expect(items.map((i) => i.key)).toEqual(["ABC-1", "ABC-2"]);
    expect(items.every((i) => !("description" in i))).toBe(true);
    expect("url" in (items[0] ?? {})).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  test("--limit stops early and returns the resume token", async () => {
    respond({ "/rest/api/3/search/jql": sequence(page1) });
    const result = recordOf(await run("jql", { query: "x = 1" }, { limit: 1 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("maxResults")).toBe("1");
    expect(result.nextCursor).toBe("tok-2");
  });

  test("list items are minimal: names for people, no id/url/statusCategory/null fields", async () => {
    respond({
      "/rest/api/3/search/jql": {
        issues: [{ ...ISSUE, fields: { ...ISSUE.fields, assignee: null } }, ISSUE],
        isLast: true,
      },
    });
    const items = itemsOf(await run("jql", { query: "x = 1" }));
    expect(items[0]).toEqual({
      key: "ABC-123",
      summary: "Login fails on Safari",
      status: "In Progress",
      type: "Bug",
      priority: "High",
      reporter: "Grace Hopper",
      labels: ["web", "auth"],
      parent: "ABC-100",
      project: "ABC",
      created: "2026-10-01T09:00:00+0000",
      updated: "2026-10-02T09:00:00+0000",
    });
    expect(items[1]?.assignee).toBe("Ada Lovelace");
  });

  test("--cursor resumes and --issue-fields description includes it", async () => {
    respond({ "/rest/api/3/search/jql": sequence(page2) });
    const items = itemsOf(
      await run("jql", { query: "x = 1" }, { cursor: "tok-2", issueFields: "summary,description" }),
    );
    expect(calls[0]?.query.get("nextPageToken")).toBe("tok-2");
    expect(calls[0]?.query.get("fields")).toBe("summary,description");
    expect(calls[0]?.query.get("maxResults")).toBe("25");
    expect(items[0]?.description).toEqual(["Body two"]);
  });
});

describe("project.list", () => {
  test("maps projects and passes query/offset params", async () => {
    respond({
      "/rest/api/3/project/search": {
        startAt: 0,
        maxResults: 50,
        total: 1,
        isLast: true,
        values: [
          {
            id: "10000",
            key: "ABC",
            name: "Alpha",
            projectTypeKey: "software",
            style: "next-gen",
            avatarUrls: { "48x48": "x" },
          },
        ],
      },
    });
    const result = await run("project.list", {}, { query: "alp" });
    expect(calls[0]?.query.get("query")).toBe("alp");
    expect(calls[0]?.query.get("startAt")).toBe("0");
    expect(calls[0]?.query.get("maxResults")).toBe("50");
    expect(result).toEqual({
      items: [{ key: "ABC", name: "Alpha", type: "software", style: "next-gen" }],
    });
  });
});

describe("project.types / project.fields", () => {
  const types = [
    { id: "10001", name: "Task", subtask: false, description: "A task" },
    { id: "10004", name: "Bug", subtask: false, description: "A bug" },
  ];

  test("project.types handles the issueTypes key", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes": { startAt: 0, total: 2, issueTypes: types },
    });
    expect(await run("project.types", { project: "ABC" })).toEqual({
      items: [
        { id: "10001", name: "Task", description: "A task" },
        { id: "10004", name: "Bug", description: "A bug" },
      ],
    });
  });

  test("project.types handles the createMetaIssueType key", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes": {
        startAt: 0,
        total: 2,
        createMetaIssueType: types,
      },
    });
    const result = itemsOf(await run("project.types", { project: "ABC" }));
    expect(result.map((t) => t.id)).toEqual(["10001", "10004"]);
  });

  const fieldsPage = {
    startAt: 0,
    total: 3,
    fields: [
      {
        fieldId: "summary",
        key: "summary",
        name: "Summary",
        required: true,
        hasDefaultValue: false,
        schema: { type: "string", system: "summary" },
        operations: ["set"],
      },
      {
        fieldId: "priority",
        key: "priority",
        name: "Priority",
        required: false,
        hasDefaultValue: true,
        schema: { type: "priority", system: "priority" },
        allowedValues: Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `P${i}` })),
      },
      {
        fieldId: "customfield_10020",
        key: "customfield_10020",
        name: "Sprint",
        required: false,
        hasDefaultValue: false,
        schema: { type: "array", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
        allowedValues: [{ id: "1", value: "Sprint 1" }],
      },
    ],
  };

  test("project.fields resolves a type name case-insensitively and maps fields", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes": { startAt: 0, total: 2, issueTypes: types },
      "/rest/api/3/issue/createmeta/ABC/issuetypes/10004": fieldsPage,
    });
    const items = itemsOf(await run("project.fields", { project: "ABC", type: "bUg" }));
    expect(calls.map((c) => c.path)).toEqual([
      "/rest/api/3/issue/createmeta/ABC/issuetypes",
      "/rest/api/3/issue/createmeta/ABC/issuetypes/10004",
    ]);
    expect(items[0]).toEqual({
      fieldId: "summary",
      name: "Summary",
      required: true,
      type: "string",
    });
    const priority = items[1];
    expect(priority?.allowedValues).toEqual(Array.from({ length: 20 }, (_, i) => `P${i}`));
    expect(priority?.hasDefaultValue).toBe(true);
    expect("required" in (priority ?? {})).toBe(false);
    expect(items[2]).toEqual({
      fieldId: "customfield_10020",
      name: "Sprint",
      type: "array",
      allowedValues: ["Sprint 1"],
    });
  });

  test("project.fields accepts a numeric type id without resolving and reads the results key", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes/10004": {
        startAt: 0,
        total: 1,
        results: fieldsPage.fields.slice(0, 1),
      },
    });
    const items = itemsOf(await run("project.fields", { project: "ABC", type: "10004" }));
    expect(calls).toHaveLength(1);
    expect(items.map((f) => f.fieldId)).toEqual(["summary"]);
  });

  test("project.fields rejects an unknown type name and lists the available ones", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes": { startAt: 0, total: 2, issueTypes: types },
    });
    const atl = await failure(run("project.fields", { project: "ABC", type: "Epic" }));
    expect(atl.category).toBe("input");
    expect(atl.code).toBe("unknown_issue_type");
    expect(atl.message).toContain("Task, Bug");
    expect(atl.next).toEqual([["atl", "project", "types", "ABC"]]);
  });
});

describe("MCP read parity flags", () => {
  test("issue.get maps fields, expand, properties and boolean flags to query params", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    await run(
      "issue.get",
      { issue: "ABC-123" },
      {
        issueFields: "summary,customfield_10010",
        fieldsByKeys: true,
        expand: "renderedFields,names",
        properties: "prop.a,prop.b",
        updateHistory: true,
        failFast: true,
      },
    );
    const q = calls[0]?.query;
    expect(q?.get("fields")).toBe("summary,customfield_10010");
    expect(q?.get("fieldsByKeys")).toBe("true");
    expect(q?.get("expand")).toBe("renderedFields,names");
    expect(q?.get("properties")).toBe("prop.a,prop.b");
    expect(q?.get("updateHistory")).toBe("true");
    expect(q?.get("failFast")).toBe("true");
  });

  test("issue.get omits unset optional query params", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    await run("issue.get", { issue: "ABC-123" });
    expect([...(calls[0]?.query.keys() ?? [])]).toEqual(["fields"]);
  });

  test("issue.get carries non-compact fields and expansions through, and *all includes description", async () => {
    respond({
      "/rest/api/3/issue/ABC-123": {
        ...ISSUE,
        renderedFields: { description: "<p>Steps</p>" },
        names: { summary: "Summary" },
        fields: {
          ...ISSUE.fields,
          components: [{ name: "Backend" }],
          customfield_10010: "x",
        },
      },
    });
    const result = recordOf(await run("issue.get", { issue: "ABC-123" }, { issueFields: "*all" }));
    expect(result.description).toEqual(["Steps to reproduce"]);
    expect(result.fields).toEqual({
      components: [{ name: "Backend" }],
      customfield_10010: "x",
    });
    expect(result.renderedFields).toEqual({ description: "<p>Steps</p>" });
    expect(result.names).toEqual({ summary: "Summary" });
    expect("self" in result).toBe(false);
  });

  test("issue.transitions maps every MCP flag to its query param", async () => {
    respond({ "/rest/api/3/issue/ABC-123/transitions": { transitions: [] } });
    await run(
      "issue.transitions",
      { issue: "ABC-123" },
      {
        expand: "transitions.fields",
        transitionId: "31",
        skipRemoteOnlyCondition: true,
        includeUnavailableTransitions: true,
        sortByOpsBarAndStatus: true,
      },
    );
    const q = calls[0]?.query;
    expect(q?.get("expand")).toBe("transitions.fields");
    expect(q?.get("transitionId")).toBe("31");
    expect(q?.get("skipRemoteOnlyCondition")).toBe("true");
    expect(q?.get("includeUnavailableTransitions")).toBe("true");
    expect(q?.get("sortByOpsBarAndStatus")).toBe("true");
  });

  test("issue.transitions keeps expanded transition fields", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/transitions": {
        transitions: [
          {
            id: "31",
            name: "Done",
            to: { name: "Done" },
            fields: { resolution: { required: true } },
          },
        ],
      },
    });
    const items = itemsOf(
      await run("issue.transitions", { issue: "ABC-123" }, { expand: "transitions.fields" }),
    );
    expect(items[0]?.fields).toEqual({ resolution: { required: true } });
  });

  test("issue.links --global-id implies --remote, sends globalId and accepts a single object", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/remotelink": {
        id: 10000,
        globalId: "system=x&id=1",
        object: { url: "https://example.com/1", title: "Runbook" },
      },
    });
    const items = itemsOf(
      await run("issue.links", { issue: "ABC-123" }, { globalId: "system=x&id=1" }),
    );
    expect(calls[0]?.path).toBe("/rest/api/3/issue/ABC-123/remotelink");
    expect(calls[0]?.query.get("globalId")).toBe("system=x&id=1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "10000", title: "Runbook" });
  });

  test("project.list maps --action and --expand-issue-types and returns issue types", async () => {
    respond({
      "/rest/api/3/project/search": {
        isLast: true,
        values: [
          {
            id: "10000",
            key: "ABC",
            name: "Alpha",
            issueTypes: [
              { id: "10004", name: "Bug", subtask: false, description: "x" },
              { id: "10005", name: "Sub", subtask: true },
            ],
          },
        ],
      },
    });
    const items = itemsOf(
      await run("project.list", {}, { action: "create", expandIssueTypes: true }),
    );
    expect(calls[0]?.query.get("action")).toBe("create");
    expect(calls[0]?.query.get("expand")).toBe("issueTypes");
    expect(items[0]?.issueTypes).toEqual([
      { id: "10004", name: "Bug" },
      { id: "10005", name: "Sub", subtask: true },
    ]);
  });

  test("project.fields --required-only keeps only required fields", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes/10004": {
        startAt: 0,
        total: 2,
        fields: [
          { fieldId: "summary", name: "Summary", required: true },
          { fieldId: "labels", name: "Labels", required: false },
        ],
      },
    });
    const items = itemsOf(
      await run("project.fields", { project: "ABC", type: "10004" }, { requiredOnly: true }),
    );
    expect(items.map((f) => f.fieldId)).toEqual(["summary"]);
  });

  test("jql --result-mode count POSTs approximate-count and skips the search", async () => {
    const seen: { method?: string | undefined; path: string; body: unknown }[] = [];
    jiraDeps.fetch = (input, init) => {
      seen.push({
        method: init?.method,
        path: new URL(input).pathname.slice(`/ex/jira/${CLOUD}`.length),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ count: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    expect(await run("jql", { query: "project = ABC" }, { resultMode: "count" })).toEqual({
      count: 42,
    });
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/rest/api/3/search/approximate-count",
        body: { jql: "project = ABC" },
      },
    ]);
  });

  test("jql --result-mode all returns the count and the issues", async () => {
    respond({
      "/rest/api/3/search/approximate-count": { count: 7 },
      "/rest/api/3/search/jql": {
        issues: [{ id: "1", key: "ABC-1", fields: { summary: "One" } }],
        isLast: true,
      },
    });
    const result = recordOf(await run("jql", { query: "x = 1" }, { resultMode: "all" }));
    expect(result.count).toBe(7);
    expect(itemsOf(result).map((i) => i.key)).toEqual(["ABC-1"]);
  });

  test("every read command declares the MCP tool it replaces", () => {
    const mapped = Object.fromEntries(jiraCommands.map((c) => [c.name, c.mcpTools]));
    expect(mapped).toMatchObject({
      "issue.get": ["getJiraIssue"],
      "issue.transitions": ["getTransitionsForJiraIssue"],
      "issue.links": ["getJiraIssueRemoteIssueLinks"],
      "issue.link-types": ["getIssueLinkTypes"],
      jql: ["searchJiraIssuesUsingJql"],
      "project.list": ["getVisibleJiraProjects"],
      "project.types": ["getJiraProjectIssueTypesMetadata"],
      "project.fields": ["getJiraIssueTypeMetaWithFields"],
    });
  });
});

describe("api base", () => {
  test("requests go through api.atlassian.com/ex/jira/<cloudId>", async () => {
    let seen = "";
    jiraDeps.fetch = (input) => {
      seen = input;
      return Promise.resolve(new Response(JSON.stringify({ issueLinkTypes: [] }), { status: 200 }));
    };
    await run("issue.link-types", {});
    expect(seen).toBe(`${API}/rest/api/3/issueLinkType`);
  });
});
