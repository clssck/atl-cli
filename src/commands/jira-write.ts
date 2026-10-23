import { Type } from "../core/schema.ts";
import { markdownToAdf } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, inputError, type NextCommand } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { HttpClient } from "../core/http.ts";
import { currentAccountId, openSession, type Session } from "../core/session.ts";
import { parseJiraRef } from "../resolve/index.ts";
import {
  compactComment,
  compactIssue,
  DEFAULT_ISSUE_FIELDS,
  DIRECT_FIELD,
  type FieldRecord,
  fetchFields,
  ISSUE_ARG,
  issueSession,
  jiraDeps,
  projectKey,
  resolveField,
  resolveIssueTypeId,
  userName,
  type JiraComment,
  type JiraIssue,
  type Transition,
} from "./jira.ts";
import { ADF_FORMAT_FLAG, readJsonObject, shortTs } from "./common.ts";
import {
  applyArgv,
  applyArgvFor,
  BODY_FLAGS,
  COMMENT_FLAGS,
  isPlan,
  jiraBody,
  loadBody,
  loadComment,
  planOf,
  planOrSend,
  requireBody,
  type Plan,
  type PlannedRequest,
  requireYes,
  YES_FLAG,
} from "./write.ts";

// ---------------------------------------------------------------------------
// Shared flags and helpers
// ---------------------------------------------------------------------------

const FIELD_FLAGS = {
  set: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "field=value; the field is an id or display name (case-insensitive); the value is JSON when it parses, else text shaped to the field type (number, option, user, sprint id). Repeatable",
    }),
  ),
  fieldsFile: Type.Optional(
    Type.String({
      description: "JSON file with an object of fields (ids or names) to merge (before --set)",
    }),
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

function tryParseJson(raw: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return undefined;
  }
}

