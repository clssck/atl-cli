import { Type } from "../core/schema.ts";
import { markdownToAdf } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, type NextCommand } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { HttpClient } from "../core/http.ts";
import { openSession, type Session } from "../core/session.ts";
import { parseJiraRef } from "../resolve/index.ts";
import {
  compactComment,
  compactIssue,
  DEFAULT_ISSUE_FIELDS,
  ISSUE_ARG,
  issueSession,
  jiraDeps,
  type JiraComment,
  type JiraIssue,
  type Transition,
} from "./jira.ts";
import { ADF_FORMAT_FLAG, shortTs } from "./common.ts";
import {
  applyArgv,
  BODY_FLAGS,
  COMMENT_FLAGS,
  jiraBody,
  loadBody,
  loadComment,
  planOrSend,
  requireBody,
  type Plan,
  type PlannedRequest,
} from "./write.ts";

// ---------------------------------------------------------------------------
// Shared flags and helpers
// ---------------------------------------------------------------------------

const FIELD_FLAGS = {
  set: Type.Optional(
    Type.Array(Type.String(), {
      description: "field=value; value is JSON when it parses, else a string. Repeatable",
    }),
  ),
  fieldsFile: Type.Optional(
    Type.String({ description: "JSON file with an object of fields to merge (before --set)" }),
  ),
};

const VISIBILITY_FLAGS = {
  visibilityType: Type.Optional(
    Type.Union([Type.Literal("group"), Type.Literal("role")], {
      description: "Restrict visibility to a group or project role (needs --visibility)",
    }),
  ),
  visibility: Type.Optional(
    Type.String({ description: "Group or role name for --visibility-type" }),
  ),
};

/** Fields whose Jira v3 value is an ADF document; plain strings are treated as markdown. */
const RICH_TEXT_FIELDS: ReadonlySet<string> = new Set(["description", "environment"]);

const ISSUE_ID = /^\d+$/;

function inputError(code: string, message: string, hint?: string): AtlError {
  return new AtlError(message, {
    code,
    category: "input",
    ...(hint === undefined ? {} : { hint }),
  });
}

function isPlan(value: unknown): value is Plan {
  return isRecord(value) && value.type === "plan";
}

async function readJsonObject(path: string, flag: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(path)
    .text()
    .catch((cause: unknown) => {
      throw new AtlError(`Cannot read ${flag} ${path}`, {
        code: "input_file_unreadable",
        category: "input",
        cause,
      });
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new AtlError(`${flag} ${path} is not valid JSON`, {
      code: "invalid_json_file",
      category: "input",
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw inputError("invalid_json_file", `${flag} ${path} must contain a JSON object`);
  }
  return parsed;
}

function tryParseJson(raw: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return undefined;
  }
}

/** One `--set field=value` value: JSON when it parses, else a string; summary is always text. */
function fieldValue(name: string, raw: string): unknown {
  if (name === "summary") {
    return raw;
  }
  const parsed = tryParseJson(raw);
  if (RICH_TEXT_FIELDS.has(name)) {
    if (parsed !== undefined && (parsed.value === null || isRecord(parsed.value))) {
      return parsed.value;
    }
    return markdownToAdf(raw);
  }
  return parsed === undefined ? raw : parsed.value;
}

/** Parse repeated `--set field=value` entries; the last entry for a field wins. */
function parseSet(entries: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    const name = equals === -1 ? "" : entry.slice(0, equals).trim();
    if (name === "") {
      throw inputError(
        "invalid_set",
        `--set expects field=value, got "${entry}"`,
        'Example: --set labels=\'["a","b"]\' or --set priority=\'{"name":"High"}\'.',
      );
    }
    fields[name] = fieldValue(name, entry.slice(equals + 1));
  }
  return fields;
}

/**
 * Merge `--fields-file`, then `--set`, then the dedicated flags. A dedicated flag colliding with a
 * generic source is an input error rather than a silent override.
 */
async function buildFields(
  flags: { set?: readonly string[] | undefined; fieldsFile?: string | undefined },
  dedicated: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fromFile =
    flags.fieldsFile === undefined ? {} : await readJsonObject(flags.fieldsFile, "--fields-file");
  const merged: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries(fromFile).map(([name, value]) => [
        name,
        typeof value === "string" && RICH_TEXT_FIELDS.has(name) ? markdownToAdf(value) : value,
      ]),
    ),
    ...parseSet(flags.set ?? []),
  };
  for (const [name, value] of Object.entries(dedicated)) {
    if (Object.hasOwn(merged, name)) {
      throw inputError(
        "duplicate_field",
        `Field "${name}" is set by a dedicated flag and by --set/--fields-file`,
        "Set each field once.",
      );
    }
    merged[name] = value;
  }
  return merged;
}

