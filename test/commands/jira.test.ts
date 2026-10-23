import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraCommands, jiraDeps } from "../../src/commands/jira.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { makeContext } from "../helpers/context.ts";
import { withDiagnostics } from "../helpers/stderr.ts";
import { AtlError } from "../../src/core/errors.ts";
import { prune } from "../../src/core/output.ts";
import { isRecord } from "../../src/core/guards.ts";
import { saveConfig } from "../../src/core/config.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const API = `https://api.atlassian.com/ex/jira/${CLOUD}`;

interface Call {
  path: string;
  query: URLSearchParams;
  method?: string | undefined;
  body?: unknown;
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
  jiraDeps.fetch = (input, init) => {
    const url = new URL(input);
    const path = url.pathname.slice(prefix.length);
    calls.push({
      path,
      query: url.searchParams,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
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

/** Keys of a `--chain` result, in order. */
function itemsOfChain(value: Record<string, unknown>): unknown[] {
  const chain = value.chain;
  if (!Array.isArray(chain)) {
    throw new Error("expected a chain array");
  }
  return chain.map((step: unknown) => recordOf(step).key);
}

/** One 100-issue `jql` page for the 1000-issue cap test. */
function groupPage(n: number) {
  return {
    issues: Array.from({ length: 100 }, (_, i) =>
      groupIssue(`A-${n * 100 + i}`, { status: { name: "Open" } }),
    ),
    nextPageToken: `t${n + 1}`,
  };
}

const BLOCKS = { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" };

function chainLink(id: string, key: string, outward: boolean) {
  const other = { id, key, fields: { summary: `Sum ${key}`, status: { name: "To Do" } } };
  return outward
    ? { id, type: BLOCKS, outwardIssue: other }
    : { id, type: BLOCKS, inwardIssue: other };
}

function chainNode(key: string, links: unknown[]) {
  return {
    id: key,
    key,
    fields: { summary: `Sum ${key}`, status: { name: "To Do" }, issuelinks: links },
  };
}

function groupIssue(key: string, fields: Record<string, unknown>) {
  return { id: key, key, fields };
}

async function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  overrides: Partial<CommandContext> = {},
  rest: string[] = [],
): Promise<unknown> {
  const context = { ...ctx, ...overrides };
  const spec = command(name);
  // The parser delivers a variadic positional in `rest`; tests name it like any other argument.
  const variadic = spec.args.find((arg) => arg.variadic === true)?.name;
  const values = variadic === undefined ? undefined : args[variadic];
  const result = await spec.run(context, {
    args,
    rest: values === undefined ? rest : [values],
    flags,
  });
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

/** ISSUE with extra fields, as a scrum project returns it. */
function scrum(fields: Record<string, unknown>): typeof ISSUE {
  return { ...ISSUE, fields: { ...ISSUE.fields, ...fields } };
}

function statusCalls(): Call[] {
  return calls.filter((c) => c.path === "/rest/api/3/status");
}

/** Field catalogue as /field returns it on a Hungarian site: ids differ per site, clause names are English. */
const FIELDS = [
  { id: "labels", name: "Címkék", custom: false, clauseNames: ["labels"] },
  {
    id: "duedate",
    name: "Határidő",
    untranslatedName: null,
    custom: false,
    clauseNames: ["due", "duedate"],
  },
  {
    id: "customfield_10015",
    name: "Kezdő dátum",
    untranslatedName: "Start date",
    custom: true,
    clauseNames: ["cf[10015]", "Start date", "Start date[Date]"],
  },
  {
    id: "customfield_10021",
    name: "Flagged",
    untranslatedName: "Flagged",
    custom: true,
    clauseNames: ["Flagged", "Flagged[Checkboxes]", "cf[10021]"],
  },
];

/** Group by a field name against the FIELDS catalogue; returns the requested API field and the groups. */
async function groupedFields(groupBy: string, issues: unknown[]) {
  respond({
    "/rest/api/3/field": FIELDS,
    "/rest/api/3/search/jql": { issues, isLast: true },
  });
  const result = recordOf(await run("jql", { query: "x = 1" }, { groupBy }));
  return [calls.at(-1)?.query.get("fields"), result.groups];
}

function siteEntry(cloudId: string, host: string) {
  return {
    cloudId,
    name: host,
    url: `https://${host}`,
    scopes: ["read:jira-work"],
    cachedAt: "2026-10-01T00:00:00.000Z",
  };
}

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
    respond({ "/rest/api/3/issue/ABC-123": ISSUE, "/rest/api/3/field": FIELDS });
    const result = await run("issue.get", { issue: "ABC-123" });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.query.get("fields")).toBe(
      "summary,status,issuetype,priority,assignee,reporter,labels,parent,created,updated,description,project,duedate,components,fixVersions,customfield_10015,customfield_10021",
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
      "/rest/api/3/field": FIELDS,
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

  describe("scrum fields", () => {
    const SCRUM_FIELDS = [
      ...FIELDS,
      {
        id: "customfield_10020",
        name: "Sprint",
        custom: true,
        clauseNames: ["cf[10020]", "Sprint"],
        schema: { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
      },
      {
        id: "customfield_10016",
        name: "Story point estimate",
        custom: true,
        clauseNames: ["cf[10016]", "Story point estimate"],
        schema: {
          type: "number",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        },
      },
      {
        id: "customfield_10042",
        name: "Story Points",
        custom: true,
        clauseNames: ["cf[10042]", "Story Points"],
        schema: {
          type: "number",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        },
      },
    ];
    const SPRINTS = [
      {
        id: 2,
        name: "Sprint 1",
        state: "closed",
        boardId: 2,
        goal: "Ship it",
        startDate: "2026-09-01T08:00:00.000Z",
      },
      { id: 4, name: "Sprint 3", state: "active", boardId: 2, goal: "Offline mode" },
    ];

    test("components, fix versions, sprints and every story-point field show when set", async () => {
      respond({
        "/rest/api/3/field": SCRUM_FIELDS,
        "/rest/api/3/issue/ABC-123": scrum({
          components: [
            { id: "1", name: "Backend" },
            { id: "2", name: "Frontend" },
          ],
          fixVersions: [{ id: "9", name: "1.1", released: false }],
          customfield_10020: SPRINTS,
          customfield_10016: 8,
          customfield_10042: 13,
        }),
      });
      const result = recordOf(await run("issue.get", { issue: "ABC-123" }));
      expect(calls[1]?.query.get("fields")).toContain(
        "components,fixVersions,customfield_10015,customfield_10021,customfield_10020,customfield_10016,customfield_10042",
      );
      expect(result).toMatchObject({
        components: ["Backend", "Frontend"],
        fixVersions: ["1.1"],
        sprint: [
          { id: 2, name: "Sprint 1", state: "closed" },
          { id: 4, name: "Sprint 3", state: "active" },
        ],
        "Story point estimate": 8,
        "Story Points": 13,
      });
    });

    test("empty components, versions, sprint and story points are omitted", async () => {
      respond({
        "/rest/api/3/field": SCRUM_FIELDS,
        "/rest/api/3/issue/ABC-123": scrum({
          components: [],
          fixVersions: [],
          customfield_10020: null,
          customfield_10016: null,
        }),
      });
      const result = recordOf(await run("issue.get", { issue: "ABC-123" }));
      for (const key of ["components", "fixVersions", "sprint", "Story point estimate"]) {
        expect(key in result).toBe(false);
      }
    });

    test("--issue-fields takes display names, sends their ids and shows values under the name", async () => {
      respond({
        "/rest/api/3/field": SCRUM_FIELDS,
        "/rest/api/3/issue/ABC-123": scrum({ customfield_10020: SPRINTS, customfield_10016: 8 }),
      });
      const result = recordOf(
        await run(
          "issue.get",
          { issue: "ABC-123" },
          { issueFields: "summary, sprint, Story point estimate" },
        ),
      );
      expect(calls.at(-1)?.query.get("fields")).toBe("summary,customfield_10020,customfield_10016");
      expect(result.Sprint).toEqual([
        { id: 2, name: "Sprint 1", state: "closed" },
        { id: 4, name: "Sprint 3", state: "active" },
      ]);
      expect(result["Story point estimate"]).toBe(8);
    });

    test("ids and system fields need no field lookup; a sprint is still compacted", async () => {
      respond({
        "/rest/api/3/issue/ABC-123": scrum({ customfield_10020: SPRINTS }),
      });
      const result = recordOf(
        await run("issue.get", { issue: "ABC-123" }, { issueFields: "summary,customfield_10020" }),
      );
      expect(calls.map((c) => c.path)).toEqual(["/rest/api/3/issue/ABC-123"]);
      expect(result.customfield_10020).toEqual([
        { id: 2, name: "Sprint 1", state: "closed" },
        { id: 4, name: "Sprint 3", state: "active" },
      ]);
    });

    test("an unknown or ambiguous --issue-fields name is an input error, not a silent drop", async () => {
      respond({
        "/rest/api/3/field": [
          ...SCRUM_FIELDS,
          { id: "customfield_10050", name: "Rank", custom: true },
          { id: "customfield_10051", name: "rank", custom: true },
        ],
      });
      const unknown = await failure(
        run("issue.get", { issue: "ABC-123" }, { issueFields: "Sprin" }),
      );
      expect(unknown.code).toBe("unknown_field");
      expect(unknown.message).toContain("customfield_10020 (Sprint)");
      const ambiguous = await failure(
        run("issue.get", { issue: "ABC-123" }, { issueFields: "Rank" }),
      );
      expect(ambiguous.code).toBe("ambiguous_field");
      expect(calls.map((c) => c.path)).not.toContain("/rest/api/3/issue/ABC-123");
    });

    test("jql --issue-fields takes display names too", async () => {
      respond({
        "/rest/api/3/field": SCRUM_FIELDS,
        "/rest/api/3/search/jql": {
          issues: [scrum({ customfield_10020: SPRINTS, customfield_10016: 5 })],
          isLast: true,
        },
      });
      const result = await run(
        "jql",
        { query: "x = 1" },
        { issueFields: "summary,Sprint,Story point estimate" },
      );
      expect(calls.at(-1)?.query.get("fields")).toBe("summary,customfield_10020,customfield_10016");
      expect(itemsOf(result)[0]).toMatchObject({
        Sprint: [
          { id: 2, name: "Sprint 1", state: "closed" },
          { id: 4, name: "Sprint 3", state: "active" },
        ],
        "Story point estimate": 5,
      });
    });
  });

  test("--comments N fetches the N newest comments", async () => {
    respond({
      "/rest/api/3/field": FIELDS,
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
    expect(calls[2]?.path).toBe("/rest/api/3/issue/ABC-123/comment");
    expect(calls[2]?.query.get("orderBy")).toBe("-created");
    expect(calls[2]?.query.get("maxResults")).toBe("2");
    expect(result.comments).toEqual([
      { id: "900", author: "G", created: "c2", updated: "u2", body: ["Second"] },
      { id: "899", author: "A", created: "c1", updated: "u1", body: ["First"] },
    ]);
  });

  test("no comment request without --comments", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE, "/rest/api/3/field": FIELDS });
    const result = recordOf(await run("issue.get", { issue: "ABC-123" }));
    expect(calls.map((c) => c.path)).not.toContain("/rest/api/3/issue/ABC-123/comment");
    expect("comments" in result).toBe(false);
  });

  test("a browse URL selects its site and key", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE, "/rest/api/3/field": FIELDS });
    await run("issue.get", { issue: "https://acme.atlassian.net/browse/ABC-123" });
    expect(calls.at(-1)?.path).toBe("/rest/api/3/issue/ABC-123");
  });

  test("an issue ARI selects the site by its cloud id among several accessible sites", async () => {
    const other = "99999999-2222-3333-4444-555555555555";
    await saveConfig(
      {
        sites: {
          "acme.atlassian.net": siteEntry(CLOUD, "acme.atlassian.net"),
          "other.atlassian.net": siteEntry(other, "other.atlassian.net"),
        },
      },
      ctx.env,
    );
    const urls: string[] = [];
    jiraDeps.fetch = (input) => {
      urls.push(input);
      return Promise.resolve(
        new Response(JSON.stringify(ISSUE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    await run(
      "issue.get",
      { issue: `ari:cloud:jira:${other}:issue/10042` },
      { issueFields: "summary" },
    );
    expect(urls[0]).toContain(`/ex/jira/${other}/rest/api/3/issue/10042`);
  });

  test("--full returns the raw issue", async () => {
    respond({ "/rest/api/3/issue/ABC-123": ISSUE });
    const result = await run("issue.get", { issue: "ABC-123" }, {}, { full: true });
    expect(result).toEqual(ISSUE);
    // Raw means every field, not the compact projection.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get("fields")).toBe("*all");
  });

  test("shows due date, start date and flagged under stable keys, compacting the option", async () => {
    respond({
      "/rest/api/3/issue/ABC-123": {
        ...ISSUE,
        fields: {
          ...ISSUE.fields,
          duedate: "2026-12-24",
          customfield_10015: "2026-10-01",
          customfield_10021: [{ self: "https://x", value: "Impediment", id: "10019" }],
        },
      },
      "/rest/api/3/field": FIELDS,
    });
    const result = recordOf(await run("issue.get", { issue: "ABC-123" }));
    expect(result).toMatchObject({
      duedate: "2026-12-24",
      startdate: "2026-10-01",
      flagged: ["Impediment"],
    });
    expect("fields" in result).toBe(false);
  });

  test("issue get and jql items share the parent shape and compact --issue-fields extras", async () => {
    const issue = {
      ...ISSUE,
      fields: {
        ...ISSUE.fields,
        subtasks: [
          { id: "1", key: "ABC-124", self: "https://x", fields: { summary: "Sub 1" } },
          { id: "2", key: "ABC-125", self: "https://x", fields: { summary: "Sub 2" } },
        ],
        timespent: 11700,
        customfield_10030: { value: "High", id: "1" },
        customfield_10031: { accountId: "acc-1", displayName: "Ada" },
      },
    };
    respond({
      "/rest/api/3/issue/ABC-123": issue,
      "/rest/api/3/search/jql": { issues: [issue], isLast: true },
    });
    const issueFields = "summary,parent,subtasks,timespent,customfield_10030,customfield_10031";
    const got = recordOf(await run("issue.get", { issue: "ABC-123" }, { issueFields }));
    const listed = itemsOf(await run("jql", { query: "x = 1" }, { issueFields }))[0] ?? {};
    for (const item of [got, listed]) {
      expect(item).toMatchObject({
        parent: { key: "ABC-100", summary: "Auth epic" },
        subtasks: ["ABC-124", "ABC-125"],
        timespent: 11700,
        customfield_10030: "High",
        customfield_10031: "Ada",
      });
      expect("fields" in item).toBe(false);
    }
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
      "/rest/api/3/issue/ABC-123/remotelink": [{ id: 1 }, { id: 2 }],
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
      remote: 2,
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

  test("--global-id with no matching link is an empty list, not a 404", async () => {
    respond({});
    expect(await run("issue.links", { issue: "ABC-123" }, { globalId: "system=x&id=9" })).toEqual({
      items: [],
    });
    expect(calls[0]?.query.get("globalId")).toBe("system=x&id=9");
  });

  test("--remote without --global-id still fails on a 404", async () => {
    respond({});
    const error = await failure(run("issue.links", { issue: "ABC-123" }, { remote: true }));
    expect(error.status).toBe(404);
  });

  test("no remote count when the issue has no remote links", async () => {
    respond({
      "/rest/api/3/issue/ABC-123": { id: "1", key: "ABC-123", fields: { issuelinks: [] } },
      "/rest/api/3/issue/ABC-123/remotelink": [],
    });
    expect(await run("issue.links", { issue: "ABC-123" })).toEqual({ items: [] });
  });

  describe("--chain", () => {
    test("follows the first matching link case-insensitively until the end", async () => {
      respond({
        "/rest/api/3/issue/ABC-1": chainNode("ABC-1", [
          chainLink("1", "ABC-9", true),
          chainLink("2", "ABC-2", false),
        ]),
        "/rest/api/3/issue/ABC-2": chainNode("ABC-2", [chainLink("3", "ABC-3", false)]),
        "/rest/api/3/issue/ABC-3": chainNode("ABC-3", [chainLink("4", "ABC-2", true)]),
      });
      const result = await run("issue.links", { issue: "ABC-1" }, { chain: "IS Blocked By" });
      expect(calls[0]?.query.get("fields")).toBe("summary,status,issuelinks");
      expect(result).toEqual({
        chain: [
          { key: "ABC-1", summary: "Sum ABC-1", status: "To Do" },
          { key: "ABC-2", summary: "Sum ABC-2", status: "To Do" },
          { key: "ABC-3", summary: "Sum ABC-3", status: "To Do" },
        ],
        stoppedBy: "end",
      });
    });

    test("stops on a cycle without revisiting", async () => {
      respond({
        "/rest/api/3/issue/ABC-1": chainNode("ABC-1", [chainLink("1", "ABC-2", false)]),
        "/rest/api/3/issue/ABC-2": chainNode("ABC-2", [chainLink("2", "ABC-1", false)]),
      });
      const result = recordOf(
        await run("issue.links", { issue: "ABC-1" }, { chain: "is blocked by" }),
      );
      expect(result.stoppedBy).toBe("cycle");
      expect(result.cycleTo).toBe("ABC-1");
      expect(calls).toHaveLength(2);
    });

    test("--max bounds the links followed", async () => {
      respond({
        "/rest/api/3/issue/ABC-1": chainNode("ABC-1", [chainLink("1", "ABC-2", false)]),
        "/rest/api/3/issue/ABC-2": chainNode("ABC-2", [chainLink("2", "ABC-3", false)]),
        "/rest/api/3/issue/ABC-3": chainNode("ABC-3", [chainLink("3", "ABC-4", false)]),
      });
      const result = recordOf(
        await run("issue.links", { issue: "ABC-1" }, { chain: "is blocked by", max: 2 }),
      );
      expect(itemsOfChain(result)).toEqual(["ABC-1", "ABC-2", "ABC-3"]);
      expect(result.stoppedBy).toBe("max");
    });

    test("reports branches where several links match", async () => {
      respond({
        "/rest/api/3/issue/ABC-1": chainNode("ABC-1", [
          chainLink("1", "ABC-2", false),
          chainLink("2", "ABC-5", false),
        ]),
        "/rest/api/3/issue/ABC-2": chainNode("ABC-2", []),
      });
      const result = recordOf(
        await run("issue.links", { issue: "ABC-1" }, { chain: "is blocked by" }),
      );
      expect(itemsOfChain(result)).toEqual(["ABC-1", "ABC-2"]);
      expect(recordOf(Array.isArray(result.chain) ? result.chain[0] : undefined).branches).toEqual([
        "ABC-5",
      ]);
    });

    test("an unmatched start relation returns the start issue and the relations it has", async () => {
      respond({ "/rest/api/3/issue/ABC-1": chainNode("ABC-1", [chainLink("1", "ABC-2", true)]) });
      expect(await run("issue.links", { issue: "ABC-1" }, { chain: "is blocked by" })).toEqual({
        chain: [{ key: "ABC-1", summary: "Sum ABC-1", status: "To Do" }],
        stoppedBy: "end",
        relations: ["blocks"],
      });
    });

    test("cannot be combined with --remote", async () => {
      const error = await failure(
        run("issue.links", { issue: "ABC-1" }, { chain: "blocks", remote: true }),
      );
      expect(error.code).toBe("conflicting_flags");
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

  test("marks an edited comment, even when the edit falls in the same second", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/comment": {
        startAt: 0,
        maxResults: 100,
        total: 3,
        comments: [
          {
            id: "1",
            created: "2026-10-23T10:56:14.082+0200",
            updated: "2026-10-23T10:56:14.431+0200",
            body: doc("edited quickly"),
          },
          {
            id: "2",
            created: "2026-10-23T10:56:14.997+0200",
            updated: "2026-10-23T10:56:14.997+0200",
            body: doc("untouched"),
          },
          {
            id: "3",
            created: "2026-10-23T10:56:14.000+0200",
            updated: "2026-10-23T12:00:00.000+0200",
            body: doc("edited later"),
          },
        ],
      },
    });
    const items = itemsOf(await run("issue.comments", { issue: "ABC-123" }));
    expect(items.map((c) => [c.id, c.edited, c.updated])).toEqual([
      ["1", true, undefined],
      ["2", undefined, undefined],
      ["3", undefined, "2026-10-23T12:00:00+0200"],
    ]);
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
      parent: { key: "ABC-100", summary: "Auth epic" },
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

  test("a Jira issues URL contributes its jql parameter", async () => {
    respond({ "/rest/api/3/search/jql": sequence(page2) });
    await run("jql", {
      query: "https://acme.atlassian.net/issues/?jql=labels%20%3D%20nightmare%20ORDER%20BY%20key",
    });
    expect(calls[0]?.query.get("jql")).toBe("labels = nightmare ORDER BY key");
  });

  test("a URL without a jql parameter is an input error", async () => {
    const error = await failure(run("jql", { query: "https://acme.atlassian.net/browse/ABC-1" }));
    expect(error.code).toBe("invalid_jql_url");
    expect(error.category).toBe("input");
  });

  describe("empty results", () => {
    const STATUS_ERROR = "A(z) 'Teendő' érték nem létezik a(z) 'status' mezőhöz.";

    test("an empty result with JQL errors warns on stderr and leaves stdout unchanged", async () => {
      respond({
        "/rest/api/3/search/jql": { issues: [], isLast: true },
        "/rest/api/3/jql/parse": {
          queries: [{ query: "status = Teendő", errors: [STATUS_ERROR] }],
        },
      });
      const { result, diagnostics } = await withDiagnostics(() =>
        run("jql", { query: "status = Teendő" }),
      );
      expect(result).toEqual({ items: [] });
      expect(diagnostics).toEqual([
        {
          type: "warning",
          code: "jql_invalid",
          message: expect.stringContaining("errors in the JQL"),
          errors: [STATUS_ERROR],
          next: [["atl", "jql-suggest", "--field", "status"]],
        },
      ]);
      expect(calls.at(-1)?.body).toEqual({ queries: ["status = Teendő"] });
    });

    test("count mode warns the same way, without a next for non-status errors", async () => {
      const error = "A(z) 'bogusfield' mező nem létezik.";
      respond({
        "/rest/api/3/search/approximate-count": { count: 0 },
        "/rest/api/3/jql/parse": { queries: [{ query: "bogusfield = 1", errors: [error] }] },
      });
      const { result, diagnostics } = await withDiagnostics(() =>
        run("jql", { query: "bogusfield = 1" }, { resultMode: "count" }),
      );
      expect(result).toEqual({ count: 0 });
      expect(diagnostics).toEqual([
        { type: "warning", code: "jql_invalid", message: expect.any(String), errors: [error] },
      ]);
    });

    test("a valid query with no hits is silent", async () => {
      respond({
        "/rest/api/3/search/jql": { issues: [], isLast: true },
        "/rest/api/3/jql/parse": { queries: [{ query: "x = 1" }] },
      });
      const { result, diagnostics } = await withDiagnostics(() => run("jql", { query: "x = 1" }));
      expect(result).toEqual({ items: [] });
      expect(diagnostics).toEqual([]);
    });

    test("a non-empty result is not validated", async () => {
      respond({ "/rest/api/3/search/jql": sequence(page2) });
      await run("jql", { query: "x = 1" });
      expect(calls.map((c) => c.path)).toEqual(["/rest/api/3/search/jql"]);
    });

    test("a childIssuesOf query with no hits points at issue tree on stderr", async () => {
      respond({
        "/rest/api/3/search/jql": { issues: [], isLast: true },
        "/rest/api/3/jql/parse": { queries: [{ query: "x" }] },
      });
      const { result, diagnostics } = await withDiagnostics(() =>
        run("jql", { query: 'issue in childIssuesOf("kan-192")' }),
      );
      expect(result).toEqual({ items: [] });
      expect(diagnostics).toEqual([
        {
          type: "hint",
          code: "child_issues_of_empty",
          hint: expect.stringContaining("issue tree"),
          next: [["atl", "issue", "tree", "KAN-192"]],
        },
      ]);
    });
  });

  describe("--group-by", () => {
    test("counts status names across pages, requesting only that field", async () => {
      respond({
        "/rest/api/3/search/jql": sequence(
          {
            issues: [
              groupIssue("A-1", { status: { name: "To Do" } }),
              groupIssue("A-2", { status: { name: "Done" } }),
            ],
            nextPageToken: "t2",
          },
          { issues: [groupIssue("A-3", { status: { name: "Done" } })], isLast: true },
        ),
      });
      expect(await run("jql", { query: "project = A" }, { groupBy: "status" })).toEqual({
        total: 3,
        groups: { Done: 2, "To Do": 1 },
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.query.get("fields")).toBe("status");
      expect(calls[0]?.query.get("maxResults")).toBe("100");
      expect(calls[1]?.query.get("nextPageToken")).toBe("t2");
    });

    test("aliases pick the right field and label", async () => {
      const issues = [
        groupIssue("A-1", {
          status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
          assignee: { accountId: "a", displayName: "Ada" },
          project: { key: "A", name: "Alpha" },
          issuetype: { name: "Bug" },
        }),
        groupIssue("A-2", {
          status: { name: "Done", statusCategory: { key: "done", name: "Done" } },
          assignee: null,
          project: { key: "A", name: "Alpha" },
          issuetype: { name: "Bug" },
        }),
      ];
      const grouped = async (groupBy: string) => {
        respond({ "/rest/api/3/search/jql": { issues, isLast: true } });
        const result = recordOf(await run("jql", { query: "x = 1" }, { groupBy }));
        return [calls.at(-1)?.query.get("fields"), result.groups];
      };
      expect(await grouped("assignee")).toEqual(["assignee", { Ada: 1, "(none)": 1 }]);
      expect(await grouped("statusCategory")).toEqual(["status", { new: 1, done: 1 }]);
      expect(await grouped("project")).toEqual(["project", { A: 2 }]);
      expect(await grouped("type")).toEqual(["issuetype", { Bug: 2 }]);
    });

    test("a raw field id counts every array element and scalar values", async () => {
      respond({
        "/rest/api/3/field": FIELDS,
        "/rest/api/3/search/jql": {
          issues: [
            groupIssue("A-1", { labels: ["web", "auth"], customfield_1: 5 }),
            groupIssue("A-2", { labels: ["web"], customfield_1: 5 }),
            groupIssue("A-3", { labels: [] }),
          ],
          isLast: true,
        },
      });
      expect(await run("jql", { query: "x = 1" }, { groupBy: "labels" })).toEqual({
        total: 3,
        groups: { web: 2, auth: 1, "(none)": 1 },
      });
      expect(calls.at(-1)?.query.get("fields")).toBe("labels");
    });

    test("a field name, localized name or clause name resolves to its id", async () => {
      const flagged = [
        groupIssue("A-1", { customfield_10021: [{ value: "Impediment" }] }),
        groupIssue("A-2", { customfield_10021: null }),
      ];
      for (const name of ["Flagged", "flagged", "cf[10021]", "customfield_10021"]) {
        expect(await groupedFields(name, flagged)).toEqual([
          "customfield_10021",
          { Impediment: 1, "(none)": 1 },
        ]);
      }
      const started = [groupIssue("A-1", { customfield_10015: "2026-10-01" })];
      for (const name of ["Kezdő dátum", "Start date"]) {
        expect(await groupedFields(name, started)).toEqual([
          "customfield_10015",
          { "2026-10-01": 1 },
        ]);
      }
    });

    test("an unknown field is an input error listing close matches, before any search", async () => {
      respond({ "/rest/api/3/field": FIELDS });
      const error = await failure(run("jql", { query: "x = 1" }, { groupBy: "Flaged" }));
      expect(error.code).toBe("unknown_field");
      expect(error.category).toBe("input");
      expect(error.message).toContain("customfield_10021 (Flagged)");
      expect(calls.map((c) => c.path)).toEqual(["/rest/api/3/field"]);
    });

    test("a name shared by several fields is ambiguous", async () => {
      respond({
        "/rest/api/3/field": [
          { id: "customfield_1", name: "Sprint", clauseNames: ["Sprint"] },
          { id: "customfield_2", name: "Sprint", clauseNames: ["Sprint[Dropdown]"] },
        ],
      });
      const error = await failure(run("jql", { query: "x = 1" }, { groupBy: "sprint" }));
      expect(error.code).toBe("ambiguous_field");
      expect(error.message).toContain("customfield_1");
      expect(error.message).toContain("customfield_2");
    });

    test("reports capped with the approximate total when the 1000-issue cap cuts the read", async () => {
      const pages = Array.from({ length: 10 }, (_, n) => groupPage(n));
      respond({
        "/rest/api/3/search/jql": sequence(...pages),
        "/rest/api/3/search/approximate-count": { count: 1500 },
      });
      expect(await run("jql", { query: "x = 1" }, { groupBy: "status" })).toEqual({
        total: 1500,
        groups: { Open: 1000 },
        capped: true,
      });
    });

    test("cannot be combined with --limit", async () => {
      const error = await failure(run("jql", { query: "x = 1" }, { groupBy: "status", limit: 5 }));
      expect(error.code).toBe("conflicting_flags");
      expect(calls).toHaveLength(0);
    });

    test("the conflict message spells flags in kebab-case", async () => {
      const error = await failure(
        run(
          "jql",
          { query: "x = 1" },
          { groupBy: "status", issueFields: "summary", resultMode: "count" },
        ),
      );
      expect(error.message).toContain("--issue-fields, --result-mode");
      expect(error.message).not.toContain("issueFields");
    });
  });
});

const child = (key: string, parent: string, status = "To Do") => ({
  id: key,
  key,
  fields: {
    summary: `Sum ${key}`,
    status: { name: status },
    issuetype: { name: "Task" },
    parent: { key: parent },
  },
});
const ROOT = {
  id: "1",
  key: "ABC-1",
  fields: { summary: "Epic", status: { name: "To Do" }, issuetype: { name: "Epic" } },
};
const search = (...issues: unknown[]) => ({ issues, isLast: true });
const jqls = () =>
  calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => c.query.get("jql"));

describe("issue.tree", () => {
  test("walks every level breadth-first and reports depth and parent", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(
        search(child("ABC-2", "ABC-1"), child("ABC-3", "ABC-1")),
        search(child("ABC-4", "ABC-2"), child("ABC-5", "ABC-3")),
        search(child("ABC-6", "ABC-4")),
        search(),
      ),
    });
    const result = recordOf(await run("issue.tree", { issue: "abc-1" }));
    expect(result.root).toEqual({
      key: "ABC-1",
      summary: "Epic",
      status: "To Do",
      type: "Epic",
    });
    expect(result.total).toBe(5);
    expect(result.capped).toBeUndefined();
    expect(itemsOf(result).map((i) => [i.key, i.parent, i.depth])).toEqual([
      ["ABC-2", "ABC-1", 1],
      ["ABC-3", "ABC-1", 1],
      ["ABC-4", "ABC-2", 2],
      ["ABC-5", "ABC-3", 2],
      ["ABC-6", "ABC-4", 3],
    ]);
    expect(itemsOf(result)[0]).toMatchObject({
      summary: "Sum ABC-2",
      status: "To Do",
      type: "Task",
    });
    expect(jqls()).toEqual([
      "parent in (ABC-1) ORDER BY key ASC",
      "parent in (ABC-2,ABC-3) ORDER BY key ASC",
      "parent in (ABC-4,ABC-5) ORDER BY key ASC",
      "parent in (ABC-6) ORDER BY key ASC",
    ]);
    expect(calls[0]?.query.get("fields")).toBe("summary,status,issuetype");
    expect(calls[1]?.query.get("fields")).toBe(
      "summary,status,issuetype,priority,assignee,updated,parent",
    );
  });

  test("an issue without children is an empty tree", async () => {
    respond({ "/rest/api/3/issue/ABC-1": ROOT, "/rest/api/3/search/jql": search() });
    expect(await run("issue.tree", { issue: "ABC-1" })).toEqual({
      root: { key: "ABC-1", summary: "Epic", status: "To Do", type: "Epic" },
      total: 0,
      items: [],
    });
  });

  test("--group-by counts every descendant per field value, requesting only that field", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(
        search(child("ABC-2", "ABC-1", "Done"), child("ABC-3", "ABC-1", "To Do")),
        search(child("ABC-4", "ABC-2", "Done"), child("ABC-5", "ABC-3", "Done")),
        search(),
      ),
    });
    const result = recordOf(await run("issue.tree", { issue: "ABC-1" }, { groupBy: "status" }));
    expect(result.total).toBe(4);
    expect(result.groups).toEqual({ Done: 3, "To Do": 1 });
    expect(result).not.toHaveProperty("items");
    expect(
      calls.filter((c) => c.path.endsWith("/search/jql")).map((c) => c.query.get("fields")),
    ).toEqual(["status", "status", "status"]);
  });

  test("--group-by resolves a field name like jql --group-by", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/field": FIELDS,
      "/rest/api/3/search/jql": sequence(
        search({ id: "2", key: "ABC-2", fields: { labels: ["web", "auth"] } }),
        search(),
      ),
    });
    const result = recordOf(await run("issue.tree", { issue: "ABC-1" }, { groupBy: "labels" }));
    expect(result.groups).toEqual({ web: 1, auth: 1 });
    expect(calls.find((c) => c.path.endsWith("/search/jql"))?.query.get("fields")).toBe("labels");
  });