/** Jira account ids: 24 hex digits, or `<digits>:<uuid>`. */
const ACCOUNT_ID = /^(?:[0-9a-f]{24}|\d+:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/** `--set assignee=<string>`: an account id, `none` (unassign), or `auto` (project default). */
function assigneeValue(raw: string): { accountId: string | null } {
  const text = raw.trim();
  if (text.toLowerCase() === "none") {
    return { accountId: null };
  }
  if (text.toLowerCase() === "auto") {
    return { accountId: "-1" };
  }
  if (!ACCOUNT_ID.test(text)) {
    throw inputError(
      "invalid_assignee",
      `"${raw}" is not an account id; Jira would unassign the issue instead of failing`,
      "Pass an account id (see `atl user find`), `none` to unassign, or `auto` for the project default.",
    );
  }
  return { accountId: text };
}

const NUMBER_TEXT = /^-?\d+(?:[.,]\d+)?$/;

/** Comma-separated `--set` text (or a JSON array) as a list of strings. */
function listOf(json: unknown, text: string): unknown[] {
  return Array.isArray(json)
    ? json
    : text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
}

/**
 * A field looked up by name takes its value in the shape its schema needs: numbers from text
 * (`.` or `,` decimals), `{value}` for options, account ids for users, a sprint id for the
 * sprint field. Explicit JSON objects, arrays and `null` pass through; undefined means "no
 * shaping applies".
 */
function shapedValue(
  field: FieldRecord,
  raw: string,
  parsed: { value: unknown } | undefined,
): { value: unknown } | undefined {
  const { type, items, custom } = field.schema ?? {};
  const json = parsed?.value;
  const text = typeof json === "string" ? json : raw.trim();
  if (json === null || (isRecord(json) && !Array.isArray(json))) {
    return undefined;
  }
  if (custom?.endsWith(":gh-sprint") === true) {
    if (!/^\d+$/.test(text)) {
      throw inputError(
        "invalid_sprint",
        `Field "${field.name}" takes a numeric sprint id, got "${raw}"`,
        "Pass the sprint id (see `atl board sprints <board>`), or null to clear.",
      );
    }
    return { value: Number(text) };
  }
  if (type === "number") {
    if (typeof json === "number") {
      return undefined;
    }
    if (!NUMBER_TEXT.test(text)) {
      throw inputError(
        "invalid_field_value",
        `Field "${field.name}" is a number, got "${raw}"`,
        "Pass digits with an optional . or , decimal part.",
      );
    }
    return { value: Number(text.replace(",", ".")) };
  }
  if (type === "option") {
    return { value: { value: text } };
  }
  if (type === "array" && items === "option") {
    return {
      value: listOf(json, text).map((item) => (typeof item === "string" ? { value: item } : item)),
    };
  }
  if (type === "user" && (parsed === undefined || typeof json === "string")) {
    return { value: assigneeValue(text) };
  }
  if (type === "array" && items === "user") {
    return {
      value: listOf(json, text).map((item) =>
        typeof item === "string" ? assigneeValue(item) : item,
      ),
    };
  }
  return undefined;
}

/** One `--set field=value` value: JSON when it parses, else a string; summary is always text. */
function fieldValue(name: string, raw: string, field: FieldRecord | undefined): unknown {
  if (name === "summary") {
    return raw;
  }
  const parsed = tryParseJson(raw);
  if (name === "assignee" && (parsed === undefined || typeof parsed.value === "string")) {
    return assigneeValue(parsed === undefined ? raw : String(parsed.value));
  }
  if (RICH_TEXT_FIELDS.has(name)) {
    if (parsed !== undefined && (parsed.value === null || isRecord(parsed.value))) {
      return parsed.value;
    }
    return markdownToAdf(raw);
  }
  const shaped = field === undefined ? undefined : shapedValue(field, raw, parsed);
  if (shaped !== undefined) {
    return shaped.value;
  }
  return parsed === undefined ? raw : parsed.value;
}

interface ResolutionRecord {
  id?: string;
  name?: string;
}

async function fetchResolutions(session: Session, english: boolean): Promise<ResolutionRecord[]> {
  return session.http.request<ResolutionRecord[]>({
    method: "GET",
    url: session.jiraUrl("/rest/api/3/resolution"),
    ...(english ? { headers: ENGLISH } : {}),
  });
}

/**
 * `--set resolution=...` as the API's `{id}`: a resolution given by its localized or English name
 * (`Kész`, `Won't Do`, or `{"name": ...}`) is looked up in the site's list, because Jira accepts
 * some localized names and rejects others (HTTP 400). `null` clears; `{id}` and other values pass through.
 */
async function resolutionValue(session: Session, value: unknown): Promise<unknown> {
  const name =
    typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : isRecord(value)
          ? value.name
          : undefined;
  if (typeof name !== "string" || (isRecord(value) && value.id !== undefined)) {
    return value;
  }
  const wanted = name.trim().toLowerCase();
  const localized = await fetchResolutions(session, false);
  const english = await fetchResolutions(session, true);
  const hit = [...localized, ...english].find(
    (resolution) => resolution.id === wanted || resolution.name?.toLowerCase() === wanted,
  );
  if (hit?.id === undefined) {
    const names = present([...localized, ...english].map((resolution) => resolution.name));
    throw inputError(
      "unknown_resolution",
      `Unknown resolution "${name}". Available: ${names.join(", ")}`,
      "See `atl resolution list`.",
    );
  }
  return { id: hit.id };
}

/**
 * Merge `--fields-file`, then `--set`, then the dedicated flags. Keys may be field ids or names;
 * names resolve through the site's field list (read once, only when a key needs it). A dedicated
 * flag colliding with a generic source is an input error rather than a silent override.
 */
async function buildFields(
  session: Session,
  flags: { set?: readonly string[] | undefined; fieldsFile?: string | undefined },
  dedicated: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let catalog: Promise<FieldRecord[]> | undefined;
  const lookup = async (key: string): Promise<{ id: string; field?: FieldRecord }> => {
    if (DIRECT_FIELD.test(key)) {
      return { id: key };
    }
    catalog ??= fetchFields(session);
    const field = resolveField(await catalog, key);
    return { id: field.id, field };
  };
  const fromFile =
    flags.fieldsFile === undefined ? {} : await readJsonObject(flags.fieldsFile, "--fields-file");
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fromFile)) {
    const { id } = await lookup(key);
    merged[id] =
      typeof value === "string" && RICH_TEXT_FIELDS.has(id) ? markdownToAdf(value) : value;
  }
  for (const entry of flags.set ?? []) {
    const equals = entry.indexOf("=");
    const name = equals === -1 ? "" : entry.slice(0, equals).trim();
    if (name === "") {
      throw inputError(
        "invalid_set",
        `--set expects field=value, got "${entry}"`,
        'Example: --set labels=\'["a","b"]\' or --set "Story point estimate=3".',
      );
    }
    const { id, field } = await lookup(name);
    merged[id] = fieldValue(id, entry.slice(equals + 1), field);
  }
  if (Object.hasOwn(merged, "resolution")) {
    merged.resolution = await resolutionValue(session, merged.resolution);
  }
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
  const project = projectKey(input);
  return ISSUE_ID.test(project) ? { id: project } : { key: project };
}

/** A later request of the same invocation, shown under a plan's `followUp`. */
function followUpOf(request: PlannedRequest) {
  const { method, url, body } = planOf(request, []);
  return { method, url, body };
}

/** Send a write (or plan it); a 409 gains the read command as its `next`. */
async function sendWrite<T>(
  ctx: CommandContext,
  http: HttpClient,
  request: PlannedRequest,
  read: NextCommand,
  needsYes = false,
): Promise<T | Plan> {
  try {
    return await planOrSend<T>(ctx, http, request, [applyArgvFor(ctx, needsYes)]);
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

/** Forces Jira to answer in English, whatever language the account uses. */
const ENGLISH = { "Accept-Language": "en", "X-Force-Accept-Language": "true" } as const;

/** The transitions an issue offers now, in the account's language or (with `english`) untranslated. */
export async function fetchTransitions(
  session: Session,
  key: string,
  english: boolean,
): Promise<Transition[]> {
  const page = await session.http.request<{ transitions?: Transition[] }>({
    method: "GET",
    url: session.jiraUrl(`/rest/api/3/issue/${key}/transitions`),
    ...(english ? { headers: ENGLISH } : {}),
  });
  return page.transitions ?? [];
}

/** A transition with every name it answers to: localized and untranslated, for itself and its target status. */
export interface TransitionNames {
  id: string;
  names: readonly string[];
  statuses: readonly string[];
}

function present(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== "")),
  ];
}