function visibilityOf(flags: {
  visibilityType?: "group" | "role" | undefined;
  visibility?: string | undefined;
}): { type: "group" | "role"; value: string } | undefined {
  const { visibilityType, visibility } = flags;
  if (visibilityType === undefined && visibility === undefined) {
    return undefined;
  }
  if (visibilityType === undefined || visibility === undefined) {
    throw inputError(
      "invalid_visibility",
      "--visibility-type and --visibility must be given together",
    );
  }
  return { type: visibilityType, value: visibility };
}

/** `{key}` or `{id}` reference to an issue, accepting keys, ids, URLs, and ARIs. */
function issueRef(input: string): { key: string } | { id: string } {
  const ref = parseJiraRef(input);
  return ref.key === undefined ? { id: ref.id ?? input } : { key: ref.key };
}

function projectRef(input: string): { key: string } | { id: string } {
  return ISSUE_ID.test(input) ? { id: input } : { key: input };
}

/** Send a write (or plan it); a 409 gains the read command as its `next`. */
async function sendWrite<T>(
  ctx: CommandContext,
  http: HttpClient,
  request: PlannedRequest,
  read: NextCommand,
): Promise<T | Plan> {
  try {
    return await planOrSend<T>(ctx, http, request, [applyArgv(ctx.argv)]);
  } catch (error) {
    if (error instanceof AtlError && error.status === 409) {
      throw new AtlError(error.message, {
        code: error.code,
        category: error.category,
        status: 409,
        hint: "Conflict: re-read the issue and retry.",
        next: [read],
        cause: error,
      });
    }
    throw error;
  }
}

function describeTransition(t: Transition): string {
  return `${t.name ?? t.id} (${t.id}${t.to?.name === undefined ? "" : ` -> ${t.to.name}`})`;
}

/** Match by id, then transition name, then target status name; all case-insensitive. */
async function resolveTransition(
  session: Session,
  key: string,
  rawKey: string,
  wanted: string,
): Promise<Transition> {
  const page = await session.http.request<{ transitions?: Transition[] }>({
    method: "GET",
    url: session.jiraUrl(`/rest/api/3/issue/${key}/transitions`),
  });
  const transitions = page.transitions ?? [];
  const text = wanted.trim().toLowerCase();
  const stages: readonly ((t: Transition) => boolean)[] = [
    (t) => t.id === wanted.trim(),
    (t) => (t.name ?? "").toLowerCase() === text,
    (t) => (t.to?.name ?? "").toLowerCase() === text,
  ];
  for (const test of stages) {
    const hits = transitions.filter(test);
    if (hits.length === 1 && hits[0] !== undefined) {
      return hits[0];
    }
    if (hits.length > 1) {
      throw new AtlError(
        `Transition "${wanted}" is ambiguous for ${rawKey}: ${hits.map(describeTransition).join(", ")}`,
        {
          code: "ambiguous_transition",
          category: "input",
          hint: "Pass a transition id.",
          next: [["atl", "issue", "transitions", rawKey]],
        },
      );
    }
  }
  throw new AtlError(
    `Unknown transition "${wanted}" for ${rawKey}. Available: ${transitions.map(describeTransition).join(", ") || "none"}`,
    {
      code: "unknown_transition",
      category: "input",
      hint: "Pass a transition id, a transition name, or the target status name.",
      next: [["atl", "issue", "transitions", rawKey]],
    },
  );
}