  test("--group-by cannot be combined with --issue-fields", async () => {
    const error = await failure(
      run("issue.tree", { issue: "ABC-1" }, { groupBy: "status", issueFields: "summary" }),
    );
    expect(error.code).toBe("conflicting_flags");
    expect(calls).toHaveLength(0);
  });

  test("a parent cycle or a repeated issue is visited once and the walk ends", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(
        search(child("ABC-2", "ABC-1")),
        search(child("ABC-1", "ABC-2"), child("ABC-2", "ABC-2"), child("ABC-3", "ABC-2")),
        search(child("ABC-2", "ABC-3")),
      ),
    });
    const result = await run("issue.tree", { issue: "ABC-1" });
    expect(itemsOf(result).map((i) => i.key)).toEqual(["ABC-2", "ABC-3"]);
    expect(jqls()).toHaveLength(3);
  });

  test("--limit cuts the walk and reports capped; an exact fit is not capped", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(
        search(child("ABC-2", "ABC-1"), child("ABC-3", "ABC-1"), child("ABC-4", "ABC-1")),
      ),
    });
    const cut = recordOf(await run("issue.tree", { issue: "ABC-1" }, { limit: 2 }));
    expect(cut.total).toBe(2);
    expect(cut.capped).toBe(true);
    expect(calls.at(-1)?.query.get("maxResults")).toBe("3");
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(
        search(child("ABC-2", "ABC-1"), child("ABC-3", "ABC-1")),
        search(),
      ),
    });
    const exact = recordOf(await run("issue.tree", { issue: "ABC-1" }, { limit: 2 }));
    expect(exact.total).toBe(2);
    expect(exact.capped).toBeUndefined();
  });

  test("the walk stops at the 1000-issue cap with capped", async () => {
    const level = Array.from({ length: 10 }, (_, n) => ({
      issues: Array.from({ length: 100 }, (_item, i) => child(`A-${n * 100 + i}`, "ABC-1")),
      nextPageToken: `t${n + 1}`,
    }));
    respond({ "/rest/api/3/issue/ABC-1": ROOT, "/rest/api/3/search/jql": sequence(...level) });
    const result = recordOf(await run("issue.tree", { issue: "ABC-1" }, { groupBy: "status" }));
    expect(result.total).toBe(1000);
    expect(result.capped).toBe(true);
  });

  test("--depth 1 reads only the direct children", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(
        search(child("ABC-2", "ABC-1")),
        search(child("ABC-3", "ABC-2")),
      ),
    });
    const result = await run("issue.tree", { issue: "ABC-1" }, { depth: 1 });
    expect(itemsOf(result).map((i) => i.key)).toEqual(["ABC-2"]);
    expect(jqls()).toHaveLength(1);
  });

  test("a level wider than 50 issues is searched in batches of 50 keys", async () => {
    const wide = Array.from({ length: 51 }, (_, i) => child(`W-${i + 1}`, "ABC-1"));
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(search(...wide), search(), search()),
    });
    await run("issue.tree", { issue: "ABC-1" });
    const second = jqls();
    expect(second).toHaveLength(3);
    expect(second[1]?.split(",")).toHaveLength(50);
    expect(second[2]).toBe("parent in (W-51) ORDER BY key ASC");
  });

  test("--issue-fields replaces the item fields and always asks for the parent", async () => {
    respond({
      "/rest/api/3/issue/ABC-1": ROOT,
      "/rest/api/3/search/jql": sequence(search(child("ABC-2", "ABC-1")), search()),
    });
    await run("issue.tree", { issue: "ABC-1" }, { issueFields: "summary,assignee" });
    expect(calls[1]?.query.get("fields")).toBe("summary,assignee,parent");
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

  test("project.types sends a lowercase project key as the uppercase key Jira expects", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes": { startAt: 0, total: 2, issueTypes: types },
    });
    await run("project.types", { project: " abc " });
    expect(calls.map((c) => c.path)).toEqual(["/rest/api/3/issue/createmeta/ABC/issuetypes"]);
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

  test("project.fields resolves the English untranslated name of a localized type", async () => {
    respond({
      "/rest/api/3/issue/createmeta/ABC/issuetypes": {
        startAt: 0,
        total: 1,
        issueTypes: [{ id: "10005", name: "Feladat", untranslatedName: "Task" }],
      },
      "/rest/api/3/issue/createmeta/ABC/issuetypes/10005": { startAt: 0, total: 0, fields: [] },
    });
    await run("project.fields", { project: "ABC", type: "task" });
    expect(calls.at(-1)?.path).toBe("/rest/api/3/issue/createmeta/ABC/issuetypes/10005");
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
    respond({ "/rest/api/3/issue/ABC-123": ISSUE, "/rest/api/3/field": FIELDS });
    await run("issue.get", { issue: "ABC-123" });
    const issueCall = calls.find((c) => c.path === "/rest/api/3/issue/ABC-123");
    expect([...(issueCall?.query.keys() ?? [])]).toEqual(["fields"]);
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
    expect("fields" in result).toBe(false);
    expect(result.components).toEqual(["Backend"]);
    expect(result.customfield_10010).toBe("x");
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
            hasScreen: true,
            fields: {
              resolution: {
                required: true,
                name: "Resolution",
                allowedValues: [{ name: "Done" }, { name: "Won't Do" }],
              },
              comment: { name: "Comment" },
            },
          },
          { id: "11", name: "Start", to: { name: "In Progress" }, fields: {} },
        ],
      },
    });
    const items = itemsOf(
      await run("issue.transitions", { issue: "ABC-123" }, { expand: "transitions.fields" }),
    );
    expect(items[0]?.fields).toEqual([
      { id: "resolution", name: "Resolution", required: true, allowed: ["Done", "Won't Do"] },
      { id: "comment", name: "Comment" },
    ]);
    expect(items[1]).toEqual({ id: "11", name: "Start", to: "In Progress" });
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

