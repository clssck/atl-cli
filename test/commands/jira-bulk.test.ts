import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraBulkCommands, jiraBulkDeps } from "../../src/commands/jira-bulk.ts";
import { jiraDeps } from "../../src/commands/jira.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { prune } from "../../src/core/output.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const PREFIX = `/ex/jira/${CLOUD}`;

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Body = object | ((sent: Sent) => object);

let root: string;
let env: NodeJS.ProcessEnv;
let sent: Sent[];
let delays: number[];

/** Routes keyed `METHOD /path` relative to the Jira base; a function reply sees the request. */
function serve(routes: Record<string, Body | Body[]>): void {
  const counters = new Map<string, number>();
  jiraDeps.fetch = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.slice(PREFIX.length);
    const request: Sent = {
      method,
      path,
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    const key = `${method} ${path}`;
    const route = routes[key];
    if (route === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ errorMessages: [`no route ${key}`] }), { status: 404 }),
      );
    }
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const reply = Array.isArray(route) ? (route[Math.min(index, route.length - 1)] ?? {}) : route;
    const body = typeof reply === "function" ? reply(request) : reply;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

const writes = () => sent.filter((s) => s.method !== "GET");

function command(name: string): CommandSpec {
  const spec = jiraBulkCommands.find((c) => c.name === name);
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
  const result = await command(name).run(makeContext(env, options.ctx), {
    args,
    rest: options.rest ?? [],
    flags,
  });
  return options.ctx?.full === true ? result : prune(result);
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

const issues = (...keys: string[]) => ({
  issues: keys.map((key) => ({ id: String(10000 + Number(key.split("-")[1])), key })),
  isLast: true,
});

const SEARCH = "GET /rest/api/3/search/jql";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-jira-bulk-test-"));
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
  delays = [];
  jiraBulkDeps.sleep = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
});