/** Jira duration: space-separated `<number><w|d|h|m>` tokens, e.g. `2h 30m`, `1.5h`. */
const JIRA_DURATION = /^\d+(\.\d+)?[wdhm](\s+\d+(\.\d+)?[wdhm])*$/;

interface IssueTypePage {
  issueTypes?: { id: string; name?: string }[];
  createMetaIssueType?: { id: string; name?: string }[];
  isLast?: boolean;
  total?: number;
}

/** Resolve `--type` (id or case-insensitive name) against the project's creatable issue types. */
async function resolveIssueTypeId(
  session: Session,
  project: string,
  wanted: string,
): Promise<string> {
  const types: { id: string; name?: string }[] = [];
  for (let startAt = 0; ;) {
    const page = await session.http.request<IssueTypePage>({
      method: "GET",
      url: session.jiraUrl(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
      ),
      query: { startAt, maxResults: 50 },
    });
    const items = page.issueTypes ?? page.createMetaIssueType ?? [];
    types.push(...items);
    startAt += items.length;
    if (
      items.length === 0 ||
      page.isLast !== false ||
      (page.total !== undefined && startAt >= page.total)
    ) {
      break;
    }
  }
  const text = wanted.trim();
  const match = ISSUE_ID.test(text)
    ? types.find((t) => t.id === text)
    : types.find((t) => (t.name ?? "").toLowerCase() === text.toLowerCase());
  if (match === undefined) {
    throw new AtlError(
      `Unknown issue type "${wanted}" in project ${project}. Available: ${types.map((t) => t.name ?? t.id).join(", ") || "none"}`,
      {
        code: "unknown_issue_type",
        category: "input",
        hint: "Pass an issue type id or one of the listed names.",
        next: [["atl", "project", "types", project]],
      },
    );
  }
  return match.id;
}

/** Normalize an ISO 8601 instant to Jira's `yyyy-MM-dd'T'HH:mm:ss.SSSZ` worklog format. */
function jiraTimestamp(input: string): string {
  const text = input.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/.test(text)) {
    return text;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw inputError(
      "invalid_started",
      `--started is not an ISO 8601 date-time: ${input}`,
      "Example: 2026-03-09T09:00:00.000+0000",
    );
  }
  return date.toISOString().replace("Z", "+0000");
}

// ---------------------------------------------------------------------------
// issue.create
// ---------------------------------------------------------------------------

interface CreatedIssue {
  id: string;
  key: string;
  self?: string;
}

