import { Type } from "../core/schema.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, inputError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import { splitList } from "../core/output.ts";
import { openSession, type Session } from "../core/session.ts";
import { parseJiraRef } from "../resolve/index.ts";
import {
  issueSession,
  jiraDeps,
  projectKey,
  resolveIssueType,
  resolvePriorityId,
  searchJql,
  type Transition,
} from "./jira.ts";
import {
  describeTransition,
  fetchTransitions,
  matchTransitions,
  transitionNames,
} from "./jira-write.ts";
import { applyArgvFor, isPlan, planOrSend, requireYes, YES_FLAG } from "./write.ts";

export const jiraBulkGroups: Readonly<Record<string, string>> = {
  bulk: "Bulk edit, transition, move, or delete Jira issues (async tasks, polled to a per-issue result)",
};

/** The bulk APIs accept at most this many issues per request. */
const MAX_ISSUES = 1000;
const SEARCH_PAGE = 100;
const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED", "DEAD"]);
const DEFAULT_WAIT_SECONDS = 120;
const FIRST_POLL_MS = 500;
const MAX_POLL_MS = 2000;

/** Test seam: replaces the real delay between task polls. */
export const jiraBulkDeps: { sleep?: ((ms: number) => Promise<void>) | undefined } = {};

const SELECTION_FLAGS = {
  jql: Type.Optional(
    Type.String({
      description: `JQL selecting the issues (alternative to listing keys; at most ${MAX_ISSUES})`,
    }),
  ),
};

const TASK_FLAGS = {
  wait: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: `Seconds to poll the bulk task for its final result (default ${DEFAULT_WAIT_SECONDS}; 0 returns right after submit)`,
    }),
  ),
  notify: Type.Optional(
    Type.Boolean({ description: "Send the bulk change notification email (default off)" }),
  ),
};