afterEach(async () => {
  jiraDeps.fetch = undefined;
  jiraBulkDeps.sleep = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("bulk.edit", () => {
  test("resolves keys, posts the edit payload, polls, and reports done keys", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "GET /rest/api/3/priority": [
        [
          { id: "1", name: "Highest" },
          { id: "2", name: "High" },
        ],
      ],
      "POST /rest/api/3/bulk/issues/fields": { taskId: "77" },
      "GET /rest/api/3/bulk/queue/77": [
        { taskId: "77", status: "RUNNING", progressPercent: 40 },
        {
          taskId: "77",
          status: "COMPLETE",
          progressPercent: 100,
          processedAccessibleIssues: [10001, 10002],
          invalidOrInaccessibleIssueCount: 0,
        },
      ],
    });
    const result = await run(
      "bulk.edit",
      {},
      { priority: "high", addLabels: "triage, web" },
      { rest: ["KAN-1", "KAN-2"] },
    );
    expect(sent.find((s) => s.path.endsWith("/search/jql"))?.query.get("jql")).toBe(
      "issuekey in (KAN-1, KAN-2) ORDER BY key ASC",
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.body).toEqual({
      editedFieldsInput: {
        priority: { priorityId: "2" },
        labelsFields: [
          {
            fieldId: "labels",
            bulkEditMultiSelectFieldOption: "ADD",
            labels: [{ name: "triage" }, { name: "web" }],
          },
        ],
      },
      selectedActions: ["priority", "labels"],
      selectedIssueIdsOrKeys: ["KAN-1", "KAN-2"],
      sendBulkNotification: false,
    });
    expect(delays).toEqual([500]);
    expect(result).toEqual({
      taskId: "77",
      status: "COMPLETE",
      done: ["KAN-1", "KAN-2"],
      invalid: 0,
    });
  });

  test("assignee none sends a null user, auto sends -1", async () => {
    serve({
      [SEARCH]: issues("KAN-1"),
      "POST /rest/api/3/bulk/issues/fields": { taskId: "1" },
      "GET /rest/api/3/bulk/queue/1": { taskId: "1", status: "COMPLETE" },
    });
    await run("bulk.edit", {}, { assignee: "none" }, { rest: ["KAN-1"] });
    await run("bulk.edit", {}, { assignee: "auto" }, { rest: ["KAN-1"] });
    expect(writes().map((w) => (isRecord(w.body) ? w.body.editedFieldsInput : undefined))).toEqual([
      { singleSelectClearableUserPickerFields: [{ fieldId: "assignee", user: null }] },
      {
        singleSelectClearableUserPickerFields: [{ fieldId: "assignee", user: { accountId: "-1" } }],
      },
    ]);
  });

  test("--jql selects the issues and --plan sends nothing but lists them", async () => {
    serve({ [SEARCH]: issues("KAN-5", "KAN-6", "KAN-7") });
    const result = await run(
      "bulk.edit",
      {},
      { jql: "project = KAN", clearLabels: true },
      {
        ctx: {
          plan: true,
          argv: ["bulk", "edit", "--jql", "project = KAN", "--clear-labels", "--plan"],
        },
      },
    );
    expect(sent.find((s) => s.path.endsWith("/search/jql"))?.query.get("jql")).toBe(
      "project = KAN",
    );
    expect(writes()).toHaveLength(0);
    expect(result).toMatchObject({
      type: "plan",
      method: "POST",
      count: 3,
      issues: ["KAN-5", "KAN-6", "KAN-7"],
      next: [["atl", "bulk", "edit", "--jql", "project = KAN", "--clear-labels"]],
    });
  });

  test("per-issue failures are reported by key", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "GET /rest/api/3/priority": [[{ id: "2", name: "High" }]],
      "POST /rest/api/3/bulk/issues/fields": { taskId: "9" },
      "GET /rest/api/3/bulk/queue/9": {
        taskId: "9",
        status: "COMPLETE",
        processedAccessibleIssues: [10001, 10002],
        failedAccessibleIssues: { "10002": ["Field is required"] },
        invalidOrInaccessibleIssueCount: 1,
      },
    });
    const reported = await run("bulk.edit", {}, { priority: "2" }, { rest: ["KAN-1", "KAN-2"] });
    expect(reported).toEqual({
      taskId: "9",
      status: "COMPLETE",
      done: ["KAN-1"],
      failed: [{ key: "KAN-2", errors: ["Field is required"] }],
      invalid: 1,
    });
  });

  test("--wait timeout returns progress with a status next command", async () => {
    serve({
      [SEARCH]: issues("KAN-1"),
      "POST /rest/api/3/bulk/issues/fields": { taskId: "5" },
      "GET /rest/api/3/bulk/queue/5": { taskId: "5", status: "RUNNING", progressPercent: 10 },
    });
    const result = await run("bulk.edit", {}, { clearLabels: true, wait: 1 }, { rest: ["KAN-1"] });
    expect(result).toMatchObject({
      taskId: "5",
      status: "RUNNING",
      progress: 10,
      next: [["atl", "bulk", "status", "5"]],
    });
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  });

  test("--wait 0 returns right after submit without polling", async () => {
    serve({
      [SEARCH]: issues("KAN-1"),
      "POST /rest/api/3/bulk/issues/fields": { taskId: "5" },
    });
    const result = await run("bulk.edit", {}, { clearLabels: true, wait: 0 }, { rest: ["KAN-1"] });
    expect(result).toMatchObject({ taskId: "5", status: "ENQUEUED" });
    expect(sent.some((s) => s.path.includes("/bulk/queue/"))).toBe(false);
  });

  test("--full returns the raw submit response, final task and resolved issues", async () => {
    serve({
      [SEARCH]: issues("KAN-1"),
      "POST /rest/api/3/bulk/issues/fields": { taskId: "5" },
      "GET /rest/api/3/bulk/queue/5": { taskId: "5", status: "COMPLETE", totalIssueCount: 1 },
    });
    const result = await run(
      "bulk.edit",
      {},
      { clearLabels: true },
      { rest: ["KAN-1"], ctx: { full: true } },
    );
    expect(result).toEqual({
      submitted: { taskId: "5" },
      task: { taskId: "5", status: "COMPLETE", totalIssueCount: 1 },
      issues: [{ id: "10001", key: "KAN-1" }],
    });
  });

  test("rejects an empty edit, both selections, and conflicting label flags", async () => {
    serve({ [SEARCH]: issues("KAN-1") });
    expect((await failure(run("bulk.edit", {}, {}, { rest: ["KAN-1"] }))).code).toBe(
      "nothing_to_edit",
    );
    expect(
      (
        await failure(
          run("bulk.edit", {}, { clearLabels: true, jql: "x = 1" }, { rest: ["KAN-1"] }),
        )
      ).code,
    ).toBe("invalid_selection");
    expect(
      (
        await failure(
          run("bulk.edit", {}, { addLabels: "a", removeLabels: "b" }, { rest: ["KAN-1"] }),
        )
      ).code,
    ).toBe("conflicting_label_flags");
    expect(writes()).toHaveLength(0);
  });

  test("an unresolvable key aborts before any write", async () => {
    serve({ [SEARCH]: issues("KAN-1") });
    const error = await failure(
      run("bulk.edit", {}, { clearLabels: true }, { rest: ["KAN-1", "KAN-404"] }),
    );
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("KAN-404");
    expect(writes()).toHaveLength(0);
  });

  test("a selection larger than the bulk limit is refused", async () => {
    serve({
      [SEARCH]: (request: Sent) => ({
        issues: Array.from({ length: 100 }, (_, i) => ({ id: String(i), key: `KAN-${i}` })),
        nextPageToken: `t${request.query.get("nextPageToken") ?? ""}x`,
        isLast: false,
      }),
    });
    const error = await failure(run("bulk.edit", {}, { clearLabels: true, jql: "project = KAN" }));
    expect(error.code).toBe("too_many_issues");
  });
});