const issueCreate = defineCommand({
  name: "issue.create",
  summary: "Create an issue (optionally transition it right after)",
  mcpTools: ["createJiraIssue"],
  args: [],
  flags: Type.Object({
    project: Type.String({ description: "Project key or id" }),
    type: Type.String({ description: "Issue type name or id" }),
    summary: Type.String({ description: "Issue summary" }),
    ...BODY_FLAGS,
    parent: Type.Optional(
      Type.String({ description: "Parent issue (for subtasks and child issues)" }),
    ),
    assignee: Type.Optional(
      Type.String({ description: "Assignee account id (see `atl user find`)" }),
    ),
    ...FIELD_FLAGS,
    transition: Type.Optional(
      Type.String({
        description:
          "Transition name, id, or target status to apply after creating; under --plan the follow-up appears as `followUp` (resolved only once the issue exists)",
      }),
    ),
  }),
  sideEffects: "write",
  examples: [
    'atl issue create --project ABC --type Task --summary "Fix login" --body "Login fails on Safari"',
    'atl issue create --project ABC --type Task --summary "Fix login" --file desc.md',
    'atl issue create --project ABC --type Bug --summary Crash --set priority=\'{"name":"High"}\' --set labels=\'["web"]\'',
    'atl issue create --project ABC --type Story --summary Spike --transition "In Progress" --plan',
  ],
  async run(ctx, input) {
    const { flags } = input;
    const description = await loadBody(flags, { allowStorage: false });
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const fields = await buildFields(flags, {
      project: projectRef(flags.project),
      issuetype: { id: await resolveIssueTypeId(session, flags.project, flags.type) },
      summary: flags.summary,
      ...(description === undefined ? {} : { description: jiraBody(description) }),
      ...(flags.parent === undefined ? {} : { parent: issueRef(flags.parent) }),
      ...(flags.assignee === undefined ? {} : { assignee: { accountId: flags.assignee } }),
    });
    const created = await sendWrite<CreatedIssue>(
      ctx,
      session.http,
      { method: "POST", url: session.jiraUrl("/rest/api/3/issue"), body: { fields } },
      ["atl", "project", "fields", flags.project, flags.type],
    );
    if (isPlan(created)) {
      return flags.transition === undefined
        ? created
        : {
            ...created,
            followUp: {
              method: "POST",
              url: session
                .jiraUrl("/rest/api/3/issue/KEY/transitions")
                .replace("/KEY/", "/<new key>/"),
              transition: flags.transition,
            },
          };
    }
    if (ctx.full) {
      return created;
    }
    const result: Record<string, unknown> = {
      key: created.key,
      url: session.siteUrl(`/browse/${encodeURIComponent(created.key)}`),
    };
    if (flags.transition !== undefined) {
      const path = encodeURIComponent(created.key);
      try {
        const transition = await resolveTransition(session, path, created.key, flags.transition);
        await session.http.request({
          method: "POST",
          url: session.jiraUrl(`/rest/api/3/issue/${path}/transitions`),
          body: { transition: { id: transition.id } },
        });
        result.transitioned = {
          id: transition.id,
          name: transition.name,
          to: transition.to?.name,
        };
      } catch (error) {
        if (!(error instanceof AtlError)) {
          throw error;
        }
        throw new AtlError(
          `Issue ${created.key} was created, but the transition failed: ${error.message}`,
          {
            code: error.code,
            category: error.category,
            ...(error.status === undefined ? {} : { status: error.status }),
            hint: `Apply it with \`atl issue move ${created.key} <transition>\`.`,
            next: [["atl", "issue", "transitions", created.key]],
            cause: error,
          },
        );
      }
    }
    return { ...result, next: [["atl", "issue", "get", created.key]] };
  },
});

// ---------------------------------------------------------------------------
// issue.edit
// ---------------------------------------------------------------------------