const history = (id: string, field: string, from: string, to: string, ids?: [string, string]) => ({
  id,
  author: { accountId: "acc-1", displayName: "Ada", emailAddress: "ada@example.com" },
  created: "2026-10-01T09:00:00.123+0000",
  items: [
    {
      field,
      fieldtype: "jira",
      ...(ids === undefined ? {} : { fieldId: field, from: ids[0], to: ids[1] }),
      fromString: from,
      toString: to,
    },
  ],
});

const HUNGARIAN_STATUSES = [
  { id: "10000", name: "Teendő" },
  { id: "3", name: "Folyamatban" },
  { id: "10001", name: "Kész" },
];

describe("issue.changelog", () => {
  test("compacts entries and pages by startAt", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/changelog": sequence(
        {
          startAt: 0,
          total: 3,
          values: [history("1", "priority", "Low", "High", ["4", "2"])],
        },
        { startAt: 1, total: 3, values: [history("2", "priority", "Low", "High")] },
      ),
    });
    const first = await run("issue.changelog", { issue: "ABC-123" }, { limit: 1 });
    expect(first).toEqual({
      items: [
        {
          id: "1",
          by: "Ada",
          at: "2026-10-01T09:00:00+0000",
          changes: [{ field: "priority", from: "Low", to: "High" }],
        },
      ],
      nextCursor: "1",
    });
    expect(calls[0]?.query.get("startAt")).toBe("0");

    const second = await run("issue.changelog", { issue: "ABC-123" }, { limit: 1, cursor: "1" });
    expect(itemsOf(second)[0]?.id).toBe("2");
    expect(calls[1]?.query.get("startAt")).toBe("1");
  });

  test("falls back to raw ids when a change has no display strings; --full is raw", async () => {
    const raw = {
      startAt: 0,
      total: 1,
      values: [{ id: "1", items: [{ field: "assignee", from: "acc-1", to: "acc-2" }] }],
    };
    respond({ "/rest/api/3/issue/ABC-123/changelog": raw });
    const compact = await run("issue.changelog", { issue: "ABC-123" });
    expect(itemsOf(compact)[0]?.changes).toEqual([
      { field: "assignee", from: "acc-1", to: "acc-2" },
    ]);

    respond({ "/rest/api/3/issue/ABC-123/changelog": raw });
    const full = await run("issue.changelog", { issue: "ABC-123" }, {}, { full: true });
    expect(itemsOf(full)[0]).toEqual(raw.values[0]);
  });

  describe("status names", () => {
    const moved = {
      startAt: 0,
      total: 2,
      values: [
        history("1", "status", "To Do", "In Progress", ["10000", "3"]),
        history("2", "status", "In Progress", "Done", ["3", "10001"]),
      ],
    };

    test("show the account's language, from the status ids, with one status lookup per call", async () => {
      respond({
        "/rest/api/3/issue/ABC-123/changelog": moved,
        "/rest/api/3/status": HUNGARIAN_STATUSES,
      });
      const result = await run("issue.changelog", { issue: "ABC-123" });
      expect(itemsOf(result).map((entry) => entry.changes)).toEqual([
        [{ field: "status", from: "Teendő", to: "Folyamatban" }],
        [{ field: "status", from: "Folyamatban", to: "Kész" }],
      ]);
      expect(statusCalls()).toHaveLength(1);
    });

    test("a status id the site no longer lists keeps the changelog's own name", async () => {
      respond({
        "/rest/api/3/issue/ABC-123/changelog": moved,
        "/rest/api/3/status": [{ id: "3", name: "Folyamatban" }],
      });
      const result = await run("issue.changelog", { issue: "ABC-123" });
      expect(itemsOf(result)[0]?.changes).toEqual([
        { field: "status", from: "To Do", to: "Folyamatban" },
      ]);
    });

    test("are not looked up without a status change, and --full keeps the raw English names and ids", async () => {
      respond({
        "/rest/api/3/issue/ABC-123/changelog": {
          startAt: 0,
          total: 1,
          values: [history("1", "priority", "Low", "High", ["4", "2"])],
        },
      });
      await run("issue.changelog", { issue: "ABC-123" });
      expect(statusCalls()).toEqual([]);

      respond({
        "/rest/api/3/issue/ABC-123/changelog": moved,
        "/rest/api/3/status": HUNGARIAN_STATUSES,
      });
      const full = await run("issue.changelog", { issue: "ABC-123" }, {}, { full: true });
      expect(itemsOf(full)[0]).toEqual(moved.values[0]);
      expect(statusCalls()).toEqual([]);
    });
  });
});