describe("bulk.transition", () => {
  const GROUPS = {
    availableTransitions: [
      {
        transitions: [
          { transitionId: 11, transitionName: "To Do", to: { statusName: "To Do" } },
          { transitionId: 21, transitionName: "Start", to: { statusName: "In Progress" } },
        ],
        issues: ["KAN-1", "KAN-2"],
      },
    ],
  };

  test("matches the transition by target status and posts bulkTransitionInputs", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "GET /rest/api/3/bulk/issues/transition": GROUPS,
      "POST /rest/api/3/bulk/issues/transition": { taskId: "3" },
      "GET /rest/api/3/bulk/queue/3": {
        taskId: "3",
        status: "COMPLETE",
        processedAccessibleIssues: [10001, 10002],
      },
    });
    const result = await run(
      "bulk.transition",
      {},
      { transition: "in progress" },
      { rest: ["KAN-1", "KAN-2"] },
    );
    expect(
      sent.find((s) => s.path.endsWith("/bulk/issues/transition"))?.query.getAll("issueIdsOrKeys"),
    ).toEqual(["KAN-1", "KAN-2"]);
    expect(writes()[0]?.body).toEqual({
      bulkTransitionInputs: [{ selectedIssueIdsOrKeys: ["KAN-1", "KAN-2"], transitionId: "21" }],
      sendBulkNotification: false,
    });
    expect(result).toMatchObject({ status: "COMPLETE", done: ["KAN-1", "KAN-2"] });
  });

  test("an unavailable transition names the offered ones in both languages and sends nothing", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "GET /rest/api/3/bulk/issues/transition": GROUPS,
      "GET /rest/api/3/issue/KAN-1/transitions": {
        transitions: [
          { id: "11", name: "Elintézendő", to: { name: "Teendő" } },
          { id: "21", name: "Indítás", to: { name: "Folyamatban" } },
        ],
      },
    });
    const error = await failure(
      run("bulk.transition", {}, { transition: "Done" }, { rest: ["KAN-1", "KAN-2"] }),
    );
    expect(error.code).toBe("transition_unavailable");
    expect(error.message).toContain("Elintézendő / To Do (11 -> Teendő / To Do)");
    expect(error.message).toContain("Indítás / Start (21 -> Folyamatban / In Progress)");
    expect(writes()).toHaveLength(0);
  });

  test("localized transition and status names match like the English ones", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "GET /rest/api/3/bulk/issues/transition": GROUPS,
      "GET /rest/api/3/issue/KAN-1/transitions": {
        transitions: [
          { id: "11", name: "Elintézendő", to: { name: "Teendő" } },
          { id: "21", name: "Indítás", to: { name: "Folyamatban" } },
        ],
      },
      "POST /rest/api/3/bulk/issues/transition": { taskId: "3" },
      "GET /rest/api/3/bulk/queue/3": {
        taskId: "3",
        status: "COMPLETE",
        processedAccessibleIssues: [10001, 10002],
      },
    });
    for (const transition of ["Folyamatban", "indítás"]) {
      await run("bulk.transition", {}, { transition }, { rest: ["KAN-1", "KAN-2"] });
    }
    expect(writes().map((w) => w.body)).toEqual([
      {
        bulkTransitionInputs: [{ selectedIssueIdsOrKeys: ["KAN-1", "KAN-2"], transitionId: "21" }],
        sendBulkNotification: false,
      },
      {
        bulkTransitionInputs: [{ selectedIssueIdsOrKeys: ["KAN-1", "KAN-2"], transitionId: "21" }],
        sendBulkNotification: false,
      },
    ]);
  });
});