const issueEdit = defineCommand({
  name: "issue.edit",
  summary: "Edit issue fields and return the refreshed issue",
  mcpTools: ["editJiraIssue"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    summary: Type.Optional(Type.String({ description: "New summary" })),
    ...BODY_FLAGS,
    assignee: Type.Optional(Type.String({ description: "Assignee account id" })),
    ...FIELD_FLAGS,
    format: ADF_FORMAT_FLAG,
  }),
  sideEffects: "write",
  examples: [
    'atl issue edit ABC-123 --summary "New title"',
    "atl issue edit ABC-123 --body 'Updated steps to reproduce'",
    "atl issue edit ABC-123 --file desc.md --set labels='[\"web\"]'",
    'atl issue edit ABC-123 --set resolution=null --set priority=\'{"name":"High"}\' --plan',
  ],
  async run(ctx, input) {
    const { flags } = input;
    const description = await loadBody(flags, { allowStorage: false });
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const fields = await buildFields(flags, {
      ...(flags.summary === undefined ? {} : { summary: flags.summary }),
      ...(description === undefined ? {} : { description: jiraBody(description) }),
      ...(flags.assignee === undefined ? {} : { assignee: { accountId: flags.assignee } }),
    });
    const names = Object.keys(fields);
    if (names.length === 0) {
      throw inputError(
        "nothing_to_edit",
        "No fields to change",
        "Pass --summary, --body, --file, --assignee, --set field=value, or --fields-file.",
      );
    }
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      { method: "PUT", url: session.jiraUrl(`/rest/api/3/issue/${key}`), body: { fields } },
      ["atl", "issue", "get", rawKey],
    );
    if (isPlan(sent)) {
      return sent;
    }
    const issue = await session.http.request<JiraIssue>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}`),
      query: {
        fields: [
          ...DEFAULT_ISSUE_FIELDS,
          ...names.filter((name) => !DEFAULT_ISSUE_FIELDS.includes(name)),
        ].join(","),
      },
    });
    return ctx.full ? issue : compactIssue(session, issue, flags.format, true);
  },
});

// ---------------------------------------------------------------------------
// issue.comment
// ---------------------------------------------------------------------------

const issueComment = defineCommand({
  name: "issue.comment",
  summary: "Add a comment to an issue, or edit one with --edit",
  mcpTools: ["addCommentToJiraIssue"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    ...BODY_FLAGS,
    edit: Type.Optional(Type.String({ description: "Id of an existing comment to update" })),
    ...VISIBILITY_FLAGS,
    format: ADF_FORMAT_FLAG,
  }),
  sideEffects: "write",
  examples: [
    'atl issue comment ABC-123 --body "Deployed to staging"',
    "atl issue comment ABC-123 --file note.md --edit 10050",
    "atl issue comment ABC-123 --file - --visibility-type role --visibility Developers",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const visibility = visibilityOf(flags);
    const comment = await sendWrite<JiraComment>(
      ctx,
      session.http,
      {
        method: flags.edit === undefined ? "POST" : "PUT",
        url: session.jiraUrl(
          `/rest/api/3/issue/${key}/comment${flags.edit === undefined ? "" : `/${encodeURIComponent(flags.edit)}`}`,
        ),
        body: {
          body: jiraBody(await requireBody(flags, { allowStorage: false })),
          ...(visibility === undefined ? {} : { visibility }),
        },
      },
      ["atl", "issue", "comments", rawKey],
    );
    if (isPlan(comment)) {
      return comment;
    }
    if (ctx.full) {
      return comment;
    }
    return {
      ...compactComment(comment, flags.format),
      issue: rawKey,
      url: session.siteUrl(`/browse/${key}?focusedCommentId=${encodeURIComponent(comment.id)}`),
      next: [["atl", "issue", "comments", rawKey]],
    };
  },
});

// ---------------------------------------------------------------------------
// issue.move
// ---------------------------------------------------------------------------

const issueMove = defineCommand({
  name: "issue.move",
  summary: "Transition an issue by transition id, transition name, or target status",
  mcpTools: ["transitionJiraIssue"],
  args: [
    ISSUE_ARG,
    {
      name: "transition",
      description: "Transition id or name, or target status name",
      required: true,
    },
  ],
  flags: Type.Object({
    ...FIELD_FLAGS,
    ...COMMENT_FLAGS,
    updateFile: Type.Optional(
      Type.String({
        description: "JSON file with the transition `update` object (field operations)",
      }),
    ),
    historyMetadataFile: Type.Optional(
      Type.String({ description: "JSON file with the transition `historyMetadata` object" }),
    ),
  }),
  sideEffects: "write",
  examples: [
    'atl issue move ABC-123 "In Progress"',
    'atl issue move ABC-123 Done --set resolution=\'{"name":"Done"}\' --comment "Shipped in 1.2"',
    "atl issue move ABC-123 Done --comment-file why.md --plan",
    "atl issue move ABC-123 31 --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const wanted = input.args.transition ?? "";
    const transition = await resolveTransition(session, key, rawKey, wanted);
    const fields = await buildFields(flags, {});
    const update =
      flags.updateFile === undefined ? {} : await readJsonObject(flags.updateFile, "--update-file");
    const comment = await loadComment(flags);
    if (comment !== undefined) {
      const existing = update.comment;
      if (existing !== undefined && !Array.isArray(existing)) {
        throw inputError(
          "invalid_update",
          "--update-file `comment` must be an array of operations",
        );
      }
      update.comment = [...(existing ?? []), { add: { body: comment } }];
    }
    const historyMetadata =
      flags.historyMetadataFile === undefined
        ? undefined
        : await readJsonObject(flags.historyMetadataFile, "--history-metadata-file");
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      {
        method: "POST",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/transitions`),
        body: {
          transition: { id: transition.id },
          ...(Object.keys(fields).length === 0 ? {} : { fields }),
          ...(Object.keys(update).length === 0 ? {} : { update }),
          ...(historyMetadata === undefined ? {} : { historyMetadata }),
        },
      },
      ["atl", "issue", "get", rawKey],
    );
    if (isPlan(sent)) {
      return sent;
    }
    return {
      key: rawKey,
      transition: { id: transition.id, name: transition.name },
      status: transition.to?.name,
      next: [["atl", "issue", "get", rawKey]],
    };
  },
});