describe("issue.worklogs", () => {
  const WORKLOG = {
    id: "9",
    author: { accountId: "acc-1", displayName: "Ada" },
    started: "2026-10-01T09:00:00.000+0000",
    timeSpent: "1h 30m",
    timeSpentSeconds: 5400,
    comment: doc("Fixed it"),
  };

  test("sends the time window and renders comments", async () => {
    respond({ "/rest/api/3/issue/ABC-123/worklog": { startAt: 0, total: 1, worklogs: [WORKLOG] } });
    const result = await run(
      "issue.worklogs",
      { issue: "ABC-123" },
      { startedAfter: 1000, startedBefore: 2000, expand: "properties" },
    );
    expect(calls[0]?.query.get("startedAfter")).toBe("1000");
    expect(calls[0]?.query.get("startedBefore")).toBe("2000");
    expect(calls[0]?.query.get("expand")).toBe("properties");
    expect(result).toEqual({
      totalSeconds: 5400,
      items: [
        {
          id: "9",
          by: "Ada",
          started: "2026-10-01T09:00:00+0000",
          time: "1h 30m",
          seconds: 5400,
          comment: ["Fixed it"],
        },
      ],
    });
  });

  test("totalSeconds sums the listed worklogs", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/worklog": {
        startAt: 0,
        total: 2,
        worklogs: [WORKLOG, { ...WORKLOG, id: "10", timeSpent: "45m", timeSpentSeconds: 2700 }],
      },
    });
    const result = recordOf(await run("issue.worklogs", { issue: "ABC-123" }));
    expect(result.totalSeconds).toBe(8100);
    expect(itemsOf(result).map((w) => w.seconds)).toEqual([5400, 2700]);
  });

  test("an empty issue prints an empty items list; --full is raw", async () => {
    respond({ "/rest/api/3/issue/ABC-123/worklog": { startAt: 0, total: 0, worklogs: [] } });
    expect(await run("issue.worklogs", { issue: "ABC-123" })).toEqual({ items: [] });

    respond({ "/rest/api/3/issue/ABC-123/worklog": { startAt: 0, total: 1, worklogs: [WORKLOG] } });
    const full = await run("issue.worklogs", { issue: "ABC-123" }, {}, { full: true });
    expect(itemsOf(full)[0]).toEqual(WORKLOG);
  });
});