/** Pair each localized transition with its untranslated twin (same id). */
export function transitionNames(
  localized: readonly Transition[],
  english: readonly Transition[],
): (TransitionNames & { transition: Transition })[] {
  return localized.map((transition) => {
    const twin = english.find((candidate) => candidate.id === transition.id);
    return {
      transition,
      id: transition.id,
      names: present([transition.name, twin?.name]),
      statuses: present([transition.to?.name, twin?.to?.name]),
    };
  });
}

/** Candidates matching by id, else by any transition name, else by any target status name (case-insensitive). */
export function matchTransitions<T extends TransitionNames>(
  candidates: readonly T[],
  wanted: string,
): T[] {
  const text = wanted.trim().toLowerCase();
  const same = (name: string): boolean => name.toLowerCase() === text;
  const stages: readonly ((t: T) => boolean)[] = [
    (t) => t.id === wanted.trim(),
    (t) => t.names.some(same),
    (t) => t.statuses.some(same),
  ];
  for (const test of stages) {
    const hits = candidates.filter(test);
    if (hits.length > 0) {
      return hits;
    }
  }
  return [];
}

export function describeTransition(t: TransitionNames): string {
  const target = t.statuses.length === 0 ? "" : ` -> ${t.statuses.join(" / ")}`;
  return `${t.names.join(" / ") || t.id} (${t.id}${target})`;
}

/** Match by id, then transition name, then target status name, in either language; all case-insensitive. */
async function resolveTransition(
  session: Session,
  key: string,
  rawKey: string,
  wanted: string,
): Promise<Transition> {
  const [localized, english] = await Promise.all([
    fetchTransitions(session, key, false),
    fetchTransitions(session, key, true),
  ]);
  const candidates = transitionNames(localized, english);
  const hits = matchTransitions(candidates, wanted);
  if (hits.length === 1 && hits[0] !== undefined) {
    return hits[0].transition;
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
  throw new AtlError(
    `Unknown transition "${wanted}" for ${rawKey}. Available: ${candidates.map(describeTransition).join(", ") || "none"}`,
    {
      code: "unknown_transition",
      category: "input",
      hint: "Pass a transition id, a transition name, or the target status name (localized or English).",
      next: [["atl", "issue", "transitions", rawKey]],
    },
  );
}

/** One duration token: `<number><w|d|h|m|s>`; `.` and `,` both start the decimals. */
const DURATION_TOKEN = /^(\d+(?:[.,]\d+)?)([wdhms])$/;

interface TimeTrackingConfiguration {
  timeTrackingConfiguration?: { workingHoursPerDay?: number; workingDaysPerWeek?: number };
}

function workingTimeUnavailable(cause: unknown, detail: string): AtlError {
  return new AtlError(`Cannot convert d/w durations: ${detail}`, {
    code: "working_time_unavailable",
    category: "input",
    hint: "Give the time in h/m instead, e.g. 4h for half a working day.",
    cause,
  });
}

/** Seconds in a working day and week, from the site's time tracking settings. */
async function workingSeconds(session: Session): Promise<{ d: number; w: number }> {
  let config: TimeTrackingConfiguration;
  try {
    config = await session.http.request<TimeTrackingConfiguration>({
      method: "GET",
      url: session.jiraUrl("/rest/api/3/configuration"),
    });
  } catch (error) {
    if (!(error instanceof AtlError)) {
      throw error;
    }
    throw workingTimeUnavailable(
      error,
      `the site's working hours are unreadable (${error.message})`,
    );
  }
  const hours = config.timeTrackingConfiguration?.workingHoursPerDay;
  const days = config.timeTrackingConfiguration?.workingDaysPerWeek;
  if (typeof hours !== "number" || typeof days !== "number" || hours <= 0 || days <= 0) {
    throw workingTimeUnavailable(
      undefined,
      "the site returned no working hours per day or days per week",
    );
  }
  return { d: hours * 3600, w: hours * days * 3600 };
}

/**
 * A Jira duration (`2h 30m`, `1.5h`, `0,5d`) in seconds, computed here so the decimal separator
 * never reaches a locale-specific site. h/m/s are exact; d/w use the site's working time, read
 * only when one of them is present.
 */
async function durationSeconds(session: Session, text: string): Promise<number> {
  // `1h30m` is `1h 30m`: a unit letter directly followed by the next amount starts a new token.
  const parts = text
    .trim()
    .toLowerCase()
    .replaceAll(/([wdhms])(?=\d)/g, "$1 ")
    .split(/\s+/)
    .map((token) => DURATION_TOKEN.exec(token));
  const valid = parts.flatMap((match) =>
    match?.[1] === undefined || match[2] === undefined
      ? []
      : [{ amount: Number(match[1].replace(",", ".")), unit: match[2] }],
  );
  if (valid.length !== parts.length) {
    throw inputError(
      "invalid_time_spent",
      `Invalid time spent "${text}"`,
      'Use w/d/h/m units, e.g. "2h 30m", "2h30m", "1d", "1.5h" or "1,5h".',
    );
  }
  const working = valid.some((p) => p.unit === "d" || p.unit === "w")
    ? await workingSeconds(session)
    : { d: 0, w: 0 };
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, ...working };
  return Math.round(valid.reduce((sum, p) => sum + p.amount * (unitSeconds[p.unit] ?? 0), 0));
}