const KEYS_ARG = {
  name: "issues",
  description: "Issue keys or ids (omit when --jql is given)",
  variadic: true,
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface Selected {
  id: string;
  key: string;
}

/** Resolve a key list or a JQL to concrete issues (the task result reports numeric ids). */
async function selectIssues(
  session: Session,
  keys: readonly string[],
  jql: string | undefined,
): Promise<Selected[]> {
  if ((keys.length === 0) === (jql === undefined)) {
    throw inputError(
      "invalid_selection",
      "Pass either issue keys or --jql, not both and not neither",
      'Example: atl bulk edit KAN-1 KAN-2 --priority High, or atl bulk edit --jql "project = KAN AND labels = x" --priority High',
    );
  }
  const wanted = keys.map((input) => {
    const ref = parseJiraRef(input);
    return ref.key ?? ref.id ?? input;
  });
  const query = jql ?? `issuekey in (${wanted.join(", ")}) ORDER BY key ASC`;
  const paged = await searchJql<Selected>(
    session,
    { all: true, defaultLimit: MAX_ISSUES, maxPageSize: SEARCH_PAGE },
    query,
    "summary",
  );
  if (paged.nextCursor !== null) {
    throw inputError(
      "too_many_issues",
      `The selection matches more than ${MAX_ISSUES} issues, the bulk API limit`,
      "Narrow the JQL and run the command once per slice.",
    );
  }
  const found = paged.items.map(({ id, key }) => ({ id, key }));
  if (found.length === 0) {
    throw inputError("no_issues", "No issue matched the selection");
  }
  const present = new Set(found.flatMap((issue) => [issue.key.toUpperCase(), issue.id]));
  const missing = wanted.filter((key) => !present.has(key.toUpperCase()));
  if (missing.length > 0) {
    throw new AtlError(`Not found or not visible: ${missing.join(", ")}`, {
      code: "not_found",
      category: "api",
      hint: "Check the keys; nothing was changed.",
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Task submission and polling
// ---------------------------------------------------------------------------

interface BulkTask {
  taskId?: string;
  status?: string;
  progressPercent?: number;
  processedAccessibleIssues?: (number | string)[];
  failedAccessibleIssues?: Record<string, string[]>;
  invalidOrInaccessibleIssueCount?: number;
  totalIssueCount?: number;
}

/**
 * Per-issue result. The API lists processed ids, except for deletes, where the issues no longer
 * exist and the list is empty: a completed task then reports every selected issue minus the failures.
 */
function compactTask(task: BulkTask, names: ReadonlyMap<string, string>): Record<string, unknown> {
  const name = (id: string): string => names.get(id) ?? id;
  const failed = Object.entries(task.failedAccessibleIssues ?? {});
  const failedIds = new Set(failed.map(([id]) => id));
  const terminal = TERMINAL.has(task.status ?? "");
  const processed = (task.processedAccessibleIssues ?? []).map(String);
  const doneIds =
    task.status === "COMPLETE" && processed.length === 0 ? [...names.keys()] : processed;
  return {
    taskId: task.taskId,
    status: task.status,
    progress: terminal ? undefined : task.progressPercent,
    done: doneIds.filter((id) => !failedIds.has(id)).map(name),
    failed: failed.map(([id, errors]) => ({ key: name(id), errors })),
    invalid: task.invalidOrInaccessibleIssueCount,
    total: names.size === 0 ? task.totalIssueCount : undefined,
    next:
      terminal || task.taskId === undefined ? undefined : [["atl", "bulk", "status", task.taskId]],
  };
}

async function fetchTask(session: Session, taskId: string): Promise<BulkTask> {
  return session.http.request<BulkTask>({
    method: "GET",
    url: session.jiraUrl(`/rest/api/3/bulk/queue/${encodeURIComponent(taskId)}`),
  });
}

/** Poll until the task is terminal or `waitSeconds` of (nominal) delay have passed. */
async function pollTask(session: Session, taskId: string, waitSeconds: number): Promise<BulkTask> {
  let task = await fetchTask(session, taskId);
  let waited = 0;
  let delay = FIRST_POLL_MS;
  while (!TERMINAL.has(task.status ?? "") && waited < waitSeconds * 1000) {
    await (jiraBulkDeps.sleep ?? Bun.sleep)(delay);
    waited += delay;
    delay = Math.min(MAX_POLL_MS, Math.round(delay * 1.5));
    task = await fetchTask(session, taskId);
  }
  return task;
}

/**
 * Submit one bulk request; `--plan` returns the plan plus the resolved issues, otherwise the task
 * is polled and reported per issue.
 */
async function runBulk(
  ctx: CommandContext,
  session: Session,
  request: {
    path: string;
    body: unknown;
    destructive?: boolean;
    /** Extra fields for the plan and the compact result. */
    extra?: Record<string, unknown>;
  },
  selected: readonly Selected[],
  flags: { wait?: number | undefined },
): Promise<unknown> {
  const sent = await planOrSend<{ taskId?: string }>(
    ctx,
    session.http,
    { method: "POST", url: session.jiraUrl(request.path), body: request.body },
    [applyArgvFor(ctx, request.destructive === true)],
  );
  if (isPlan(sent)) {
    return {
      ...sent,
      count: selected.length,
      issues: selected.map((issue) => issue.key),
      ...request.extra,
    };
  }
  const taskId = sent.taskId;
  if (taskId === undefined) {
    throw new AtlError("The bulk request did not return a taskId", {
      code: "unexpected_response",
      category: "api",
    });
  }
  const task =
    flags.wait === 0
      ? { taskId, status: "ENQUEUED" }
      : await pollTask(session, taskId, flags.wait ?? DEFAULT_WAIT_SECONDS);
  if (ctx.full) {
    return { submitted: sent, task, issues: selected };
  }
  return {
    ...compactTask(task, await issueNames(session, task, selected)),
    ...request.extra,
  };
}

/**
 * Selected ids to keys, plus any other issue the task touched (Jira moves an issue's sub-tasks along
 * with it), so the per-issue result never mixes keys and numeric ids.
 */
async function issueNames(
  session: Session,
  task: BulkTask,
  selected: readonly Selected[],
): Promise<Map<string, string>> {
  const names = new Map(selected.map((issue) => [issue.id, issue.key]));
  const extra = [
    ...new Set([
      ...(task.processedAccessibleIssues ?? []).map(String),
      ...Object.keys(task.failedAccessibleIssues ?? {}),
    ]),
  ].filter((id) => !names.has(id));
  if (extra.length > 0) {
    const found = await searchJql<Selected>(
      session,
      { all: true, defaultLimit: MAX_ISSUES, maxPageSize: SEARCH_PAGE },
      `id in (${extra.join(", ")})`,
      "summary",
    );
    for (const issue of found.items) {
      names.set(issue.id, issue.key);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Issue types and move payloads
// ---------------------------------------------------------------------------

const MOVE_FLAGS = {
  type: Type.String({ description: "Target issue type name or id" }),
  parent: Type.Optional(
    Type.String({ description: "Target parent issue key (required to make a sub-task)" }),
  ),
  targetFieldsFile: Type.Optional(
    Type.String({
      description:
        "JSON file holding the API's targetMandatoryFields array, for mandatory fields of the target project (default: keep source values)",
    }),
  ),
  ...TASK_FLAGS,
};

async function readMandatoryFields(path: string | undefined): Promise<unknown> {
  if (path === undefined) {
    return undefined;
  }
  const text = await Bun.file(path)
    .text()
    .catch(() => {
      throw inputError("file_not_found", `Cannot read --target-fields-file ${path}`);
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    throw inputError(
      "invalid_target_fields",
      `--target-fields-file ${path} must hold a JSON array (the targetMandatoryFields value)`,
    );
  }
  return parsed;
}

/** One target group: `<project>,<issue type id>[,<parent>]` (the API's mapping key). */
async function moveRequest(
  session: Session,
  selected: readonly Selected[],
  target: {
    project: string;
    type: string;
    parent: string | undefined;
    fieldsFile: string | undefined;
  },
  notify: boolean | undefined,
): Promise<{ path: string; body: unknown }> {
  const project = projectKey(target.project);
  const type = await resolveIssueType(session, project, target.type);
  const typeId = type.id;
  const mandatory = await readMandatoryFields(target.fieldsFile);
  const parent = target.parent === undefined ? undefined : parseJiraRef(target.parent);
  const parentKey = parent === undefined ? undefined : (parent.key ?? parent.id ?? target.parent);
  if (type.subtask === true && parentKey === undefined) {
    throw inputError(
      "parent_required",
      `Issue type ${type.name ?? type.id} is a sub-task type and needs --parent`,
      "Pass --parent <issue key> for the sub-task's parent.",
    );
  }
  if (
    parentKey !== undefined &&
    selected.some(
      (issue) => issue.id === parentKey || issue.key.toUpperCase() === parentKey.toUpperCase(),
    )
  ) {
    throw inputError(
      "invalid_parent",
      `--parent ${parentKey} is one of the issues being moved`,
      "Pass a different issue as the parent.",
    );
  }
  const mappingKey = [project, typeId, ...(parentKey === undefined ? [] : [parentKey])].join(",");
  return {
    path: "/rest/api/3/bulk/issues/move",
    body: {
      sendBulkNotification: notify === true,
      targetToSourcesMapping: {
        [mappingKey]: {
          issueIdsOrKeys: selected.map((issue) => issue.key),
          inferFieldDefaults: mandatory === undefined,
          inferStatusDefaults: true,
          inferSubtaskTypeDefault: true,
          inferClassificationDefaults: true,
          ...(mandatory === undefined ? {} : { targetMandatoryFields: mandatory }),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// issue.convert
// ---------------------------------------------------------------------------

interface SourceIssue {
  id: string;
  key: string;
  fields?: { project?: { key?: string } };
}

const issueConvert = defineCommand({
  name: "issue.convert",
  summary:
    "Change an issue's type across hierarchy levels (task to sub-task under --parent, sub-task back to task) with the bulk move API; an issue with children needs --yes",
  mcpTools: ["convertJiraIssueHierarchy"],
  args: [{ name: "issue", description: "Issue key, id, URL, or ARI", required: true }],
  flags: Type.Object({
    ...MOVE_FLAGS,
    project: Type.Optional(
      Type.String({ description: "Target project key (default: the issue's own project)" }),
    ),
    yes: YES_FLAG,
  }),
  sideEffects: "write",
  examples: [
    "atl issue convert KAN-18 --type Subtask --parent KAN-7 --plan",
    "atl issue convert KAN-19 --type Task",
    "atl issue convert KAN-20 --type Task --yes",
  ],
  async run(ctx, input) {
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const source = await session.http.request<SourceIssue>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}`),
      query: { fields: "project" },
    });
    const project = input.flags.project ?? source.fields?.project?.key;
    if (project === undefined) {
      throw inputError(
        "project_unknown",
        `Cannot determine the project of ${rawKey}`,
        "Pass --project.",
      );
    }
    const selected = [{ id: source.id, key: source.key }];
    const request = await moveRequest(
      session,
      selected,
      {
        project,
        type: input.flags.type,
        parent: input.flags.parent,
        fieldsFile: input.flags.targetFieldsFile,
      },
      input.flags.notify,
    );
    // Children (an epic's issues, a task's sub-tasks) are detached or moved along by Jira.
    const children = await searchJql<Selected>(
      session,
      { all: true, defaultLimit: SEARCH_PAGE, maxPageSize: SEARCH_PAGE },
      `parent = ${source.key}`,
      "summary",
    );
    const affected = children.items.map((child) => child.key);
    if (affected.length > 0) {
      const shown = affected.slice(0, 10).join(", ");
      requireYes(
        ctx,
        input.flags.yes,
        `Converting ${rawKey}, which has ${children.nextCursor === null ? affected.length : `${affected.length}+`} child issue(s) (${shown}${affected.length > 10 ? ", ..." : ""}) that Jira detaches or moves along,`,
      );
    }
    return runBulk(
      ctx,
      session,
      {
        ...request,
        destructive: affected.length > 0,
        extra: affected.length > 0 ? { affectedChildren: affected } : {},
      },
      selected,
      input.flags,
    );
  },
});

// ---------------------------------------------------------------------------
// bulk.*
// ---------------------------------------------------------------------------

const bulkMove = defineCommand({
  name: "bulk.move",
  summary: "Move issues to one target project, issue type and optional parent (bulk move API)",
  args: [KEYS_ARG],
  flags: Type.Object({
    ...SELECTION_FLAGS,
    ...MOVE_FLAGS,
    project: Type.String({ description: "Target project key" }),
  }),
  sideEffects: "write",
  examples: [
    "atl bulk move KAN-1 KAN-2 --project OPS --type Task --plan",
    'atl bulk move --jql "project = KAN AND labels = ops" --project OPS --type Task',
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const selected = await selectIssues(session, input.rest, input.flags.jql);
    const request = await moveRequest(
      session,
      selected,
      {
        project: input.flags.project,
        type: input.flags.type,
        parent: input.flags.parent,
        fieldsFile: input.flags.targetFieldsFile,
      },
      input.flags.notify,
    );
    return runBulk(ctx, session, request, selected, input.flags);
  },
});

const LABEL_MODES = ["addLabels", "removeLabels", "setLabels", "clearLabels"] as const;

/** `--edit-file`: `{ editedFieldsInput, selectedActions }` in the API's own shape, merged under the flags. */
async function readEditFile(
  path: string | undefined,
): Promise<{ edited: Record<string, unknown>; actions: string[] }> {
  if (path === undefined) {
    return { edited: {}, actions: [] };
  }
  const text = await Bun.file(path)
    .text()
    .catch(() => {
      throw inputError("file_not_found", `Cannot read --edit-file ${path}`);
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const edited = isRecord(parsed) ? parsed.editedFieldsInput : undefined;
  const actions = isRecord(parsed) ? parsed.selectedActions : undefined;
  if (!isRecord(edited) || !Array.isArray(actions)) {
    throw inputError(
      "invalid_edit_file",
      `--edit-file ${path} must be {"editedFieldsInput": {...}, "selectedActions": ["fieldId", ...]}`,
      "Field ids and input shapes come from GET /rest/api/3/bulk/issues/fields.",
    );
  }
  return { edited, actions: actions.map(String) };
}

const bulkEdit = defineCommand({
  name: "bulk.edit",
  summary: "Edit priority, assignee or labels on many issues at once (bulk edit API)",
  args: [KEYS_ARG],
  flags: Type.Object({
    ...SELECTION_FLAGS,
    priority: Type.Optional(Type.String({ description: "Priority name or id" })),
    assignee: Type.Optional(
      Type.String({ description: "Assignee accountId, `none` to unassign, `auto` for automatic" }),
    ),
    addLabels: Type.Optional(Type.String({ description: "Comma-separated labels to add" })),
    removeLabels: Type.Optional(Type.String({ description: "Comma-separated labels to remove" })),
    setLabels: Type.Optional(
      Type.String({ description: "Comma-separated labels that replace all existing labels" }),
    ),
    clearLabels: Type.Optional(Type.Boolean({ description: "Remove every label" })),
    editFile: Type.Optional(
      Type.String({
        description:
          'JSON file {"editedFieldsInput": {...}, "selectedActions": [...]} for any other field (API shape)',
      }),
    ),
    ...TASK_FLAGS,
  }),
  sideEffects: "write",
  examples: [
    "atl bulk edit KAN-1 KAN-2 --priority High --add-labels triage --plan",
    'atl bulk edit --jql "project = KAN AND assignee is EMPTY" --assignee 5b10ac8d82e05b22cc7d4ef5',
  ],
  async run(ctx, input) {
    const { flags } = input;
    const labelModes = LABEL_MODES.filter((mode) => flags[mode] !== undefined);
    if (labelModes.length > 1) {
      throw inputError(
        "conflicting_label_flags",
        `Use one of --add-labels, --remove-labels, --set-labels, --clear-labels (got ${labelModes.length})`,
      );
    }
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const file = await readEditFile(flags.editFile);
    const edited: Record<string, unknown> = { ...file.edited };
    const actions = new Set(file.actions);
    if (flags.priority !== undefined) {
      edited.priority = { priorityId: await resolvePriorityId(session, flags.priority) };
      actions.add("priority");
    }
    if (flags.assignee !== undefined) {
      const text = flags.assignee.trim();
      const accountId = text.toLowerCase() === "auto" ? "-1" : text;
      edited.singleSelectClearableUserPickerFields = [
        {
          fieldId: "assignee",
          user: text.toLowerCase() === "none" ? null : { accountId },
        },
      ];
      actions.add("assignee");
    }
    const label = (option: string, names: string[]) => {
      edited.labelsFields = [
        {
          fieldId: "labels",
          bulkEditMultiSelectFieldOption: option,
          labels: names.map((name) => ({ name })),
        },
      ];
      actions.add("labels");
    };
    if (flags.addLabels !== undefined) {
      label("ADD", splitList(flags.addLabels));
    } else if (flags.removeLabels !== undefined) {
      label("REMOVE", splitList(flags.removeLabels));
    } else if (flags.setLabels !== undefined) {
      label("REPLACE", splitList(flags.setLabels));
    } else if (flags.clearLabels === true) {
      label("REMOVE_ALL", []);
    }
    if (actions.size === 0) {
      throw inputError(
        "nothing_to_edit",
        "No field to edit: pass --priority, --assignee, a label flag, or --edit-file",
      );
    }
    const selected = await selectIssues(session, input.rest, flags.jql);
    return runBulk(
      ctx,
      session,
      {
        path: "/rest/api/3/bulk/issues/fields",
        body: {
          editedFieldsInput: edited,
          selectedActions: [...actions],
          selectedIssueIdsOrKeys: selected.map((issue) => issue.key),
          sendBulkNotification: flags.notify === true,
        },
      },
      selected,
      flags,
    );
  },
});

interface TransitionGroups {
  availableTransitions?: {
    transitions?: {
      transitionId: number | string;
      transitionName?: string;
      to?: { statusName?: string };
    }[];
    issues?: string[];
  }[];
}

const bulkTransition = defineCommand({
  name: "bulk.transition",
  summary: "Move many issues through a workflow transition (bulk transition API)",
  args: [KEYS_ARG],
  flags: Type.Object({
    ...SELECTION_FLAGS,
    transition: Type.String({
      description: "Transition name, target status name (localized or English), or transition id",
    }),
    ...TASK_FLAGS,
  }),
  sideEffects: "write",
  examples: [
    'atl bulk transition KAN-1 KAN-2 --transition "In Progress" --plan',
    "atl bulk transition --jql \"project = KAN AND status = 'To Do'\" --transition Done",
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const selected = await selectIssues(session, input.rest, input.flags.jql);
    const wanted = input.flags.transition;
    const inputs: { selectedIssueIdsOrKeys: string[]; transitionId: string }[] = [];
    const unmatched: string[] = [];
    const offered = new Set<string>();
    for (let at = 0; at < selected.length; at += SEARCH_PAGE) {
      const chunk = selected.slice(at, at + SEARCH_PAGE);
      const groups = await session.http.request<TransitionGroups>({
        method: "GET",
        url: session.jiraUrl("/rest/api/3/bulk/issues/transition"),
        query: { issueIdsOrKeys: chunk.map((issue) => issue.key) },
      });
      for (const group of groups.availableTransitions ?? []) {
        // The bulk API always answers in English; the account's language is looked up from one
        // issue of the group (same workflow, same transition ids) only when English did not match.
        const english: Transition[] = [];
        for (const transition of group.transitions ?? []) {
          english.push({
            id: String(transition.transitionId),
            ...(transition.transitionName === undefined ? {} : { name: transition.transitionName }),
            ...(transition.to?.statusName === undefined
              ? {}
              : { to: { name: transition.to.statusName } }),
          });
        }
        let candidates = transitionNames(english, english);
        let match = matchTransitions(candidates, wanted)[0];
        const sample = group.issues?.[0];
        if (match === undefined && sample !== undefined) {
          const localized = await fetchTransitions(session, encodeURIComponent(sample), false);
          candidates = transitionNames(localized, english);
          match = matchTransitions(candidates, wanted)[0];
        }
        for (const candidate of candidates) {
          offered.add(describeTransition(candidate));
        }
        if (match === undefined) {
          unmatched.push(...(group.issues ?? []));
        } else {
          inputs.push({ selectedIssueIdsOrKeys: group.issues ?? [], transitionId: match.id });
        }
      }
    }
    if (unmatched.length > 0) {
      throw new AtlError(
        `Transition "${input.flags.transition}" is not available for ${unmatched.join(", ")}. Offered: ${[...offered].join("; ")}`,
        {
          code: "transition_unavailable",
          category: "input",
          hint: "Nothing was changed. Select only issues in workflows that offer this transition.",
        },
      );
    }
    return runBulk(
      ctx,
      session,
      {
        path: "/rest/api/3/bulk/issues/transition",
        body: { bulkTransitionInputs: inputs, sendBulkNotification: input.flags.notify === true },
      },
      selected,
      input.flags,
    );
  },
});

const bulkDelete = defineCommand({
  name: "bulk.delete",
  summary: "Delete many issues permanently (bulk delete API); needs --yes",
  args: [KEYS_ARG],
  flags: Type.Object({ ...SELECTION_FLAGS, ...TASK_FLAGS, yes: YES_FLAG }),
  sideEffects: "write",
  examples: [
    "atl bulk delete KAN-1 KAN-2 --plan",
    'atl bulk delete --jql "project = KAN AND labels = scratch" --yes',
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const selected = await selectIssues(session, input.rest, input.flags.jql);
    requireYes(ctx, input.flags.yes, `DELETE ${selected.length} issue(s)`);
    return runBulk(
      ctx,
      session,
      {
        path: "/rest/api/3/bulk/issues/delete",
        destructive: true,
        body: {
          selectedIssueIdsOrKeys: selected.map((issue) => issue.key),
          sendBulkNotification: input.flags.notify === true,
        },
      },
      selected,
      input.flags,
    );
  },
});

const bulkStatus = defineCommand({
  name: "bulk.status",
  summary: "Progress and per-issue result of a bulk task (issues are reported by id)",
  args: [{ name: "taskId", description: "Task id returned by a bulk command", required: true }],
  flags: Type.Object({
    wait: TASK_FLAGS.wait,
  }),
  sideEffects: "none",
  examples: ["atl bulk status 10779", "atl bulk status 10779 --wait 60"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const task = await pollTask(session, input.args.taskId ?? "", input.flags.wait ?? 0);
    return ctx.full ? task : compactTask(task, new Map());
  },
});

export const jiraBulkCommands: readonly CommandSpec[] = [
  issueConvert,
  bulkEdit,
  bulkTransition,
  bulkMove,
  bulkDelete,
  bulkStatus,
];