describe("issue.editmeta", () => {
  const META = {
    fields: {
      summary: {
        required: true,
        schema: { type: "string" },
        name: "Summary",
        key: "summary",
        operations: ["set"],
      },
      priority: {
        required: false,
        schema: { type: "priority" },
        name: "Priority",
        key: "priority",
        operations: ["set"],
        allowedValues: Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `P${i}` })),
      },
    },
  };

  test("lists editable fields, capping allowed values and reporting the total", async () => {
    respond({ "/rest/api/3/issue/ABC-123/editmeta": META });
    const items = itemsOf(await run("issue.editmeta", { issue: "ABC-123" }));
    expect(items[0]).toEqual({
      fieldId: "summary",
      name: "Summary",
      required: true,
      type: "string",
      operations: ["set"],
    });
    expect(items[1]?.allowedValues).toHaveLength(20);
    expect(items[1]?.allowedValuesTotal).toBe(25);
  });

  test("--field selects fields; --full is raw", async () => {
    respond({ "/rest/api/3/issue/ABC-123/editmeta": META });
    const items = itemsOf(await run("issue.editmeta", { issue: "ABC-123" }, { field: "summary" }));
    expect(items.map((i) => i.fieldId)).toEqual(["summary"]);

    respond({ "/rest/api/3/issue/ABC-123/editmeta": META });
    const full = await run("issue.editmeta", { issue: "ABC-123" }, {}, { full: true });
    expect(itemsOf(full)[0]).toEqual(META.fields.summary);
  });
});