describe("bulk.delete", () => {
  test("needs --yes, but plans without it", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "POST /rest/api/3/bulk/issues/delete": { taskId: "8" },
      "GET /rest/api/3/bulk/queue/8": {
        taskId: "8",
        status: "COMPLETE",
        processedAccessibleIssues: [],
        failedAccessibleIssues: {},
      },
    });
    const gated = await failure(
      run(
        "bulk.delete",
        {},
        {},
        { rest: ["KAN-1", "KAN-2"], ctx: { argv: ["bulk", "delete", "KAN-1", "KAN-2"] } },
      ),
    );
    expect(gated.code).toBe("confirmation_required");
    expect(writes()).toHaveLength(0);

    const planned = await run(
      "bulk.delete",
      {},
      {},
      {
        rest: ["KAN-1", "KAN-2"],
        ctx: { plan: true, argv: ["bulk", "delete", "KAN-1", "KAN-2", "--plan"] },
      },
    );
    expect(planned).toMatchObject({
      type: "plan",
      count: 2,
      next: [["atl", "bulk", "delete", "KAN-1", "KAN-2", "--yes"]],
    });
    expect(writes()).toHaveLength(0);

    const deleted = await run("bulk.delete", {}, { yes: true }, { rest: ["KAN-1", "KAN-2"] });
    expect(writes()[0]?.body).toEqual({
      selectedIssueIdsOrKeys: ["KAN-1", "KAN-2"],
      sendBulkNotification: false,
    });
    expect(deleted).toEqual({
      taskId: "8",
      status: "COMPLETE",
      done: ["KAN-1", "KAN-2"],
    });
  });
});