// ---------------------------------------------------------------------------
// issue.log
// ---------------------------------------------------------------------------

interface Worklog {
  id: string;
  issueId?: string;
  timeSpent?: string;
  timeSpentSeconds?: number;
  started?: string;
  author?: { accountId?: string; displayName?: string };
}

const issueLog = defineCommand({
  name: "issue.log",
  summary: "Log work on an issue, or edit a worklog with --edit",
  mcpTools: ["addWorklogToJiraIssue"],
  args: [
    ISSUE_ARG,
    {
      name: "time",
      description: "Time spent, e.g. 2h 30m (required unless --edit only changes other fields)",
      variadic: true,
    },
  ],
  flags: Type.Object({
    started: Type.Optional(
      Type.String({ description: "When the work started (ISO 8601); default is now" }),
    ),
    ...COMMENT_FLAGS,
    edit: Type.Optional(Type.String({ description: "Id of an existing worklog to update" })),
    ...VISIBILITY_FLAGS,
  }),
  sideEffects: "write",
  examples: [
    'atl issue log ABC-123 "2h 30m"',
    'atl issue log ABC-123 4h --started 2026-03-09T09:00:00.000+0000 --comment "Fixed login"',
    "atl issue log ABC-123 4h --comment-file work.md",
    "atl issue log ABC-123 1h --edit 10200",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const timeSpent = input.rest.join(" ").trim();
    if (timeSpent === "" && flags.edit === undefined) {
      throw inputError(
        "missing_time",
        "Time spent is required for a new worklog",
        'Pass e.g. "2h 30m".',
      );
    }
    if (timeSpent !== "" && !JIRA_DURATION.test(timeSpent)) {
      throw inputError(
        "invalid_time_spent",
        `Invalid time spent "${timeSpent}"`,
        'Use Jira duration units w/d/h/m, e.g. "2h 30m", "1d", or "1.5h".',
      );
    }
    const visibility = visibilityOf(flags);
    const comment = await loadComment(flags);
    const worklog = await sendWrite<Worklog>(
      ctx,
      session.http,
      {
        method: flags.edit === undefined ? "POST" : "PUT",
        url: session.jiraUrl(
          `/rest/api/3/issue/${key}/worklog${flags.edit === undefined ? "" : `/${encodeURIComponent(flags.edit)}`}`,
        ),
        body: {
          ...(timeSpent === "" ? {} : { timeSpent }),
          ...(flags.started === undefined ? {} : { started: jiraTimestamp(flags.started) }),
          ...(comment === undefined ? {} : { comment }),
          ...(visibility === undefined ? {} : { visibility }),
        },
      },
      ["atl", "issue", "get", rawKey],
    );
    if (isPlan(worklog)) {
      return worklog;
    }
    if (ctx.full) {
      return worklog;
    }
    return {
      id: worklog.id,
      issue: rawKey,
      timeSpent: worklog.timeSpent,
      started: shortTs(worklog.started),
      author: worklog.author?.displayName ?? worklog.author?.accountId,
    };
  },
});

// ---------------------------------------------------------------------------
// issue.link
// ---------------------------------------------------------------------------

interface IssueLinkType {
  id: string;
  name?: string;
  inward?: string;
  outward?: string;
}