describe("issue.watchers", () => {
  const WATCHERS = {
    watchCount: 2,
    isWatching: true,
    watchers: [
      { accountId: "acc-1", displayName: "Ada", emailAddress: "a@example.com" },
      { accountId: "acc-2", displayName: "Grace" },
    ],
  };

  test("names the watchers and the count", async () => {
    respond({ "/rest/api/3/issue/ABC-123/watchers": WATCHERS });
    expect(await run("issue.watchers", { issue: "ABC-123" })).toEqual({
      watchCount: 2,
      watching: true,
      items: [
        { accountId: "acc-1", name: "Ada" },
        { accountId: "acc-2", name: "Grace" },
      ],
    });
  });

  test("--full returns the raw response", async () => {
    respond({ "/rest/api/3/issue/ABC-123/watchers": WATCHERS });
    expect(await run("issue.watchers", { issue: "ABC-123" }, {}, { full: true })).toEqual(WATCHERS);
  });
});

describe("issue.permissions", () => {
  const PERMS = {
    permissions: {
      EDIT_ISSUES: { key: "EDIT_ISSUES", havePermission: true },
      DELETE_ISSUES: { key: "DELETE_ISSUES", havePermission: false },
    },
  };

  test("an issue key goes out as issueKey with the requested permission keys", async () => {
    respond({ "/rest/api/3/mypermissions": PERMS });
    const result = await run(
      "issue.permissions",
      { issue: "ABC-123" },
      { permissions: "EDIT_ISSUES, DELETE_ISSUES" },
    );
    expect(calls[0]?.query.get("issueKey")).toBe("ABC-123");
    expect(calls[0]?.query.get("permissions")).toBe("EDIT_ISSUES,DELETE_ISSUES");
    expect(result).toEqual({ granted: ["EDIT_ISSUES"], denied: ["DELETE_ISSUES"] });
  });

  test("a numeric project id goes out as projectId, a key as projectKey", async () => {
    respond({ "/rest/api/3/mypermissions": PERMS });
    await run("issue.permissions", {}, { project: "10000" });
    await run("issue.permissions", {}, { project: "ABC" });
    expect(calls[0]?.query.get("projectId")).toBe("10000");
    expect(calls[1]?.query.get("projectKey")).toBe("ABC");
    expect(calls[0]?.query.get("permissions")).toContain("BROWSE_PROJECTS");
  });

  test("needs exactly one of issue or --project, before any request", async () => {
    respond({});
    expect((await failure(run("issue.permissions", {}))).code).toBe("invalid_target");
    expect(
      (await failure(run("issue.permissions", { issue: "ABC-1" }, { project: "ABC" }))).code,
    ).toBe("invalid_target");
    expect(calls).toHaveLength(0);
  });
});