describe("bulk.move and issue.convert", () => {
  const TYPES = {
    isLast: true,
    issueTypes: [
      { id: "10002", name: "Subtask", subtask: true },
      { id: "10003", name: "Task" },
    ],
  };

  test("issue.convert targets the issue's own project, the type id and the parent", async () => {
    serve({
      "GET /rest/api/3/issue/KAN-9": {
        id: "10009",
        key: "KAN-9",
        fields: { project: { key: "KAN" } },
      },
      "GET /rest/api/3/issue/createmeta/KAN/issuetypes": TYPES,
      [SEARCH]: { issues: [], isLast: true },
      "POST /rest/api/3/bulk/issues/move": { taskId: "4" },
      "GET /rest/api/3/bulk/queue/4": {
        taskId: "4",
        status: "COMPLETE",
        processedAccessibleIssues: [10009],
      },
    });
    const result = await run(
      "issue.convert",
      { issue: "KAN-9" },
      { type: "subtask", parent: "KAN-1" },
    );
    expect(writes()[0]?.body).toEqual({
      sendBulkNotification: false,
      targetToSourcesMapping: {
        "KAN,10002,KAN-1": {
          issueIdsOrKeys: ["KAN-9"],
          inferFieldDefaults: true,
          inferStatusDefaults: true,
          inferSubtaskTypeDefault: true,
          inferClassificationDefaults: true,
        },
      },
    });
    expect(result).toMatchObject({ status: "COMPLETE", done: ["KAN-9"] });
  });

  test("issue.convert without a parent omits it from the mapping key; --plan sends nothing", async () => {
    serve({
      "GET /rest/api/3/issue/KAN-9": {
        id: "10009",
        key: "KAN-9",
        fields: { project: { key: "KAN" } },
      },
      "GET /rest/api/3/issue/createmeta/KAN/issuetypes": TYPES,
      [SEARCH]: { issues: [], isLast: true },
    });
    const result = await run(
      "issue.convert",
      { issue: "KAN-9" },
      { type: "Task" },
      { ctx: { plan: true, argv: ["issue", "convert", "KAN-9", "--type", "Task", "--plan"] } },
    );
    expect(writes()).toHaveLength(0);
    expect(JSON.stringify(result)).toContain("KAN,10003");
    expect(result).toMatchObject({
      type: "plan",
      next: [["atl", "issue", "convert", "KAN-9", "--type", "Task"]],
    });
  });

  test("a sub-task target type without --parent, or a parent that is the issue itself, is refused and nothing is written", async () => {
    serve({
      "GET /rest/api/3/issue/KAN-9": {
        id: "10009",
        key: "KAN-9",
        fields: { project: { key: "KAN" } },
      },
      "GET /rest/api/3/issue/createmeta/KAN/issuetypes": TYPES,
    });
    const missing = await failure(run("issue.convert", { issue: "KAN-9" }, { type: "Subtask" }));
    expect(missing.code).toBe("parent_required");
    expect(missing.category).toBe("input");
    const self = await failure(
      run("issue.convert", { issue: "KAN-9" }, { type: "Subtask", parent: "kan-9" }),
    );
    expect(self.code).toBe("invalid_parent");
    expect(writes()).toHaveLength(0);
  });

  test("an issue with children needs --yes; the plan lists them, the result reports them", async () => {
    serve({
      "GET /rest/api/3/issue/KAN-9": {
        id: "10009",
        key: "KAN-9",
        fields: { project: { key: "KAN" } },
      },
      "GET /rest/api/3/issue/createmeta/KAN/issuetypes": TYPES,
      [SEARCH]: (request: Sent) =>
        request.query.get("jql") === "parent = KAN-9" ? issues("KAN-10", "KAN-11") : { issues: [] },
      "POST /rest/api/3/bulk/issues/move": { taskId: "4" },
      "GET /rest/api/3/bulk/queue/4": {
        taskId: "4",
        status: "COMPLETE",
        processedAccessibleIssues: [10009],
      },
    });
    const argv = ["issue", "convert", "KAN-9", "--type", "Task"];
    const gated = await failure(
      run("issue.convert", { issue: "KAN-9" }, { type: "Task" }, { ctx: { argv } }),
    );
    expect(gated.code).toBe("confirmation_required");
    expect(gated.message).toContain("KAN-10, KAN-11");
    expect(writes()).toHaveLength(0);

    const plan = await run(
      "issue.convert",
      { issue: "KAN-9" },
      { type: "Task" },
      { ctx: { plan: true, argv: [...argv, "--plan"] } },
    );
    expect(plan).toMatchObject({
      type: "plan",
      affectedChildren: ["KAN-10", "KAN-11"],
      next: [["atl", ...argv, "--yes"]],
    });
    expect(writes()).toHaveLength(0);

    const result = await run("issue.convert", { issue: "KAN-9" }, { type: "Task", yes: true });
    expect(result).toMatchObject({
      status: "COMPLETE",
      done: ["KAN-9"],
      affectedChildren: ["KAN-10", "KAN-11"],
    });
  });

  test("ids Jira reports beyond the selection (moved sub-tasks) are mapped to keys", async () => {
    serve({
      "GET /rest/api/3/issue/KAN-9": {
        id: "10009",
        key: "KAN-9",
        fields: { project: { key: "KAN" } },
      },
      "GET /rest/api/3/issue/createmeta/KAN/issuetypes": TYPES,
      [SEARCH]: (request: Sent) =>
        request.query.get("jql") === "id in (10314)"
          ? { issues: [{ id: "10314", key: "KAN-14" }], isLast: true }
          : { issues: [], isLast: true },
      "POST /rest/api/3/bulk/issues/move": { taskId: "4" },
      "GET /rest/api/3/bulk/queue/4": {
        taskId: "4",
        status: "COMPLETE",
        processedAccessibleIssues: [10009, 10314],
      },
    });
    const result = await run(
      "issue.convert",
      { issue: "KAN-9" },
      { type: "subtask", parent: "KAN-1" },
    );
    expect(result).toMatchObject({ done: ["KAN-9", "KAN-14"] });
  });

  test("an unknown target type lists the available names", async () => {
    serve({
      "GET /rest/api/3/issue/KAN-9": {
        id: "10009",
        key: "KAN-9",
        fields: { project: { key: "KAN" } },
      },
      "GET /rest/api/3/issue/createmeta/KAN/issuetypes": TYPES,
    });
    const error = await failure(run("issue.convert", { issue: "KAN-9" }, { type: "Epic" }));
    expect(error.code).toBe("unknown_issue_type");
    expect(error.message).toContain("Subtask, Task");
  });

  test("bulk.move maps every selected issue to the target project and type", async () => {
    serve({
      [SEARCH]: issues("KAN-1", "KAN-2"),
      "GET /rest/api/3/issue/createmeta/OPS/issuetypes": TYPES,
      "POST /rest/api/3/bulk/issues/move": { taskId: "6" },
      "GET /rest/api/3/bulk/queue/6": {
        taskId: "6",
        status: "COMPLETE",
        processedAccessibleIssues: [10001, 10002],
      },
    });
    await run(
      "bulk.move",
      {},
      { project: "OPS", type: "10003", notify: true },
      { rest: ["KAN-1", "KAN-2"] },
    );
    expect(writes()[0]?.body).toMatchObject({
      sendBulkNotification: true,
      targetToSourcesMapping: { "OPS,10003": { issueIdsOrKeys: ["KAN-1", "KAN-2"] } },
    });
  });
});

describe("bulk.status", () => {
  test("reports a running task with progress and the follow-up command", async () => {
    serve({
      "GET /rest/api/3/bulk/queue/12": { taskId: "12", status: "RUNNING", progressPercent: 65 },
    });
    expect(await run("bulk.status", { taskId: "12" })).toEqual({
      taskId: "12",
      status: "RUNNING",
      progress: 65,
      next: [["atl", "bulk", "status", "12"]],
    });
  });

  test("a finished task lists processed issues by id and failures", async () => {
    serve({
      "GET /rest/api/3/bulk/queue/12": {
        taskId: "12",
        status: "COMPLETE",
        totalIssueCount: 2,
        processedAccessibleIssues: [10001, 10002],
        failedAccessibleIssues: { "10002": ["nope"] },
        invalidOrInaccessibleIssueCount: 0,
      },
    });
    expect(await run("bulk.status", { taskId: "12" })).toEqual({
      taskId: "12",
      status: "COMPLETE",
      done: ["10001"],
      failed: [{ key: "10002", errors: ["nope"] }],
      invalid: 0,
      total: 2,
    });
  });
});