const issueLink = defineCommand({
  name: "issue.link",
  summary: 'Link two issues: `atl issue link A blocks B` means "A blocks B"',
  mcpTools: ["createIssueLink"],
  args: [
    {
      name: "from",
      description: "Issue that carries the relation (MCP inwardIssue)",
      required: true,
    },
    {
      name: "type",
      description:
        'Link type name or id, or its outward/inward phrase (e.g. blocks, "is blocked by")',
      required: true,
    },
    { name: "to", description: "Issue on the other end (MCP outwardIssue)", required: true },
  ],
  flags: Type.Object({ ...COMMENT_FLAGS }),
  sideEffects: "write",
  examples: [
    "atl issue link ABC-1 blocks ABC-2",
    'atl issue link ABC-1 "is blocked by" ABC-2',
    "atl issue link ABC-1 Duplicate ABC-2 --comment 'Same root cause' --plan",
    "atl issue link ABC-1 Duplicate ABC-2 --comment-file why.md --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const comment = await loadComment(flags);
    const { session, rawKey: fromKey } = await issueSession(ctx, input.args.from ?? "");
    const toInput = input.args.to ?? "";
    const toRef = issueRef(toInput);
    const toKey = "key" in toRef ? toRef.key : toRef.id;
    const wanted = (input.args.type ?? "").trim();
    const text = wanted.toLowerCase();

    const page = await session.http.request<{ issueLinkTypes?: IssueLinkType[] }>({
      method: "GET",
      url: session.jiraUrl("/rest/api/3/issueLinkType"),
    });
    const types = page.issueLinkTypes ?? [];
    const stages: readonly ((t: IssueLinkType) => boolean)[] = [
      (t) => t.id === wanted,
      (t) => (t.name ?? "").toLowerCase() === text,
      (t) => (t.outward ?? "").toLowerCase() === text,
      (t) => (t.inward ?? "").toLowerCase() === text,
    ];
    const INWARD_STAGE = 3;
    let type: IssueLinkType | undefined;
    let reversed = false;
    for (const [stage, test] of stages.entries()) {
      const hits = types.filter(test);
      if (hits.length > 1) {
        throw new AtlError(
          `Link type "${wanted}" is ambiguous: ${hits.map((t) => `${t.name ?? t.id} (${t.id})`).join(", ")}`,
          {
            code: "ambiguous_link_type",
            category: "input",
            hint: "Pass the link type id.",
            next: [["atl", "issue", "link-types"]],
          },
        );
      }
      if (hits[0] !== undefined) {
        type = hits[0];
        reversed = stage === INWARD_STAGE;
        break;
      }
    }
    if (type === undefined) {
      throw new AtlError(
        `Unknown link type "${wanted}". Available: ${
          types
            .map((t) => `${t.name ?? t.id} (${t.outward ?? "?"} / ${t.inward ?? "?"})`)
            .join(", ") || "none"
        }`,
        {
          code: "unknown_link_type",
          category: "input",
          hint: "Pass a link type name, id, or its outward/inward phrase.",
          next: [["atl", "issue", "link-types"]],
        },
      );
    }

    const fromRef = issueRef(input.args.from ?? "");
    const inwardIssue = reversed ? toRef : fromRef;
    const outwardIssue = reversed ? fromRef : toRef;
    const sent = await sendWrite<unknown>(
      ctx,
      session.http,
      {
        method: "POST",
        url: session.jiraUrl("/rest/api/3/issueLink"),
        body: {
          type: { name: type.name ?? type.id },
          inwardIssue,
          outwardIssue,
          ...(comment === undefined ? {} : { comment: { body: comment } }),
        },
      },
      ["atl", "issue", "links", fromKey],
    );
    if (isPlan(sent)) {
      return sent;
    }
    return {
      type: type.name ?? type.id,
      issue: fromKey,
      relation: reversed ? type.inward : type.outward,
      linked: toKey,
      next: [["atl", "issue", "links", fromKey]],
    };
  },
});

export const jiraWriteCommands: readonly CommandSpec[] = [
  issueCreate,
  issueEdit,
  issueComment,
  issueMove,
  issueLog,
  issueLink,
];