describe("status.list", () => {
  const GLOBAL = [
    { id: "1", name: "To Do", statusCategory: { key: "new" } },
    { id: "2", name: "In Review", statusCategory: { key: "indeterminate" } },
    { id: "3", name: "Done", statusCategory: { key: "done" } },
  ];
  const BY_TYPE = [
    { id: "10001", name: "Bug", subtask: false, statuses: GLOBAL },
    { id: "10002", name: "Sub-task", subtask: true, statuses: [GLOBAL[0]] },
  ];

  test("site-wide filters by category and name, client side", async () => {
    respond({ "/rest/api/3/status": GLOBAL });
    const items = itemsOf(
      await run("status.list", {}, { nameContains: "re", statusCategory: "indeterminate" }),
    );
    expect(items).toEqual([{ id: "2", name: "In Review", category: "indeterminate" }]);
  });

  test("site-wide results page with a cursor", async () => {
    respond({ "/rest/api/3/status": GLOBAL });
    const result = recordOf(await run("status.list", {}, { limit: 2 }));
    expect(result.nextCursor).toBe("2");
    respond({ "/rest/api/3/status": GLOBAL });
    const rest = recordOf(await run("status.list", {}, { limit: 2, cursor: "2" }));
    expect(itemsOf(rest).map((s) => s.name)).toEqual(["Done"]);
    expect(rest.nextCursor).toBeUndefined();
  });

  test("--project groups statuses per issue type and --issue-type narrows by name or id", async () => {
    respond({ "/rest/api/3/project/ABC/statuses": BY_TYPE });
    const all = itemsOf(await run("status.list", {}, { project: "ABC" }));
    expect(all.map((t) => t.issueTypes)).toEqual([["Bug"], ["Sub-task"]]);
    expect(all[1]?.statuses).toEqual([{ id: "1", name: "To Do", category: "new" }]);

    respond({ "/rest/api/3/project/ABC/statuses": BY_TYPE });
    const bug = itemsOf(await run("status.list", {}, { project: "ABC", issueType: "bug" }));
    expect(bug).toHaveLength(1);
    respond({ "/rest/api/3/project/ABC/statuses": BY_TYPE });
    const byId = itemsOf(await run("status.list", {}, { project: "ABC", issueType: "10002" }));
    expect(byId[0]?.issueTypes).toEqual(["Sub-task"]);
  });

  test("issue types sharing a status set collapse into one item; --full stays per type", async () => {
    const shared = [
      { id: "10001", name: "Bug", statuses: GLOBAL },
      { id: "10003", name: "Task", statuses: GLOBAL },
    ];
    respond({ "/rest/api/3/project/ABC/statuses": shared });
    const items = itemsOf(await run("status.list", {}, { project: "ABC" }));
    expect(items).toHaveLength(1);
    expect(items[0]?.issueTypes).toEqual(["Bug", "Task"]);

    respond({ "/rest/api/3/project/ABC/statuses": shared });
    const full = itemsOf(await run("status.list", {}, { project: "ABC" }, { full: true }));
    expect(full.map((t) => t.name)).toEqual(["Bug", "Task"]);
  });

  test("--status fetches one status and rejects combined filters", async () => {
    respond({ "/rest/api/3/status/In%20Review": GLOBAL[1] });
    expect(await run("status.list", {}, { status: "In Review" })).toEqual({
      items: [{ id: "2", name: "In Review", category: "indeterminate" }],
    });
    expect((await failure(run("status.list", {}, { status: "1", project: "ABC" }))).code).toBe(
      "conflicting_flags",
    );
    expect((await failure(run("status.list", {}, { issueType: "Bug" }))).code).toBe(
      "missing_project",
    );
  });
});

describe("component.list", () => {
  test("sends the filters and compacts components", async () => {
    respond({
      "/rest/api/3/project/ABC/component": {
        startAt: 0,
        total: 2,
        isLast: true,
        values: [
          {
            id: "1",
            name: "API",
            description: "Public API",
            lead: { accountId: "acc-1", displayName: "Ada" },
            assigneeType: "PROJECT_LEAD",
            assignee: { accountId: "acc-1", displayName: "Ada" },
          },
          { id: "2", name: "UI", assigneeType: "PROJECT_DEFAULT" },
        ],
      },
    });
    const result = await run(
      "component.list",
      { project: "ABC" },
      { query: "a", orderBy: "name", componentSource: "jira" },
    );
    expect(calls[0]?.query.get("query")).toBe("a");
    expect(calls[0]?.query.get("orderBy")).toBe("name");
    expect(calls[0]?.query.get("componentSource")).toBe("jira");
    expect(result).toEqual({
      items: [
        {
          id: "1",
          name: "API",
          lead: "Ada",
          assignee: "Ada",
          assigneeType: "PROJECT_LEAD",
          description: "Public API",
        },
        { id: "2", name: "UI" },
      ],
    });
  });

  test("--full keeps the raw page", async () => {
    const page = {
      startAt: 0,
      total: 1,
      isLast: true,
      values: [{ id: "1", name: "API", self: "x" }],
    };
    respond({ "/rest/api/3/project/ABC/component": page });
    const full = await run("component.list", { project: "ABC" }, {}, { full: true });
    expect(itemsOf(full)).toEqual(page.values);
  });
});

describe("version commands", () => {
  const VERSION = {
    id: "10000",
    name: "1.0",
    description: "First release",
    released: true,
    archived: false,
    overdue: false,
    startDate: "2026-09-01",
    releaseDate: "2026-10-01",
    projectId: 10000,
  };

  test("version.list passes filters and pages", async () => {
    respond({
      "/rest/api/3/project/ABC/version": {
        startAt: 0,
        total: 2,
        isLast: false,
        values: [VERSION],
      },
    });
    const result = recordOf(
      await run(
        "version.list",
        { project: "ABC" },
        {
          query: "1",
          status: "released,unreleased",
          orderBy: "-releaseDate",
          expand: "operations",
          limit: 1,
        },
      ),
    );
    expect(calls[0]?.query.get("status")).toBe("released,unreleased");
    expect(calls[0]?.query.get("orderBy")).toBe("-releaseDate");
    expect(calls[0]?.query.get("expand")).toBe("operations");
    expect(result.nextCursor).toBe("1");
    expect(itemsOf(result)).toEqual([
      {
        id: "10000",
        name: "1.0",
        released: true,
        startDate: "2026-09-01",
        releaseDate: "2026-10-01",
        description: "First release",
      },
    ]);
  });

  test("version.get returns one compact version with its project id", async () => {
    respond({ "/rest/api/3/version/10000": VERSION });
    expect(await run("version.get", { id: "10000" })).toEqual({
      id: "10000",
      name: "1.0",
      released: true,
      startDate: "2026-09-01",
      releaseDate: "2026-10-01",
      projectId: 10000,
      description: "First release",
    });
    respond({ "/rest/api/3/version/10000": VERSION });
    expect(await run("version.get", { id: "10000" }, {}, { full: true })).toEqual(VERSION);
  });

  test("version.get surfaces a 404 as an API error", async () => {
    respond({});
    expect((await failure(run("version.get", { id: "1" }))).category).toBe("api");
  });

  test("version.related-work.list compacts related work", async () => {
    respond({
      "/rest/api/3/version/10000/relatedwork": [
        { relatedWorkId: "r1", category: "Design", title: "Mock", url: "https://x.test/d" },
        { relatedWorkId: "r2", category: "Test plan", issueId: 10042 },
      ],
    });
    expect(await run("version.related-work.list", { id: "10000" })).toEqual({
      items: [
        { id: "r1", category: "Design", title: "Mock", url: "https://x.test/d" },
        { id: "r2", category: "Test plan", issueId: "10042" },
      ],
    });
  });
});

describe("filter.list", () => {
  const FILTER = {
    id: "1",
    name: "My open bugs",
    jql: "type = Bug AND resolution = Unresolved",
    owner: { accountId: "acc-1", displayName: "Ada" },
    favourite: true,
    description: "Triage",
  };

  test("searches with expand=jql,owner and maps filters to API names", async () => {
    respond({
      "/rest/api/3/filter/search": { startAt: 0, total: 1, isLast: true, values: [FILTER] },
    });
    const result = await run(
      "filter.list",
      {},
      {
        name: "bugs",
        projectId: 10000,
        account: "acc-1",
        id: "1,2",
        orderBy: "name",
        expand: "description",
      },
    );
    const query = calls[0]?.query;
    expect(query?.get("filterName")).toBe("bugs");
    expect(query?.get("projectId")).toBe("10000");
    expect(query?.get("accountId")).toBe("acc-1");
    expect(query?.getAll("id")).toEqual(["1", "2"]);
    expect(query?.get("expand")).toBe("jql,owner,description");
    expect(result).toEqual({
      items: [
        {
          id: "1",
          name: "My open bugs",
          jql: "type = Bug AND resolution = Unresolved",
          owner: "Ada",
          favourite: true,
          description: "Triage",
        },
      ],
    });
  });

  test("--mine uses /filter/my and rejects search flags", async () => {
    respond({ "/rest/api/3/filter/my": [FILTER] });
    const items = itemsOf(await run("filter.list", {}, { mine: true, favourites: true }));
    expect(calls[0]?.query.get("includeFavourites")).toBe("true");
    expect(items[0]?.id).toBe("1");
    expect((await failure(run("filter.list", {}, { mine: true, name: "x" }))).code).toBe(
      "conflicting_flags",
    );
    expect((await failure(run("filter.list", {}, { favourites: true }))).code).toBe(
      "invalid_flags",
    );
  });
});