/** ISO 8601 date or date-time with optional seconds, fraction and offset. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/i;

/** Normalize an ISO 8601 instant to Jira's `yyyy-MM-dd'T'HH:mm:ss.SSSZ` worklog format. */
function jiraTimestamp(input: string): string {
  const text = input.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/.test(text)) {
    return text;
  }
  const date = ISO_INSTANT.test(text) ? new Date(text) : new Date(Number.NaN);
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
      Type.String({ description: "Assignee account id (see `atl user find`), none, or auto" }),
    ),
    ...FIELD_FLAGS,
    transition: Type.Optional(
      Type.String({
        description:
          "Transition name, id, or target status (localized or English) to apply after creating; under --plan the follow-up appears as `followUp` (resolved only once the issue exists)",
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
    const fields = await buildFields(session, flags, {
      project: projectRef(flags.project),
      issuetype: { id: await resolveIssueTypeId(session, flags.project, flags.type) },
      summary: flags.summary,
      ...(description === undefined ? {} : { description: jiraBody(description) }),
      ...(flags.parent === undefined ? {} : { parent: issueRef(flags.parent) }),
      ...(flags.assignee === undefined ? {} : { assignee: assigneeValue(flags.assignee) }),
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
              note: "Resolved against the new issue's available transitions after it is created (localized or English names); a mismatch leaves the issue created and exits with unknown_transition.",
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
// issue.update
// ---------------------------------------------------------------------------

const issueUpdate = defineCommand({
  name: "issue.update",
  summary: "Update issue fields and return the refreshed issue",
  mcpTools: ["editJiraIssue"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    summary: Type.Optional(Type.String({ description: "New summary" })),
    ...BODY_FLAGS,
    assignee: Type.Optional(Type.String({ description: "Assignee account id, none, or auto" })),
    ...FIELD_FLAGS,
    format: ADF_FORMAT_FLAG,
  }),
  sideEffects: "write",
  examples: [
    'atl issue update ABC-123 --summary "New title"',
    "atl issue update ABC-123 --body 'Updated steps to reproduce'",
    "atl issue update ABC-123 --file desc.md --set labels='[\"web\"]'",
    'atl issue update ABC-123 --set resolution=null --set priority=\'{"name":"High"}\' --plan',
  ],
  async run(ctx, input) {
    const { flags } = input;
    const description = await loadBody(flags, { allowStorage: false });
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const fields = await buildFields(session, flags, {
      ...(flags.summary === undefined ? {} : { summary: flags.summary }),
      ...(description === undefined ? {} : { description: jiraBody(description) }),
      ...(flags.assignee === undefined ? {} : { assignee: assigneeValue(flags.assignee) }),
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
  mcpTools: ["addCommentToJiraIssue", "addOrEditJiraIssueComment"],
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
      description: "Transition id or name, or target status name (localized or English)",
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
    'atl issue move ABC-123 Done --set resolution="Won\'t Do" --comment "Dropped"',
    "atl issue move ABC-123 Done --comment-file why.md --plan",
    "atl issue move ABC-123 31 --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const wanted = input.args.transition ?? "";
    const transition = await resolveTransition(session, key, rawKey, wanted);
    const fields = await buildFields(session, flags, {});
    const update =
      flags.updateFile === undefined ? {} : await readJsonObject(flags.updateFile, "--update-file");
    const comment = await loadComment(flags);
    const historyMetadata =
      flags.historyMetadataFile === undefined
        ? undefined
        : await readJsonObject(flags.historyMetadataFile, "--history-metadata-file");
    const resolutionArg = flags.set?.find((entry) => /^\s*resolution\s*=/i.test(entry));
    let sent: undefined | Plan;
    try {
      sent = await sendWrite<undefined>(
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
    } catch (error) {
      if (
        resolutionArg !== undefined &&
        error instanceof AtlError &&
        error.status === 400 &&
        /resolution/i.test(error.message) &&
        /screen|cannot be set/i.test(error.message)
      ) {
        const value = resolutionArg.slice(resolutionArg.indexOf("=") + 1).trim();
        throw new AtlError(error.message, {
          code: "resolution_not_on_transition_screen",
          category: "input",
          status: 400,
          hint: `This transition's screen has no resolution field, so nothing was changed. Move without --set resolution, then run \`atl issue update ${rawKey} --set resolution=${value}\` (the transition stamps its own default resolution first).`,
          next: [["atl", "issue", "update", rawKey, "--set", `resolution=${value}`]],
          cause: error,
        });
      }
      throw error;
    }
    // The transition screen need not carry a comment field, which Jira ignores silently: post the
    // comment through the comment API once the transition has succeeded.
    const commentRequest: PlannedRequest | undefined =
      comment === undefined
        ? undefined
        : {
            method: "POST",
            url: session.jiraUrl(`/rest/api/3/issue/${key}/comment`),
            body: { body: comment },
          };
    if (isPlan(sent)) {
      return commentRequest === undefined
        ? sent
        : { ...sent, followUp: followUpOf(commentRequest) };
    }
    const result: Record<string, unknown> = {
      key: rawKey,
      transition: { id: transition.id, name: transition.name },
      status: transition.to?.name,
    };
    if (commentRequest !== undefined) {
      try {
        const posted = await session.http.request<JiraComment>({
          method: commentRequest.method,
          url: commentRequest.url,
          body: commentRequest.body,
        });
        result.comment = { id: posted.id };
      } catch (error) {
        if (!(error instanceof AtlError)) {
          throw error;
        }
        throw new AtlError(
          `Issue ${rawKey} was transitioned, but the comment was not posted: ${error.message}`,
          {
            code: error.code,
            category: error.category,
            ...(error.status === undefined ? {} : { status: error.status }),
            hint: `Post it with \`atl issue comment ${rawKey} --body <text>\`.`,
            next: [["atl", "issue", "get", rawKey]],
            cause: error,
          },
        );
      }
    }
    return { ...result, next: [["atl", "issue", "get", rawKey]] };
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
  mcpTools: ["addWorklogToJiraIssue", "addOrEditJiraIssueWorklog"],
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
    const seconds = timeSpent === "" ? undefined : await durationSeconds(session, timeSpent);
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
          ...(seconds === undefined ? {} : { timeSpentSeconds: seconds }),
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
      author: userName(worklog.author),
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
  mcpTools: ["createIssueLink", "createJiraIssueLink"],
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

// ---------------------------------------------------------------------------
// issue.delete / issue.comment-delete
// ---------------------------------------------------------------------------

const issueDelete = defineCommand({
  name: "issue.delete",
  summary: "Delete an issue (irreversible; needs --yes)",
  mcpTools: ["deleteJiraIssue"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    deleteSubtasks: Type.Optional(
      Type.Boolean({ description: "Also delete the issue's subtasks (Jira refuses otherwise)" }),
    ),
    yes: YES_FLAG,
  }),
  sideEffects: "write",
  examples: ["atl issue delete ABC-123 --plan", "atl issue delete ABC-123 --delete-subtasks --yes"],
  async run(ctx, input) {
    const { flags } = input;
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    requireYes(ctx, flags.yes, `DELETE issue ${rawKey}`);
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      {
        method: "DELETE",
        url: session.jiraUrl(`/rest/api/3/issue/${key}`),
        ...(flags.deleteSubtasks === true ? { query: { deleteSubtasks: true } } : {}),
      },
      ["atl", "issue", "get", rawKey],
      true,
    );
    if (isPlan(sent)) {
      return sent;
    }
    return { deleted: rawKey, ...(flags.deleteSubtasks === true ? { subtasks: "deleted" } : {}) };
  },
});

const issueCommentDelete = defineCommand({
  name: "issue.comment-delete",
  summary: "Delete a comment from an issue (irreversible; needs --yes)",
  mcpTools: ["deleteJiraComment"],
  args: [
    ISSUE_ARG,
    { name: "commentId", description: "Comment id (see `atl issue comments`)", required: true },
  ],
  flags: Type.Object({ yes: YES_FLAG }),
  sideEffects: "write",
  examples: [
    "atl issue comment-delete ABC-123 10050 --plan",
    "atl issue comment-delete ABC-123 10050 --yes",
  ],
  async run(ctx, input) {
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const commentId = input.args.commentId ?? "";
    requireYes(ctx, input.flags.yes, `DELETE comment ${commentId} on ${rawKey}`);
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      {
        method: "DELETE",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/comment/${encodeURIComponent(commentId)}`),
      },
      ["atl", "issue", "comments", rawKey],
      true,
    );
    return isPlan(sent) ? sent : { deleted: commentId, issue: rawKey };
  },
});

// ---------------------------------------------------------------------------
// issue.remote-link.add
// ---------------------------------------------------------------------------

const issueRemoteLinkAdd = defineCommand({
  name: "issue.remote-link.add",
  summary: "Add a web link (external URL or Confluence page) to an issue's Web links",
  mcpTools: ["createJiraIssueRemoteIssueLink"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    url: Type.String({ description: "Link target URL (http/https)" }),
    title: Type.String({ description: "Link text" }),
    summary: Type.Optional(
      Type.String({ description: "Longer description shown under the title" }),
    ),
    relationship: Type.Optional(
      Type.String({ description: 'Relationship label, e.g. "mentioned in" or "causes"' }),
    ),
    globalId: Type.Optional(
      Type.String({
        description: "Stable id for the link; re-posting the same globalId updates that link",
      }),
    ),
    iconUrl: Type.Optional(Type.String({ description: "16x16 icon URL shown beside the link" })),
  }),
  sideEffects: "write",
  examples: [
    'atl issue remote-link add ABC-123 --url https://example.com/runbook --title "Runbook"',
    'atl issue remote-link add ABC-123 --url https://acme.atlassian.net/wiki/spaces/X/pages/1 --title "Design" --relationship "documented in"',
  ],
  async run(ctx, input) {
    const { flags } = input;
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const created = await sendWrite<{ id?: number | string; self?: string }>(
      ctx,
      session.http,
      {
        method: "POST",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/remotelink`),
        body: {
          ...(flags.globalId === undefined ? {} : { globalId: flags.globalId }),
          ...(flags.relationship === undefined ? {} : { relationship: flags.relationship }),
          object: {
            url: flags.url,
            title: flags.title,
            ...(flags.summary === undefined ? {} : { summary: flags.summary }),
            ...(flags.iconUrl === undefined ? {} : { icon: { url16x16: flags.iconUrl } }),
          },
        },
      },
      ["atl", "issue", "links", rawKey, "--remote"],
    );
    if (isPlan(created) || ctx.full) {
      return created;
    }
    return {
      id: created.id === undefined ? undefined : String(created.id),
      issue: rawKey,
      next: [["atl", "issue", "links", rawKey, "--remote"]],
    };
  },
});

const issueRemoteLinkDelete = defineCommand({
  name: "issue.remote-link.delete",
  summary: "Delete a web link from an issue, by link id or --global-id (irreversible; needs --yes)",
  args: [
    ISSUE_ARG,
    {
      name: "linkId",
      description: "Web link id (see `atl issue links <issue> --remote`); or use --global-id",
    },
  ],
  flags: Type.Object({
    globalId: Type.Optional(
      Type.String({ description: "Delete the link with this globalId instead of a link id" }),
    ),
    yes: YES_FLAG,
  }),
  sideEffects: "write",
  examples: [
    "atl issue remote-link delete ABC-123 10014 --plan",
    "atl issue remote-link delete ABC-123 10014 --yes",
    "atl issue remote-link delete ABC-123 --global-id runbook-1 --yes",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const linkId = input.args.linkId;
    if ((linkId === undefined) === (flags.globalId === undefined)) {
      throw inputError(
        "invalid_selection",
        "Pass either a link id or --global-id, not both and not neither",
        "List the links with `atl issue links <issue> --remote`.",
      );
    }
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    requireYes(
      ctx,
      flags.yes,
      `DELETE web link ${linkId ?? `with globalId ${flags.globalId ?? ""}`} on ${rawKey}`,
    );
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      linkId === undefined
        ? {
            method: "DELETE",
            url: session.jiraUrl(`/rest/api/3/issue/${key}/remotelink`),
            query: { globalId: flags.globalId ?? "" },
          }
        : {
            method: "DELETE",
            url: session.jiraUrl(
              `/rest/api/3/issue/${key}/remotelink/${encodeURIComponent(linkId)}`,
            ),
          },
      ["atl", "issue", "links", rawKey, "--remote"],
      true,
    );
    if (isPlan(sent)) {
      return sent;
    }
    return {
      deleted: linkId ?? flags.globalId,
      issue: rawKey,
      next: [["atl", "issue", "links", rawKey, "--remote"]],
    };
  },
});

// ---------------------------------------------------------------------------
// property.set
// ---------------------------------------------------------------------------

const PROPERTY_ENTITIES = ["issue", "comment", "worklog", "dashboard-item"] as const;

function isPropertyEntity(value: string): value is (typeof PROPERTY_ENTITIES)[number] {
  return PROPERTY_ENTITIES.some((entity) => entity === value);
}

const propertySet = defineCommand({
  name: "property.set",
  summary: "Create or overwrite an entity property (issue, comment, worklog, dashboard-item)",
  mcpTools: ["editJiraEntityProperty"],
  args: [
    {
      name: "entity",
      description: `One of ${PROPERTY_ENTITIES.join(", ")}`,
      required: true,
    },
    {
      name: "id",
      description: "Issue key/id, comment id, worklog id, or dashboard id",
      required: true,
    },
    { name: "key", description: "Property key (at most 255 characters)", required: true },
  ],
  flags: Type.Object({
    value: Type.Optional(
      Type.String({ description: "Property value as JSON (strings need quotes)" }),
    ),
    file: Type.Optional(Type.String({ description: "File containing the JSON value" })),
    issue: Type.Optional(Type.String({ description: "Issue key or id (entity worklog only)" })),
    item: Type.Optional(
      Type.String({ description: "Dashboard item id (entity dashboard-item only)" }),
    ),
  }),
  sideEffects: "write",
  examples: [
    'atl property set issue ABC-123 team.meta --value \'{"owner":"web"}\'',
    "atl property set comment 10050 review.state --file state.json --plan",
    "atl property set worklog 10042 audit --issue ABC-123 --value '\"checked\"'",
    "atl property set dashboard-item 10001 cfg --item 10002 --value 3",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const entity = input.args.entity ?? "";
    const id = input.args.id ?? "";
    const propertyKey = encodeURIComponent(input.args.key ?? "");
    if (!isPropertyEntity(entity)) {
      throw inputError(
        "invalid_property_entity",
        `Unknown entity "${entity}"`,
        `Use one of ${PROPERTY_ENTITIES.join(", ")}. User and project property writes need scopes this login does not have.`,
      );
    }
    if ((flags.value === undefined) === (flags.file === undefined)) {
      throw inputError("property_value_required", "Pass exactly one of --value or --file");
    }
    const raw =
      flags.value ??
      (await Bun.file(flags.file ?? "")
        .text()
        .catch((cause: unknown) => {
          throw new AtlError(`Cannot read --file ${flags.file}`, {
            code: "input_file_unreadable",
            category: "input",
            cause,
          });
        }));
    const parsed = tryParseJson(raw);
    if (parsed === undefined) {
      throw inputError(
        "invalid_property_value",
        "The property value is not valid JSON",
        "Quote strings: --value '\"text\"'.",
      );
    }
    if (entity === "worklog" && flags.issue === undefined) {
      throw inputError("missing_issue", "Entity worklog needs --issue <key>");
    }
    if (entity === "dashboard-item" && flags.item === undefined) {
      throw inputError("missing_item", "Entity dashboard-item needs --item <itemId>");
    }

    const issue = entity === "issue" ? await issueSession(ctx, id) : undefined;
    const session = issue?.session ?? (await openSession(ctx, { fetch: jiraDeps.fetch }));
    const encodedId = issue?.key ?? encodeURIComponent(id);
    const paths: Record<(typeof PROPERTY_ENTITIES)[number], string> = {
      issue: `/rest/api/3/issue/${encodedId}/properties/${propertyKey}`,
      comment: `/rest/api/3/comment/${encodedId}/properties/${propertyKey}`,
      worklog: `/rest/api/3/issue/${encodeURIComponent(flags.issue ?? "")}/worklog/${encodedId}/properties/${propertyKey}`,
      "dashboard-item": `/rest/api/3/dashboard/${encodedId}/items/${encodeURIComponent(flags.item ?? "")}/properties/${propertyKey}`,
    };
    const sent = await planOrSend<undefined>(
      ctx,
      session.http,
      { method: "PUT", url: session.jiraUrl(paths[entity]), body: parsed.value },
      [applyArgv(ctx.argv)],
    );
    if (isPlan(sent)) {
      return sent;
    }
    return {
      entity,
      id,
      key: input.args.key,
      next: [
        [
          "atl",
          "property",
          "get",
          entity,
          id,
          input.args.key ?? "",
          ...(flags.issue === undefined ? [] : ["--issue", flags.issue]),
          ...(flags.item === undefined ? [] : ["--item", flags.item]),
        ],
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// version.related-work.set
// ---------------------------------------------------------------------------

interface RelatedWork {
  relatedWorkId?: string;
  category?: string;
  title?: string;
  url?: string;
  issueId?: number;
}

const versionRelatedWorkSet = defineCommand({
  name: "version.related-work.set",
  summary: "Add a related-work link to a project version, or update one with --id",
  mcpTools: ["manageJiraProjectVersionRelatedWork"],
  args: [{ name: "version", description: "Version id", required: true }],
  flags: Type.Object({
    category: Type.String({ description: 'Related-work category, e.g. "Design docs" or "Other"' }),
    title: Type.Optional(Type.String({ description: "Link title" })),
    url: Type.Optional(Type.String({ description: "Link URL" })),
    id: Type.Optional(
      Type.String({ description: "relatedWorkId of the link to update (omit to create)" }),
    ),
  }),
  sideEffects: "write",
  examples: [
    'atl version related-work set 10000 --category "Design docs" --title Spec --url https://example.com/spec',
    'atl version related-work set 10000 --id 6f2c... --category Other --title "New title" --url https://example.com',
  ],
  async run(ctx, input) {
    const { flags } = input;
    const version = input.args.version ?? "";
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const related = await sendWrite<RelatedWork>(
      ctx,
      session.http,
      {
        method: flags.id === undefined ? "POST" : "PUT",
        url: session.jiraUrl(`/rest/api/3/version/${encodeURIComponent(version)}/relatedwork`),
        body: {
          category: flags.category,
          ...(flags.id === undefined ? {} : { relatedWorkId: flags.id }),
          ...(flags.title === undefined ? {} : { title: flags.title }),
          ...(flags.url === undefined ? {} : { url: flags.url }),
        },
      },
      ["atl", "version", "related-work", "list", version],
    );
    if (isPlan(related) || ctx.full) {
      return related;
    }
    return {
      id: related.relatedWorkId,
      category: related.category,
      title: related.title,
      url: related.url,
      next: [["atl", "version", "related-work", "list", version]],
    };
  },
});

// ---------------------------------------------------------------------------
// issue.watch / issue.unwatch
// ---------------------------------------------------------------------------

const ACCOUNT_FLAG = {
  account: Type.Optional(
    Type.String({ description: "Account id to (un)watch as (default: the current user)" }),
  ),
};

const issueWatch = defineCommand({
  name: "issue.watch",
  summary: "Watch an issue (you, or --account)",
  mcpTools: ["watchJiraIssue"],
  args: [ISSUE_ARG],
  flags: Type.Object({ ...ACCOUNT_FLAG }),
  sideEffects: "write",
  examples: [
    "atl issue watch ABC-123",
    "atl issue watch ABC-123 --account 5b10ac8d82e05b22cc7d4ef5",
  ],
  async run(ctx, input) {
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      {
        method: "POST",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/watchers`),
        // The API takes the account id as a bare JSON string and defaults to the caller without one.
        ...(input.flags.account === undefined ? {} : { body: input.flags.account }),
      },
      ["atl", "issue", "get", rawKey],
    );
    return isPlan(sent)
      ? sent
      : {
          issue: rawKey,
          watching: true,
          ...(input.flags.account === undefined ? {} : { account: input.flags.account }),
        };
  },
});

const issueUnwatch = defineCommand({
  name: "issue.unwatch",
  summary: "Stop watching an issue (you, or --account)",
  args: [ISSUE_ARG],
  flags: Type.Object({ ...ACCOUNT_FLAG }),
  sideEffects: "write",
  examples: [
    "atl issue unwatch ABC-123",
    "atl issue unwatch ABC-123 --account 5b10ac8d82e05b22cc7d4ef5",
  ],
  async run(ctx, input) {
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    // DELETE has no "caller" default: accountId is required.
    const accountId =
      input.flags.account ?? (await currentAccountId(session, "Pass --account <accountId>."));
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      {
        method: "DELETE",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/watchers`),
        query: { accountId },
      },
      ["atl", "issue", "get", rawKey],
    );
    return isPlan(sent) ? sent : { issue: rawKey, watching: false };
  },
});

// ---------------------------------------------------------------------------
// issue.notify
// ---------------------------------------------------------------------------

/** `--to` tokens: reporter, assignee, watchers, voters, `user:<accountId>`, `group:<name>`. */
function notifyRecipients(tokens: readonly string[]): Record<string, unknown> {
  const to: Record<string, unknown> = {};
  const users: { accountId: string }[] = [];
  const groups: { name: string }[] = [];
  for (const token of tokens) {
    if (
      token === "reporter" ||
      token === "assignee" ||
      token === "watchers" ||
      token === "voters"
    ) {
      to[token] = true;
    } else if (token.startsWith("user:") && token.length > "user:".length) {
      users.push({ accountId: token.slice("user:".length) });
    } else if (token.startsWith("group:") && token.length > "group:".length) {
      groups.push({ name: token.slice("group:".length) });
    } else {
      throw inputError(
        "invalid_recipient",
        `Unknown --to value "${token}"`,
        "Use reporter, assignee, watchers, voters, user:<accountId>, or group:<name>.",
      );
    }
  }
  return {
    ...to,
    ...(users.length === 0 ? {} : { users }),
    ...(groups.length === 0 ? {} : { groups }),
  };
}

const issueNotify = defineCommand({
  name: "issue.notify",
  summary: "Email a notification about an issue to chosen recipients",
  args: [ISSUE_ARG],
  flags: Type.Object({
    subject: Type.String({ description: "Email subject" }),
    body: Type.String({ description: "Plain-text email body" }),
    htmlBody: Type.Optional(Type.String({ description: "HTML email body (optional)" })),
    to: Type.Array(Type.String(), {
      description:
        "Recipient: reporter, assignee, watchers, voters, user:<accountId>, group:<name>. Repeatable",
    }),
  }),
  sideEffects: "write",
  examples: [
    'atl issue notify ABC-123 --subject "Deploy done" --body "Shipped" --to watchers --to assignee',
    'atl issue notify ABC-123 --subject Heads-up --body "See notes" --to user:5b10ac8d82e05b22cc7d4ef5 --plan',
  ],
  async run(ctx, input) {
    const { flags } = input;
    if (flags.to.length === 0) {
      throw inputError("recipients_required", "Pass at least one --to recipient");
    }
    const to = notifyRecipients(flags.to);
    const { session, key, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const sent = await sendWrite<undefined>(
      ctx,
      session.http,
      {
        method: "POST",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/notify`),
        body: {
          subject: flags.subject,
          textBody: flags.body,
          ...(flags.htmlBody === undefined ? {} : { htmlBody: flags.htmlBody }),
          to,
        },
      },
      ["atl", "issue", "get", rawKey],
    );
    return isPlan(sent) ? sent : { notified: rawKey, to: flags.to };
  },
});

export const jiraWriteCommands: readonly CommandSpec[] = [
  issueCreate,
  issueUpdate,
  issueComment,
  issueMove,
  issueLog,
  issueLink,
  issueDelete,
  issueCommentDelete,
  issueRemoteLinkAdd,
  issueRemoteLinkDelete,
  propertySet,
  versionRelatedWorkSet,
  issueWatch,
  issueUnwatch,
  issueNotify,
];