describe("dashboard.list", () => {
  test("searches dashboards with the mapped query", async () => {
    respond({
      "/rest/api/3/dashboard/search": {
        startAt: 0,
        total: 1,
        isLast: true,
        values: [{ id: "10000", name: "Team", owner: { displayName: "Ada" }, isFavourite: true }],
      },
    });
    const result = await run(
      "dashboard.list",
      {},
      {
        name: "team",
        account: "acc-1",
        group: "devs",
        groupId: "g1",
        projectId: 5,
        status: "active",
        orderBy: "name",
      },
    );
    const query = calls[0]?.query;
    expect(query?.get("dashboardName")).toBe("team");
    expect(query?.get("accountId")).toBe("acc-1");
    expect(query?.get("groupname")).toBe("devs");
    expect(query?.get("groupId")).toBe("g1");
    expect(query?.get("projectId")).toBe("5");
    expect(query?.get("status")).toBe("active");
    expect(result).toEqual({
      items: [{ id: "10000", name: "Team", owner: "Ada", favourite: true }],
    });
  });

  test("--filter lists from /dashboard and rejects search flags", async () => {
    respond({
      "/rest/api/3/dashboard": {
        startAt: 0,
        total: 1,
        dashboards: [{ id: "10000", name: "Default dashboard", systemDashboard: true }],
      },
    });
    const result = await run("dashboard.list", {}, { filter: "my" });
    expect(calls[0]?.query.get("filter")).toBe("my");
    expect(result).toEqual({ items: [{ id: "10000", name: "Default dashboard", system: true }] });
    expect((await failure(run("dashboard.list", {}, { filter: "my", name: "x" }))).code).toBe(
      "conflicting_flags",
    );
  });
});

describe("property.get", () => {
  test("lists keys when no key is given", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/properties": { keys: [{ key: "a.b", self: "u" }, { key: "c" }] },
    });
    expect(await run("property.get", { entity: "issue", id: "ABC-123" })).toEqual({
      items: ["a.b", "c"],
    });
  });

  test("reads a value verbatim, keeping empty containers inside it", async () => {
    respond({
      "/rest/api/3/comment/77/properties/cfg": {
        key: "cfg",
        value: { list: [], flag: false, n: null },
      },
    });
    const result = await run("property.get", { entity: "comment", id: "77", key: "cfg" });
    expect(result).toEqual({ key: "cfg", value: { list: [], flag: false, n: null } });
  });

  test("builds the entity-specific paths", async () => {
    respond({
      "/rest/api/3/issue/ABC-123/worklog/9/properties": { keys: [] },
      "/rest/api/3/project/ABC/properties": { keys: [] },
      "/rest/api/3/dashboard/10000/items/5/properties/k": { key: "k", value: 1 },
    });
    await run("property.get", { entity: "worklog", id: "9" }, { issue: "ABC-123" });
    await run("property.get", { entity: "project", id: "ABC" });
    const item = await run(
      "property.get",
      { entity: "dashboard-item", id: "10000", key: "k" },
      { item: "5" },
    );
    expect(calls.map((c) => c.path)).toEqual([
      "/rest/api/3/issue/ABC-123/worklog/9/properties",
      "/rest/api/3/project/ABC/properties",
      "/rest/api/3/dashboard/10000/items/5/properties/k",
    ]);
    expect(item).toEqual({ key: "k", value: 1 });
  });

  test("rejects unknown entities and missing companion flags before any request", async () => {
    respond({});
    expect((await failure(run("property.get", { entity: "user", id: "x" }))).code).toBe(
      "invalid_entity",
    );
    expect((await failure(run("property.get", { entity: "worklog", id: "9" }))).code).toBe(
      "missing_flag",
    );
    expect((await failure(run("property.get", { entity: "dashboard-item", id: "1" }))).code).toBe(
      "missing_flag",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("lookups", () => {
  const LOOKUP_FIELDS = [
    { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
    {
      id: "customfield_10020",
      name: "Sprint",
      custom: true,
      schema: { type: "array", items: "json" },
    },
    { id: "labels", name: "Labels", custom: false, schema: { type: "array", items: "string" } },
  ];

  test("field.list shows type (array element type inline) and filters", async () => {
    respond({ "/rest/api/3/field": LOOKUP_FIELDS });
    expect(await run("field.list", {}, { custom: true })).toEqual({
      items: [{ id: "customfield_10020", name: "Sprint", type: "array<json>", custom: true }],
    });
    respond({ "/rest/api/3/field": LOOKUP_FIELDS });
    const byQuery = itemsOf(await run("field.list", {}, { query: "LAB" }));
    expect(byQuery).toEqual([{ id: "labels", name: "Labels", type: "array<string>" }]);
  });

  test("field.list pages client-side and rejects a bad cursor", async () => {
    respond({ "/rest/api/3/field": LOOKUP_FIELDS });
    const first = recordOf(await run("field.list", {}, { limit: 2 }));
    expect(first.nextCursor).toBe("2");
    respond({ "/rest/api/3/field": LOOKUP_FIELDS });
    expect(itemsOf(await run("field.list", {}, { limit: 2, cursor: "2" }))).toHaveLength(1);
    expect((await failure(run("field.list", {}, { cursor: "x" }))).code).toBe("invalid_cursor");
  });

  test("priority.list and resolution.list return id and name", async () => {
    respond({ "/rest/api/3/priority": [{ id: "1", name: "Highest", iconUrl: "x" }] });
    expect(await run("priority.list", {})).toEqual({ items: [{ id: "1", name: "Highest" }] });
    respond({
      "/rest/api/3/resolution/search": {
        startAt: 0,
        total: 2,
        isLast: true,
        values: [
          { id: "1", name: "Done", isDefault: true },
          { id: "2", name: "Won't Do", isDefault: false },
        ],
      },
    });
    expect(await run("resolution.list", {})).toEqual({
      items: [
        { id: "1", name: "Done", default: true },
        { id: "2", name: "Won't Do" },
      ],
    });
  });
});

describe("jql-check", () => {
  test("POSTs the queries to /jql/parse and flags invalid ones", async () => {
    respond({
      "/rest/api/3/jql/parse": {
        queries: [
          { query: "project = ABC", structure: { where: {} } },
          { query: "assignee =", errors: ["Error in the JQL Query: unexpected end"] },
        ],
      },
    });
    const result = await run("jql-check", {}, { validation: "warn" }, {}, [
      "project = ABC",
      "assignee =",
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.query.get("validation")).toBe("warn");
    expect(calls[0]?.body).toEqual({ queries: ["project = ABC", "assignee ="] });
    expect(result).toEqual({
      items: [
        { query: "project = ABC", ok: true },
        { query: "assignee =", errors: ["Error in the JQL Query: unexpected end"] },
      ],
    });
  });

  test("defaults to strict validation", async () => {
    respond({ "/rest/api/3/jql/parse": { queries: [] } });
    await run("jql-check", {}, {}, {}, ["x"]);
    expect(calls[0]?.query.get("validation")).toBe("strict");
  });
});

describe("jql-suggest", () => {
  test("--field returns values with tags stripped from labels", async () => {
    respond({
      "/rest/api/3/jql/autocompletedata/suggestions": {
        results: [
          { value: '"To Do"', displayName: "<b>T</b>o Do" },
          { value: "Done", displayName: "Done" },
        ],
      },
    });
    const result = await run(
      "jql-suggest",
      {},
      { field: "status", value: "T", predicate: "by", predicateValue: "a" },
    );
    const query = calls[0]?.query;
    expect(query?.get("fieldName")).toBe("status");
    expect(query?.get("fieldValue")).toBe("T");
    expect(query?.get("predicateName")).toBe("by");
    expect(query?.get("predicateValue")).toBe("a");
    expect(result).toEqual({ items: [{ value: '"To Do"', label: "To Do" }, { value: "Done" }] });
  });

  test("without --field lists searchable fields with operators, filtered by --query", async () => {
    respond({
      "/rest/api/3/jql/autocompletedata": {
        visibleFieldNames: [
          { value: "fixVersion", operators: ["=", "in"], auto: "true" },
          { value: "summary", operators: ["~"], auto: "false" },
        ],
      },
    });
    expect(await run("jql-suggest", {}, { query: "FIX" })).toEqual({
      items: [{ field: "fixVersion", operators: ["=", "in"], values: true }],
    });
    expect((await failure(run("jql-suggest", {}, { field: "status", query: "x" }))).code).toBe(
      "conflicting_flags",
    );
    expect((await failure(run("jql-suggest", {}, { value: "x" }))).code).toBe("conflicting_flags");
  });
});
