import { Type } from "../core/schema.ts";
import type { AdfDoc } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, inputError } from "../core/errors.ts";
import type { FetchLike, Query } from "../core/http.ts";
import { isRecord } from "../core/guards.ts";
import { keepRaw, splitList, writeDiagnostic } from "../core/output.ts";
import {
  paginateJiraOffset,
  paginateJiraToken,
  SAFETY_CAP,
  type JiraOffsetPage,
  type JiraTokenPage,
  type Paged,
  type PagePolicy,
} from "../core/paginate.ts";
import { openSession, type Session } from "../core/session.ts";
import { parseJiraRef } from "../resolve/index.ts";
import {
  ADF_FORMAT_FLAG,
  PAGING_FLAGS,
  pagePolicy,
  renderAdf,
  shortTs,
  type AdfFormat,
  type PagingFlags,
} from "./common.ts";
import { snippet } from "./confluence.ts";

/** Test seam: a fake `fetch` used by every Jira command when set. */
export const jiraDeps: { fetch?: FetchLike | undefined } = {};

export const jiraGroups: Readonly<Record<string, string>> = {
  issue: "Read, create, edit, comment on, transition, link, tree, and log work on Jira issues",
  project: "List Jira projects, issue types, and create fields",
  status: "List Jira statuses",
  component: "List Jira project components",
  version: "List and read Jira project versions (releases) and their related work",
  "version related-work": "Related work attached to a Jira version",
  filter: "List saved Jira filters",
  dashboard: "List Jira dashboards",
  property: "Read Jira entity properties (issue, comment, worklog, dashboard item, project)",
  field: "List Jira fields",
  priority: "List Jira priorities",
  resolution: "List Jira resolutions",
};

export const DEFAULT_ISSUE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
  "parent",
  "created",
  "updated",
  "description",
  "project",
];

// ---------------------------------------------------------------------------
// API shapes (only the parts we read)
// ---------------------------------------------------------------------------

interface JiraUser {
  accountId?: string;
  displayName?: string;
}

interface JiraStatus {
  id?: string;
  name?: string;
  statusCategory?: { key?: string; name?: string };
}

interface JiraIssueRef {
  id?: string;
  key?: string;
  fields?: { summary?: string; status?: JiraStatus };
}

interface JiraIssueLink {
  id?: string;
  type?: { id?: string; name?: string; inward?: string; outward?: string };
  inwardIssue?: JiraIssueRef;
  outwardIssue?: JiraIssueRef;
}

interface JiraIssueFields {
  summary?: string;
  status?: JiraStatus;
  issuetype?: { name?: string };
  priority?: { name?: string } | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  labels?: string[];
  parent?: JiraIssueRef | null;
  project?: { key?: string; name?: string };
  created?: string;
  updated?: string;
  description?: AdfDoc | null;
  issuelinks?: JiraIssueLink[];
  [field: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields?: JiraIssueFields;
  [property: string]: unknown;
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  created?: string;
  updated?: string;
  body?: AdfDoc | null;
}

interface CommentPage {
  startAt?: number;
  total?: number;
  comments?: JiraComment[];
}

interface FieldMeta {
  fieldId?: string;
  key?: string;
  name?: string;
  required?: boolean;
  hasDefaultValue?: boolean;
  schema?: { type?: string; custom?: string };
  allowedValues?: { name?: string; value?: string; id?: string }[];
}

export interface IssueTypeMeta {
  id: string;
  name?: string;
  untranslatedName?: string;
  subtask?: boolean;
  description?: string;
}

interface CreateMetaPage<T> {
  startAt?: number;
  total?: number;
  isLast?: boolean;
  issueTypes?: T[];
  createMetaIssueType?: T[];
  fields?: T[];
  results?: T[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `key` is URL-encoded for paths; `rawKey` is the plain key or id for bodies and `next` hints. */
export function issueSession(
  ctx: CommandContext,
  input: string,
): Promise<{ session: Session; key: string; rawKey: string }> {
  const ref = parseJiraRef(input);
  const rawKey = ref.key ?? ref.id ?? input;
  return openSession(ctx, {
    siteHint: ref.site,
    cloudId: ref.cloudId,
    fetch: jiraDeps.fetch,
  }).then((session) => ({
    session,
    key: encodeURIComponent(rawKey),
    rawKey,
  }));
}

function user(value: JiraUser | null | undefined): Record<string, unknown> | undefined {
  return value === null || value === undefined
    ? undefined
    : { accountId: value.accountId, name: value.displayName };
}

function body(
  value: AdfDoc | null | undefined,
  format: AdfFormat | undefined,
): string[] | AdfDoc | undefined {
  return value === null || value === undefined ? undefined : renderAdf(value, format);
}

/** Compact comment: author as display name; `updated` only when it differs from `created`. */
export function compactComment(comment: JiraComment, format: AdfFormat | undefined) {
  const created = shortTs(comment.created);
  const updated = shortTs(comment.updated);
  return {
    id: comment.id,
    author: userName(comment.author),
    created,
    updated: updated === created ? undefined : updated,
    body: body(comment.body, format),
  };
}

const COMPACT_FIELD_KEYS: ReadonlySet<string> = new Set([...DEFAULT_ISSUE_FIELDS, "issuelinks"]);
const COMPACT_ISSUE_KEYS: ReadonlySet<string> = new Set(["id", "key", "fields", "self", "expand"]);

/** API fields a `jql` list item asks for by default; `--issue-fields` replaces this list. */
const LIST_ISSUE_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];

/** Display label of a Jira value object: user, named entity (component, version, status), option, or issue reference. */
function recordLabel(value: Record<string, unknown>): string | undefined {
  const label = [value.displayName, value.name, value.value, value.key].find(
    (v) => typeof v === "string" && v !== "",
  );
  return typeof label === "string" ? label : undefined;
}

/**
 * Compact value of an extra field: user, option, component, version and issue objects become
 * their label, arrays map element-wise, numbers and other objects stay as the API sent them.
 */
function fieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(fieldValue);
  }
  return isRecord(value) ? (recordLabel(value) ?? value) : value;
}

/**
 * Compact issue shape, one for `jql` items and `issue get`. `list` gives a minimal item (people as
 * display names, no id/url/statusCategory) containing only the fields that were requested;
 * otherwise the richer single-issue view (accountIds, id, url). Requested fields outside the
 * compact set (components, custom fields, ...) are hoisted to the top level under their API key
 * (or the `names` alias) with `fieldValue` compaction. `*all`'s top-level expansions
 * (`renderedFields`, `names`, `properties`, ...) are carried through raw.
 */
export function compactIssue(
  session: Session,
  issue: JiraIssue,
  format: AdfFormat | undefined,
  withDescription: boolean,
  list = false,
  names: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> {
  const f = issue.fields ?? {};
  const extraFields = Object.fromEntries(
    Object.entries(f)
      .filter(([name]) => !COMPACT_FIELD_KEYS.has(name))
      .map(([name, value]) => [names.get(name) ?? name, fieldValue(value)]),
  );
  const parent = f.parent ?? undefined;
  return {
    key: issue.key,
    id: list ? undefined : issue.id,
    summary: f.summary,
    status: f.status?.name,
    statusCategory: list ? undefined : f.status?.statusCategory?.key,
    type: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: list ? f.assignee?.displayName : user(f.assignee),
    reporter: list ? f.reporter?.displayName : user(f.reporter),
    labels: f.labels,
    parent: parent && { key: parent.key, summary: parent.fields?.summary },
    project: list ? f.project?.key : f.project && { key: f.project.key, name: f.project.name },
    created: shortTs(f.created),
    updated: shortTs(f.updated),
    description: withDescription ? body(f.description, format) : undefined,
    url: list ? undefined : session.siteUrl(`/browse/${encodeURIComponent(issue.key)}`),
    ...extraFields,
    ...Object.fromEntries(Object.entries(issue).filter(([name]) => !COMPACT_ISSUE_KEYS.has(name))),
  };
}

function fieldList(raw: string | undefined, fallback: readonly string[]): string[] {
  const list = splitList(raw);
  return list.length === 0 ? [...fallback] : list;
}

export function fetchFields(session: Session): Promise<FieldRecord[]> {
  return session.http.request<FieldRecord[]>({
    method: "GET",
    url: session.jiraUrl("/rest/api/3/field"),
  });
}

/** Fields whose custom id differs per site, found by their English JQL clause name and shown under a stable key. */
const NAMED_CUSTOM_FIELDS: readonly { clause: string; name: string }[] = [
  { clause: "Start date", name: "startdate" },
  { clause: "Flagged", name: "flagged" },
];

/** Custom field id -> output key for `NAMED_CUSTOM_FIELDS` on this site. */
async function namedCustomFields(session: Session): Promise<Map<string, string>> {
  const fields = await fetchFields(session);
  const names = new Map<string, string>();
  for (const { clause, name } of NAMED_CUSTOM_FIELDS) {
    const id = fields.find((f) => f.custom === true && f.clauseNames?.includes(clause))?.id;
    if (id !== undefined) {
      names.set(id, name);
    }
  }
  return names;
}

const ISSUE_FIELDS_FLAG = Type.Optional(
  Type.String({ description: "Comma-separated Jira field ids to request (API `fields`)" }),
);

export const ISSUE_ARG = {
  name: "issue",
  description: "Issue key, id, URL, or ARI",
  required: true,
};
const PROJECT_ARG = { name: "project", description: "Project key or id", required: true };

/** A project key or id as Jira's paths need it: keys are uppercase there, so `kan` reads as `KAN`. */
export function projectKey(input: string): string {
  const text = input.trim();
  return /^\d+$/.test(text) ? text : text.toUpperCase();
}

// ---------------------------------------------------------------------------
// issue.*
// ---------------------------------------------------------------------------

const issueGet = defineCommand({
  name: "issue.get",
  summary: "Get one issue with its description",
  mcpTools: ["getJiraIssue"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    format: ADF_FORMAT_FLAG,
    issueFields: ISSUE_FIELDS_FLAG,
    fieldsByKeys: Type.Optional(
      Type.Boolean({ description: "Treat --issue-fields entries as field keys instead of ids" }),
    ),
    expand: Type.Optional(
      Type.String({
        description: "Comma-separated expansions (renderedFields, names, changelog, ...)",
      }),
    ),
    properties: Type.Optional(
      Type.String({ description: "Comma-separated issue property keys to include" }),
    ),
    updateHistory: Type.Optional(
      Type.Boolean({ description: "Add the issue to the user's recently viewed history" }),
    ),
    failFast: Type.Optional(
      Type.Boolean({
        description: "Fail when some fields cannot be loaded instead of partial data",
      }),
    ),
    comments: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 100,
        description: "Include the N newest comments",
        default: 0,
      }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl issue get ABC-123",
    "atl issue get ABC-123 --comments 5 --format adf",
    "atl issue get ABC-123 --issue-fields '*all' --expand renderedFields",
  ],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const { flags } = input;
    const requested = splitList(flags.issueFields);
    // Without --issue-fields, compact output also shows due date, start date and flagged when set;
    // --full asks for every field, like the raw API with `*all`.
    const named =
      requested.length === 0 && !ctx.full
        ? await namedCustomFields(session)
        : new Map<string, string>();
    let fields = requested;
    if (requested.length === 0) {
      fields = ctx.full ? ["*all"] : [...DEFAULT_ISSUE_FIELDS, "duedate", ...named.keys()];
    }
    const issue = await session.http.request<JiraIssue>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}`),
      query: {
        fields: fields.join(","),
        fieldsByKeys: flags.fieldsByKeys,
        expand: flags.expand,
        properties: flags.properties,
        updateHistory: flags.updateHistory,
        failFast: flags.failFast,
      },
    });
    const count = flags.comments ?? 0;
    let comments: JiraComment[] | undefined;
    if (count > 0) {
      const page = await session.http.request<CommentPage>({
        method: "GET",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/comment`),
        query: { orderBy: "-created", maxResults: count },
      });
      comments = page.comments ?? [];
    }
    if (ctx.full) {
      return comments === undefined ? issue : { ...issue, comments };
    }
    const compact = compactIssue(
      session,
      issue,
      flags.format,
      fields.includes("description") || fields.includes("*all"),
      false,
      named,
    );
    if (comments === undefined) {
      return compact;
    }
    return { ...compact, comments: comments.map((c) => compactComment(c, flags.format)) };
  },
});

export interface Transition {
  id: string;
  name?: string;
  hasScreen?: boolean;
  isAvailable?: boolean;
  to?: JiraStatus;
  fields?: unknown;
}

const issueTransitions = defineCommand({
  name: "issue.transitions",
  summary: "List transitions available for an issue",
  mcpTools: ["getTransitionsForJiraIssue", "listJiraIssueTransitions"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    expand: Type.Optional(
      Type.String({ description: "Comma-separated expansions, e.g. transitions.fields" }),
    ),
    transitionId: Type.Optional(Type.String({ description: "Return only this transition id" })),
    skipRemoteOnlyCondition: Type.Optional(
      Type.Boolean({ description: "Skip remote-only workflow conditions" }),
    ),
    includeUnavailableTransitions: Type.Optional(
      Type.Boolean({ description: "Include transitions whose conditions are not met" }),
    ),
    sortByOpsBarAndStatus: Type.Optional(
      Type.Boolean({ description: "Sort by ops bar sequence, then target status" }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl issue transitions ABC-123",
    "atl issue transitions ABC-123 --expand transitions.fields --include-unavailable-transitions",
  ],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const { flags } = input;
    const page = await session.http.request<{ transitions?: Transition[] }>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}/transitions`),
      query: {
        expand: flags.expand,
        transitionId: flags.transitionId,
        skipRemoteOnlyCondition: flags.skipRemoteOnlyCondition,
        includeUnavailableTransitions: flags.includeUnavailableTransitions,
        sortByOpsBarAndStatus: flags.sortByOpsBarAndStatus,
      },
    });
    const transitions = page.transitions ?? [];
    if (ctx.full) {
      return { items: transitions, nextCursor: null };
    }
    return {
      items: transitions.map((t) => ({
        id: t.id,
        name: t.name,
        to: t.to?.name,
        hasScreen: t.hasScreen === true ? true : undefined,
        isAvailable: t.isAvailable === false ? false : undefined,
        fields: t.fields,
      })),
    };
  },
});

interface RemoteLink {
  id: number | string;
  globalId?: string;
  relationship?: string;
  application?: { type?: string; name?: string };
  object?: { title?: string; url?: string };
}

/** Flat link item: `relation` is the phrase from this issue's side (e.g. "blocks"), so no direction field. */
export function compactIssueLink(link: JiraIssueLink) {
  const outward = link.outwardIssue !== undefined;
  const other = (outward ? link.outwardIssue : link.inwardIssue) ?? {};
  return {
    id: link.id,
    type: link.type?.name,
    relation: outward ? link.type?.outward : link.type?.inward,
    key: other.key,
    summary: other.fields?.summary,
    status: other.fields?.status?.name,
  };
}

/** Chain entry; `branches` appears only when more than one link matched at this step. */
interface ChainStep {
  key: string | undefined;
  summary: string | undefined;
  status: string | undefined;
  branches?: string[];
}

/**
 * Follow the first link whose relation matches (case-insensitive) from each issue in turn.
 * `max` bounds the links followed; a repeated key stops with `cycle`. When the start issue has
 * no matching link, `relations` lists the ones it does have.
 */
async function walkLinkChain(session: Session, startKey: string, relation: string, max: number) {
  const wanted = relation.trim().toLowerCase();
  const chain: ChainStep[] = [];
  const seen = new Set<string>();
  let path = startKey;
  for (;;) {
    const issue = await session.http.request<JiraIssue>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${path}`),
      query: { fields: "summary,status,issuelinks" },
    });
    const links = (issue.fields?.issuelinks ?? []).map(compactIssueLink);
    const matches = links.filter(
      (l) => l.relation?.toLowerCase() === wanted && l.key !== undefined,
    );
    const others = matches.slice(1).flatMap((m) => (m.key === undefined ? [] : [m.key]));
    chain.push({
      key: issue.key,
      summary: issue.fields?.summary,
      status: issue.fields?.status?.name,
      ...(others.length > 0 ? { branches: others } : {}),
    });
    seen.add(issue.key ?? path);
    const next = matches[0]?.key;
    if (next === undefined) {
      const relations = chain.length === 1 ? [...new Set(links.map((l) => l.relation))] : undefined;
      return { chain, stoppedBy: "end", relations };
    }
    if (seen.has(next)) {
      return { chain, stoppedBy: "cycle", cycleTo: next };
    }
    if (chain.length > max) {
      return { chain, stoppedBy: "max" };
    }
    path = encodeURIComponent(next);
  }
}

const issueLinks = defineCommand({
  name: "issue.links",
  summary: "List issue links (or remote links with --remote)",
  mcpTools: ["getJiraIssueRemoteIssueLinks", "listJiraIssueRemoteIssueLinks"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    remote: Type.Optional(Type.Boolean({ description: "List remote (web) links instead" })),
    chain: Type.Optional(
      Type.String({
        description:
          'Walk links with this relation (e.g. "is blocked by"; case-insensitive), following the first match per issue; returns {chain:[{key,summary,status,branches?}], stoppedBy:end|cycle|max, cycleTo?}; branches lists the other matching keys at that step, cycleTo the key a cycle closes on; plus relations when the start issue has no match',
      }),
    ),
    max: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Links followed by --chain (default 20)",
      }),
    ),
    globalId: Type.Optional(
      Type.String({
        description: "Return only the remote link with this globalId (implies --remote)",
      }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl issue links ABC-123",
    "atl issue links ABC-123 --remote",
    'atl issue links ABC-123 --global-id "system=https://example.com&id=1"',
    'atl issue links ABC-123 --chain "is blocked by"',
  ],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    if (input.flags.chain !== undefined) {
      conflictingFlags("--chain", input.flags, ["remote", "globalId"]);
      return walkLinkChain(session, key, input.flags.chain, input.flags.max ?? 20);
    }
    if (input.flags.remote === true || input.flags.globalId !== undefined) {
      const globalId = input.flags.globalId;
      const response = await session.http
        .request<RemoteLink | RemoteLink[]>({
          method: "GET",
          url: session.jiraUrl(`/rest/api/3/issue/${key}/remotelink`),
          query: { globalId },
        })
        .catch((error: unknown) => {
          // Jira answers a globalId with no link by 404; here that means an empty list.
          if (globalId !== undefined && error instanceof AtlError && error.status === 404) {
            return [];
          }
          throw error;
        });
      const links = Array.isArray(response) ? response : [response];
      if (ctx.full) {
        return { items: links, nextCursor: null };
      }
      return {
        items: links.map((l) => ({
          id: String(l.id),
          globalId: l.globalId,
          title: l.object?.title,
          url: l.object?.url,
          relationship: l.relationship,
          application: l.application?.name ?? l.application?.type,
        })),
      };
    }
    const [issue, remote] = await Promise.all([
      session.http.request<JiraIssue>({
        method: "GET",
        url: session.jiraUrl(`/rest/api/3/issue/${key}`),
        query: { fields: "issuelinks" },
      }),
      ctx.full
        ? undefined
        : session.http.request<RemoteLink[]>({
            method: "GET",
            url: session.jiraUrl(`/rest/api/3/issue/${key}/remotelink`),
          }),
    ]);
    const links = issue.fields?.issuelinks ?? [];
    return {
      items: ctx.full ? links : links.map(compactIssueLink),
      // Remote links are listed only with --remote; the count tells the agent they exist.
      remote: remote === undefined || remote.length === 0 ? undefined : remote.length,
    };
  },
});

const issueLinkTypes = defineCommand({
  name: "issue.link-types",
  summary: "List issue link types",
  mcpTools: ["getIssueLinkTypes", "listJiraIssueLinkTypes"],
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl issue link-types"],
  async run(ctx) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const page = await session.http.request<{
      issueLinkTypes?: { id: string; name?: string; inward?: string; outward?: string }[];
    }>({ method: "GET", url: session.jiraUrl("/rest/api/3/issueLinkType") });
    const types = page.issueLinkTypes ?? [];
    if (ctx.full) {
      return { items: types, nextCursor: null };
    }
    return {
      items: types.map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward })),
    };
  },
});

const issueComments = defineCommand({
  name: "issue.comments",
  mcpTools: ["listJiraIssueComments"],
  summary: "List comments on an issue",
  args: [ISSUE_ARG],
  flags: Type.Object({ format: ADF_FORMAT_FLAG, ...PAGING_FLAGS }),
  sideEffects: "none",
  examples: ["atl issue comments ABC-123 --limit 10"],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const paged = await paginateJiraOffset(
      pagePolicy(input.flags, { defaultLimit: 25, maxPageSize: 100 }),
      (page: CommentPage) => page.comments ?? [],
      ({ startAt, pageSize }) =>
        session.http.request<CommentPage>({
          method: "GET",
          url: session.jiraUrl(`/rest/api/3/issue/${key}/comment`),
          query: { startAt, maxResults: pageSize },
        }),
    );
    if (ctx.full) {
      return paged;
    }
    return { ...paged, items: paged.items.map((c) => compactComment(c, input.flags.format)) };
  },
});

// ---------------------------------------------------------------------------
// jql
// ---------------------------------------------------------------------------

/** One `search/jql` read paged by `nextPageToken`; `fields` is the API's comma-separated list. */
export function searchJql<T = JiraIssue>(
  session: Session,
  policy: PagePolicy,
  jql: string,
  fields: string,
): Promise<Paged<T>> {
  return paginateJiraToken(
    policy,
    (page: JiraTokenPage & { issues?: T[] }) => page.issues ?? [],
    ({ cursor, pageSize }) =>
      session.http.request<JiraTokenPage & { issues?: T[] }>({
        method: "GET",
        url: session.jiraUrl("/rest/api/3/search/jql"),
        query: {
          jql,
          fields,
          maxResults: pageSize,
          ...(cursor === undefined ? {} : { nextPageToken: cursor }),
        },
      }),
  );
}

/** Approximate hit count for a JQL (`search/jql` itself returns no total). */
export async function approximateCount(session: Session, jql: string): Promise<number> {
  const counted = await session.http.request<{ count?: number }>({
    method: "POST",
    url: session.jiraUrl("/rest/api/3/search/approximate-count"),
    body: { jql },
  });
  return counted.count ?? 0;
}

/** `--group-by` aliases: the API field to request and the path inside its value. */
const GROUP_ALIASES: Readonly<Record<string, { field: string; path: readonly string[] }>> = {
  status: { field: "status", path: [] },
  statusCategory: { field: "status", path: ["statusCategory"] },
  assignee: { field: "assignee", path: [] },
  type: { field: "issuetype", path: [] },
  priority: { field: "priority", path: [] },
  project: { field: "project", path: ["key"] },
};

/** Group labels of one field value: arrays contribute one label per element, empty is "(none)". */
function groupLabels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(groupLabels);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value === "" ? [] : [String(value)];
  }
  if (isRecord(value)) {
    const label = recordLabel(value);
    return label === undefined ? [] : [label];
  }
  return [];
}

interface GroupSpec {
  field: string;
  path: readonly string[];
}

/** The API field to request for a `--group-by` name, and the path inside its value. */
async function groupSpec(session: Session, groupBy: string): Promise<GroupSpec> {
  return GROUP_ALIASES[groupBy] ?? { field: await resolveFieldId(session, groupBy), path: [] };
}

/** Issue counts per group label, largest first; issues without a value count under "(none)". */
function countGroups(issues: readonly JiraIssue[], spec: GroupSpec): Record<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    let value: unknown = issue.fields?.[spec.field];
    for (const step of spec.path) {
      value = isRecord(value) ? value[step] : undefined;
    }
    const labels = groupLabels(value);
    for (const label of labels.length === 0 ? ["(none)"] : labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts].toSorted((a, b) => b[1] - a[1]));
}

/**
 * Count issues per field value, paging every result with only that field requested. `total` is
 * the number of issues read, or the approximate count of the whole query when the 1000-issue
 * cap cut the read (`capped`).
 */
async function groupIssues(session: Session, query: string, groupBy: string) {
  const spec = await groupSpec(session, groupBy);
  const paged = await searchJql(
    session,
    { all: true, defaultLimit: SAFETY_CAP, maxPageSize: 100 },
    query,
    spec.field,
  );
  const groups = countGroups(paged.items, spec);
  if (paged.items.length === 0) {
    await warnIfInvalid(session, query);
  }
  const capped = paged.truncated === true;
  return {
    total: capped ? await approximateCount(session, query) : paged.items.length,
    groups,
    capped: capped ? true : undefined,
  };
}

const fieldNames = (f: FieldRecord) => [f.name, f.untranslatedName, ...(f.clauseNames ?? [])];
const describeField = (f: FieldRecord) => `${f.id ?? "?"} (${f.name ?? "unnamed"})`;

/**
 * Field id for an id, name, localized name or JQL clause name (case-insensitive). An unknown or
 * ambiguous name is an input error: the API silently ignores unknown `fields`, which would read
 * as "no issue has a value".
 */
async function resolveFieldId(session: Session, wanted: string): Promise<string> {
  const fields = await fetchFields(session);
  const needle = wanted.trim().toLowerCase();
  const byId = fields.filter((f) => f.id?.toLowerCase() === needle);
  const found =
    byId.length > 0
      ? byId
      : fields.filter((f) => fieldNames(f).some((n) => n?.toLowerCase() === needle));
  const [only] = found;
  if (found.length === 1 && only?.id !== undefined) {
    return only.id;
  }
  if (found.length > 1) {
    throw inputError(
      "ambiguous_field",
      `Field "${wanted}" matches ${found.length} fields: ${found.map(describeField).join(", ")}`,
      "Use the field id.",
    );
  }
  // Close = substring either way, or the same first four letters (a typo late in the name).
  const prefix = needle.slice(0, 4);
  const close = fields
    .filter((f) =>
      [f.id, ...fieldNames(f)].some((n) => {
        const text = n?.toLowerCase();
        return (
          text !== undefined &&
          (text.includes(needle) ||
            (text.length >= 3 && needle.includes(text)) ||
            (prefix.length === 4 && text.startsWith(prefix)))
        );
      }),
    )
    .slice(0, 5);
  throw inputError(
    "unknown_field",
    `Unknown field "${wanted}".${close.length > 0 ? ` Close matches: ${close.map(describeField).join(", ")}` : ""}`,
    "Pass a field id or name from `atl field list`.",
  );
}

interface ParsedQuery {
  query?: string;
  errors?: string[];
  structure?: unknown;
}

function parseJql(session: Session, queries: readonly string[], validation: string) {
  return session.http.request<{ queries?: ParsedQuery[] }>({
    method: "POST",
    url: session.jiraUrl("/rest/api/3/jql/parse", { validation }),
    body: { queries },
  });
}

/** `childIssuesOf(KEY)` in a JQL: the issue key it was given. */
const CHILD_ISSUES_OF = /\bchildIssuesOf\s*\(\s*["']?([A-Za-z][A-Za-z0-9]*-\d+)["']?\s*\)/i;

/**
 * Jira answers a JQL naming a field or value that does not exist (a localized status name, a
 * typo) with an empty result, not an error. After an empty result, say so on stderr. A
 * `childIssuesOf` query that finds nothing (it returned no hits on the trial site, where
 * `parent = KEY` works) also gets a pointer to `issue tree`.
 */
async function warnIfInvalid(session: Session, query: string): Promise<void> {
  const parent = CHILD_ISSUES_OF.exec(query)?.[1];
  if (parent !== undefined) {
    writeDiagnostic({
      type: "hint",
      code: "child_issues_of_empty",
      hint: "childIssuesOf() matched nothing here; `atl issue tree` lists everything under an issue, sub-tasks included",
      next: [["atl", "issue", "tree", parent.toUpperCase()]],
    });
  }
  const parsed = await parseJql(session, [query], "strict");
  const errors = parsed.queries?.[0]?.errors ?? [];
  if (errors.length === 0) {
    return;
  }
  writeDiagnostic({
    type: "warning",
    code: "jql_invalid",
    message:
      "No issues matched, and Jira reports errors in the JQL; the empty result may be a query mistake",
    errors,
    next: errors.some((e) => e.includes("'status'"))
      ? [["atl", "jql-suggest", "--field", "status"]]
      : undefined,
  });
}

/** A Jira issues URL carries its JQL in the `jql` parameter; anything else is the JQL itself. */
function jqlText(input: string): string {
  const text = input.trim();
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (url?.protocol !== "https:" && url?.protocol !== "http:") {
    return input;
  }
  const jql = url.searchParams.get("jql");
  if (jql === null) {
    throw inputError(
      "invalid_jql_url",
      `The URL has no jql parameter: ${input}`,
      "Pass the JQL text, or an issues URL with ?jql=...",
    );
  }
  return jql;
}

const jql = defineCommand({
  name: "jql",
  summary:
    "Search issues with JQL (compact items: key, summary, status, type, priority, assignee, updated; URL is <site>/browse/<key>)",
  mcpTools: ["searchJiraIssuesUsingJql"],
  args: [{ name: "query", description: "JQL query", required: true }],
  flags: Type.Object({
    format: ADF_FORMAT_FLAG,
    issueFields: ISSUE_FIELDS_FLAG,
    resultMode: Type.Optional(
      Type.Union([Type.Literal("issues"), Type.Literal("count"), Type.Literal("all")], {
        description: "issues (default), count only (approximate), or count plus issues",
      }),
    ),
    groupBy: Type.Optional(
      Type.String({
        description:
          "Count issues per value of status, assignee, type, priority, statusCategory, project, or any field id/name; returns {total, groups:{value:count}} (all pages up to 1000 issues; capped:true when cut)",
      }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    'atl jql "project = ABC AND statusCategory != Done ORDER BY updated DESC"',
    'atl jql "assignee = currentUser()" --issue-fields summary,status,description --all',
    'atl jql "project = ABC AND resolution = Unresolved" --result-mode count',
    'atl jql "project = ABC" --group-by status',
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const query = jqlText(input.args.query ?? "");
    if (input.flags.groupBy !== undefined) {
      conflictingFlags("--group-by", input.flags, ["limit", "cursor", "issueFields", "resultMode"]);
      return groupIssues(session, query, input.flags.groupBy);
    }
    const mode = input.flags.resultMode ?? "issues";
    let count: number | undefined;
    if (mode !== "issues") {
      count = await approximateCount(session, query);
      if (mode === "count") {
        if (count === 0) {
          await warnIfInvalid(session, query);
        }
        return { count };
      }
    }
    const fields = fieldList(input.flags.issueFields, LIST_ISSUE_FIELDS);
    const paged = await searchJql(
      session,
      pagePolicy(input.flags, { defaultLimit: 25, maxPageSize: 100 }),
      query,
      fields.join(","),
    );
    if (paged.items.length === 0 && input.flags.cursor === undefined) {
      await warnIfInvalid(session, query);
    }
    const rendered = ctx.full
      ? paged
      : {
          ...paged,
          items: paged.items.map((issue) =>
            compactIssue(
              session,
              issue,
              input.flags.format,
              fields.includes("description") || fields.includes("*all"),
              true,
            ),
          ),
        };
    return count === undefined ? rendered : { count, ...rendered };
  },
});

const TREE_BATCH = 50;
const TREE_MAX_DEPTH = 10;

interface TreeEntry {
  issue: JiraIssue;
  depth: number;
}

/**
 * Descendants of `rootKey`, level by level: one `parent in (...)` search per batch of keys of the
 * previous level. Each issue is visited once, so a parent cycle cannot loop. `capped` is true when
 * more issues exist beyond `limit`, or the walk stopped at the depth guard with a level still open.
 */
async function walkTree(
  session: Session,
  rootKey: string,
  options: { maxDepth: number; limit: number; fields: string },
): Promise<{ entries: TreeEntry[]; capped: boolean }> {
  const seen = new Set([rootKey]);
  const entries: TreeEntry[] = [];
  let frontier = [rootKey];
  for (let depth = 1; frontier.length > 0; depth++) {
    if (depth > options.maxDepth) {
      return { entries, capped: options.maxDepth === TREE_MAX_DEPTH };
    }
    const next: string[] = [];
    for (let at = 0; at < frontier.length; at += TREE_BATCH) {
      const room = options.limit - entries.length;
      const paged = await searchJql(
        session,
        { limit: room + 1, defaultLimit: room + 1, maxPageSize: 100 },
        `parent in (${frontier.slice(at, at + TREE_BATCH).join(",")}) ORDER BY key ASC`,
        options.fields,
      );
      for (const issue of paged.items) {
        if (seen.has(issue.key)) {
          continue;
        }
        if (entries.length >= options.limit) {
          return { entries, capped: true };
        }
        seen.add(issue.key);
        entries.push({ issue, depth });
        next.push(issue.key);
      }
      if (paged.nextCursor !== null && entries.length >= options.limit) {
        return { entries, capped: true };
      }
    }
    frontier = next;
  }
  return { entries, capped: false };
}

const issueTree = defineCommand({
  name: "issue.tree",
  summary:
    "List everything under an epic or issue (children, their sub-tasks, deeper levels) in one call, or count it per field with --group-by; items carry depth and parent",
  args: [ISSUE_ARG],
  flags: Type.Object({
    format: ADF_FORMAT_FLAG,
    issueFields: ISSUE_FIELDS_FLAG,
    depth: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: TREE_MAX_DEPTH,
        description: "Levels below the issue to include (default: all, up to 10)",
      }),
    ),
    groupBy: Type.Optional(
      Type.String({
        description:
          "Count descendants per value of status, assignee, type, priority, statusCategory, project, or any field id/name; returns {root, total, groups:{value:count}}",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: SAFETY_CAP,
        description: "Most descendants to read (default and maximum 1000; capped:true when cut)",
      }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl issue tree ABC-1",
    "atl issue tree ABC-1 --group-by status",
    "atl issue tree ABC-1 --depth 1 --issue-fields summary,assignee",
  ],
  async run(ctx, input) {
    const { flags } = input;
    if (flags.groupBy !== undefined) {
      conflictingFlags("--group-by", flags, ["issueFields"]);
    }
    const { session, rawKey } = await issueSession(ctx, input.args.issue ?? "");
    const group = flags.groupBy === undefined ? undefined : await groupSpec(session, flags.groupBy);
    const requested = fieldList(flags.issueFields, LIST_ISSUE_FIELDS);
    const fields = group
      ? [group.field]
      : requested.includes("*all") || requested.includes("parent")
        ? requested
        : [...requested, "parent"];
    const root = await session.http.request<JiraIssue>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${encodeURIComponent(rawKey)}`),
      query: { fields: "summary,status,issuetype" },
    });
    const { entries, capped } = await walkTree(session, root.key, {
      maxDepth: flags.depth ?? TREE_MAX_DEPTH,
      limit: flags.limit ?? SAFETY_CAP,
      fields: fields.join(","),
    });
    const head = {
      root: {
        key: root.key,
        summary: root.fields?.summary,
        status: root.fields?.status?.name,
        type: root.fields?.issuetype?.name,
      },
      total: entries.length,
    };
    if (group !== undefined) {
      return {
        ...head,
        groups: countGroups(
          entries.map((entry) => entry.issue),
          group,
        ),
        capped: capped ? true : undefined,
      };
    }
    const withDescription = fields.includes("description") || fields.includes("*all");
    return {
      ...head,
      items: entries.map(({ issue, depth }) =>
        ctx.full
          ? Object.assign(issue, { depth })
          : Object.assign(compactIssue(session, issue, flags.format, withDescription, true), {
              parent: issue.fields?.parent?.key,
              depth,
            }),
      ),
      capped: capped ? true : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// project.*
// ---------------------------------------------------------------------------

interface ProjectSearchPage {
  startAt?: number;
  total?: number;
  isLast?: boolean;
  values?: {
    id: string;
    key: string;
    name?: string;
    projectTypeKey?: string;
    style?: string;
    issueTypes?: IssueTypeMeta[];
  }[];
}

const projectList = defineCommand({
  name: "project.list",
  summary: "List projects visible to you (browse URL is <site>/browse/<key>)",
  mcpTools: ["getVisibleJiraProjects", "listJiraProjects"],
  args: [],
  flags: Type.Object({
    query: Type.Optional(Type.String({ description: "Filter by key or name substring" })),
    action: Type.Optional(
      Type.Union(
        [
          Type.Literal("view"),
          Type.Literal("browse"),
          Type.Literal("edit"),
          Type.Literal("create"),
        ],
        { description: "Only projects where you can perform this action" },
      ),
    ),
    expandIssueTypes: Type.Optional(
      Type.Boolean({ description: "Include each project's issue types" }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl project list",
    "atl project list --query platform --all",
    "atl project list --action create --expand-issue-types",
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const paged = await paginateJiraOffset(
      pagePolicy(input.flags, { defaultLimit: 50, maxPageSize: 50 }),
      (page: ProjectSearchPage) => page.values ?? [],
      ({ startAt, pageSize }) =>
        session.http.request<ProjectSearchPage>({
          method: "GET",
          url: session.jiraUrl("/rest/api/3/project/search"),
          query: {
            startAt,
            maxResults: pageSize,
            query: input.flags.query,
            action: input.flags.action,
            ...(input.flags.expandIssueTypes === true ? { expand: "issueTypes" } : {}),
          },
        }),
    );
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      items: paged.items.map((p) => ({
        key: p.key,
        name: p.name,
        type: p.projectTypeKey,
        style: p.style,
        issueTypes: p.issueTypes?.map((t) => ({
          id: t.id,
          name: t.name,
          subtask: t.subtask === true ? true : undefined,
        })),
      })),
    };
  },
});

function fetchIssueTypes(
  session: Session,
  project: string,
  all: boolean,
  flags: { limit?: number | undefined; cursor?: string | undefined },
) {
  return paginateJiraOffset(
    pagePolicy({ ...flags, all }, { defaultLimit: 50, maxPageSize: 50 }),
    (page: CreateMetaPage<IssueTypeMeta>) => page.issueTypes ?? page.createMetaIssueType ?? [],
    ({ startAt, pageSize }) =>
      session.http.request<CreateMetaPage<IssueTypeMeta>>({
        method: "GET",
        url: session.jiraUrl(
          `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey(project))}/issuetypes`,
        ),
        query: { startAt, maxResults: pageSize },
      }),
  );
}

/** Resolve an issue type id or case-insensitive name against the project's creatable types. */
export async function resolveIssueTypeId(
  session: Session,
  project: string,
  wanted: string,
): Promise<string> {
  return (await resolveIssueType(session, project, wanted)).id;
}

/** The creatable issue type of a project matching an id or case-insensitive name. */
export async function resolveIssueType(
  session: Session,
  project: string,
  wanted: string,
): Promise<IssueTypeMeta> {
  const types = (await fetchIssueTypes(session, project, true, {})).items;
  const text = wanted.trim();
  const lower = text.toLowerCase();
  // `untranslatedName` is the English name on a localized site ("Task" for "Feladat").
  const match = /^\d+$/.test(text)
    ? types.find((t) => t.id === text)
    : (types.find((t) => (t.name ?? "").toLowerCase() === lower) ??
      types.find((t) => (t.untranslatedName ?? "").toLowerCase() === lower));
  if (match === undefined) {
    throw new AtlError(
      `Unknown issue type "${wanted}" in project ${project}. Available: ${types.map((t) => (t.untranslatedName === undefined || t.untranslatedName === t.name ? (t.name ?? t.id) : `${t.name ?? t.id} (${t.untranslatedName})`)).join(", ") || "none"}`,
      {
        code: "unknown_issue_type",
        category: "input",
        hint: "Pass an issue type id or one of the listed names.",
        next: [["atl", "project", "types", project]],
      },
    );
  }
  return match;
}

const projectTypes = defineCommand({
  name: "project.types",
  summary: "List issue types you can create in a project",
  mcpTools: ["getJiraProjectIssueTypesMetadata", "listJiraProjectIssueTypesMetadata"],
  args: [PROJECT_ARG],
  flags: Type.Object({ ...PAGING_FLAGS }),
  sideEffects: "none",
  examples: ["atl project types ABC"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const paged = await fetchIssueTypes(
      session,
      projectKey(input.args.project ?? ""),
      input.flags.all === true,
      input.flags,
    );
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      items: paged.items.map((t) => ({
        id: t.id,
        name: t.name,
        subtask: t.subtask === true ? true : undefined,
        description: t.description,
      })),
    };
  },
});

const ALLOWED_VALUES_SHOWN = 20;

const projectFields = defineCommand({
  name: "project.fields",
  summary:
    "List create-screen fields for a project issue type (required and hasDefaultValue shown only when true)",
  mcpTools: ["getJiraIssueTypeMetaWithFields"],
  args: [PROJECT_ARG, { name: "type", description: "Issue type id or name", required: true }],
  flags: Type.Object({
    requiredOnly: Type.Optional(
      Type.Boolean({ description: "Only fields required to create an issue of this type" }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: ["atl project fields ABC Bug", "atl project fields ABC 10004 --all"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const project = projectKey(input.args.project ?? "");
    const typeArg = (input.args.type ?? "").trim();
    const typeId = /^\d+$/.test(typeArg)
      ? typeArg
      : await resolveIssueTypeId(session, project, typeArg);
    const paged = await paginateJiraOffset(
      pagePolicy(input.flags, { defaultLimit: 50, maxPageSize: 50 }),
      (page: CreateMetaPage<FieldMeta>) => page.fields ?? page.results ?? [],
      ({ startAt, pageSize }) =>
        session.http.request<CreateMetaPage<FieldMeta>>({
          method: "GET",
          url: session.jiraUrl(
            `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(typeId)}`,
          ),
          query: { startAt, maxResults: pageSize },
        }),
    );
    const items =
      input.flags.requiredOnly === true
        ? paged.items.filter((f) => f.required === true)
        : paged.items;
    if (ctx.full) {
      return { ...paged, items };
    }
    return {
      ...paged,
      items: items.map((f) => ({
        fieldId: f.fieldId ?? f.key,
        name: f.name,
        required: f.required === true ? true : undefined,
        type: f.schema?.type,
        hasDefaultValue: f.hasDefaultValue === true ? true : undefined,
        allowedValues: f.allowedValues
          ?.slice(0, ALLOWED_VALUES_SHOWN)
          .map((v) => v.name ?? v.value ?? v.id),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Lookups and issue sub-resources (read-only)
// ---------------------------------------------------------------------------

interface ValuesPage<T> extends JiraOffsetPage {
  values?: T[];
  worklogs?: T[];
  dashboards?: T[];
}

/** Offset-paged Jira list; `pick` selects the items array, which differs per endpoint. */
function offsetList<T>(
  session: Session,
  path: string,
  flags: PagingFlags,
  query: Query,
  pick: (page: ValuesPage<T>) => T[] | undefined,
  maxPageSize = 50,
) {
  return paginateJiraOffset(
    pagePolicy(flags, { defaultLimit: 50, maxPageSize }),
    (page: ValuesPage<T>) => pick(page) ?? [],
    ({ startAt, pageSize }) =>
      session.http.request<ValuesPage<T>>({
        method: "GET",
        url: session.jiraUrl(path),
        query: { ...query, startAt, maxResults: pageSize },
      }),
  );
}

/** Client-side paging for endpoints that return the whole list; the cursor is the next index. */
function slicePage<T>(items: readonly T[], flags: PagingFlags, defaultLimit: number) {
  const start = flags.cursor === undefined ? 0 : Number(flags.cursor);
  if (!Number.isInteger(start) || start < 0) {
    throw new AtlError(`Invalid offset cursor: ${String(flags.cursor)}`, {
      code: "invalid_cursor",
      category: "input",
      hint: "Pass the nextCursor value from a previous result.",
    });
  }
  const end =
    flags.all === true
      ? items.length
      : Math.min(items.length, start + (flags.limit ?? defaultLimit));
  return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
}

function conflictingFlags(mode: string, flags: Record<string, unknown>, names: readonly string[]) {
  const used = names
    .filter((name) => flags[name] !== undefined)
    .map((name) => `--${name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  if (used.length > 0) {
    throw new AtlError(`${mode} cannot be combined with ${used.join(", ")}`, {
      code: "conflicting_flags",
      category: "input",
      hint: `Drop ${used.join(", ")} or ${mode}.`,
    });
  }
}

/** Display name, else account id: how a person reads in lists. */
export const userName = (value: JiraUser | null | undefined) =>
  value?.displayName ?? value?.accountId;

// --- issue changelog ---

interface ChangelogEntry {
  id?: string;
  author?: JiraUser;
  created?: string;
  items?: {
    field?: string;
    from?: string | null;
    fromString?: string | null;
    to?: string | null;
    toString?: string | null;
  }[];
}

const issueChangelog = defineCommand({
  name: "issue.changelog",
  summary: "List an issue's field-change history, oldest first",
  mcpTools: ["listJiraIssueChangelogs"],
  args: [ISSUE_ARG],
  flags: Type.Object({ ...PAGING_FLAGS }),
  sideEffects: "none",
  examples: ["atl issue changelog ABC-123", "atl issue changelog ABC-123 --all"],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const paged = await offsetList<ChangelogEntry>(
      session,
      `/rest/api/3/issue/${key}/changelog`,
      input.flags,
      {},
      (page) => page.values,
      100,
    );
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      items: paged.items.map((entry) => ({
        id: entry.id,
        by: userName(entry.author),
        at: shortTs(entry.created),
        changes: entry.items?.map((c) => ({
          field: c.field,
          // Value text, else the raw id for fields without a display string (e.g. custom ids).
          from: c.fromString ?? c.from,
          // The API names the display value `toString`; an absent one would resolve to
          // Object.prototype.toString, so only a string counts.
          to: typeof c.toString === "string" ? c.toString : c.to,
        })),
      })),
    };
  },
});

// --- issue worklogs ---

interface Worklog {
  id?: string;
  author?: JiraUser;
  started?: string;
  timeSpent?: string;
  timeSpentSeconds?: number;
  comment?: AdfDoc | null;
}

const issueWorklogs = defineCommand({
  name: "issue.worklogs",
  summary: "List worklogs (logged time) on an issue",
  mcpTools: ["listJiraIssueWorklogs"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    startedAfter: Type.Optional(
      Type.Integer({ minimum: 0, description: "Only worklogs started after this epoch-ms time" }),
    ),
    startedBefore: Type.Optional(
      Type.Integer({ minimum: 0, description: "Only worklogs started before this epoch-ms time" }),
    ),
    expand: Type.Optional(Type.String({ description: "API `expand`, e.g. properties" })),
    format: ADF_FORMAT_FLAG,
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl issue worklogs ABC-123",
    "atl issue worklogs ABC-123 --started-after 1767225600000",
  ],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const paged = await offsetList<Worklog>(
      session,
      `/rest/api/3/issue/${key}/worklog`,
      input.flags,
      {
        startedAfter: input.flags.startedAfter,
        startedBefore: input.flags.startedBefore,
        expand: input.flags.expand,
      },
      (page) => page.worklogs,
      100,
    );
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      // Sum of the listed worklogs; the issue total with --all.
      totalSeconds:
        paged.items.length === 0
          ? undefined
          : paged.items.reduce((sum, w) => sum + (w.timeSpentSeconds ?? 0), 0),
      items: paged.items.map((w) => ({
        id: w.id,
        by: userName(w.author),
        started: shortTs(w.started),
        time: w.timeSpent,
        seconds: w.timeSpentSeconds,
        comment: body(w.comment, input.flags.format),
      })),
    };
  },
});

// --- issue editmeta ---

interface EditField extends FieldMeta {
  operations?: string[];
}

const issueEditmeta = defineCommand({
  name: "issue.editmeta",
  summary: "List the fields you can edit on an issue, with allowed values",
  args: [ISSUE_ARG],
  flags: Type.Object({
    field: Type.Optional(Type.String({ description: "Comma-separated field ids to include" })),
  }),
  sideEffects: "none",
  examples: ["atl issue editmeta ABC-123", "atl issue editmeta ABC-123 --field priority,labels"],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const meta = await session.http.request<{ fields?: Record<string, EditField> }>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}/editmeta`),
    });
    const wanted = new Set(splitList(input.flags.field));
    const entries = Object.entries(meta.fields ?? {}).filter(
      ([id]) => wanted.size === 0 || wanted.has(id),
    );
    if (ctx.full) {
      return { items: entries.map(([, f]) => f), nextCursor: null };
    }
    return {
      items: entries.map(([id, f]) => ({
        fieldId: f.fieldId ?? id,
        name: f.name,
        required: f.required === true ? true : undefined,
        type: f.schema?.type,
        operations: f.operations,
        allowedValues: f.allowedValues
          ?.slice(0, ALLOWED_VALUES_SHOWN)
          .map((v) => v.name ?? v.value ?? v.id),
        allowedValuesTotal:
          (f.allowedValues?.length ?? 0) > ALLOWED_VALUES_SHOWN
            ? f.allowedValues?.length
            : undefined,
      })),
    };
  },
});

// --- issue watchers ---

const issueWatchers = defineCommand({
  name: "issue.watchers",
  summary: "List who watches an issue",
  args: [ISSUE_ARG],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl issue watchers ABC-123"],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    const result = await session.http.request<{
      watchCount?: number;
      isWatching?: boolean;
      watchers?: JiraUser[];
    }>({ method: "GET", url: session.jiraUrl(`/rest/api/3/issue/${key}/watchers`) });
    if (ctx.full) {
      return result;
    }
    return {
      watchCount: result.watchCount,
      watching: result.isWatching === true ? true : undefined,
      items: (result.watchers ?? []).map(user),
    };
  },
});

// --- issue permissions ---

const DEFAULT_PERMISSIONS = [
  "BROWSE_PROJECTS",
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "TRANSITION_ISSUES",
  "ASSIGN_ISSUES",
  "ADD_COMMENTS",
  "EDIT_ALL_COMMENTS",
  "DELETE_ISSUES",
  "WORK_ON_ISSUES",
  "MANAGE_WATCHERS",
  "LINK_ISSUES",
  "ADMINISTER_PROJECTS",
];

const issuePermissions = defineCommand({
  name: "issue.permissions",
  summary: "Show which permissions you hold on an issue or project",
  args: [{ name: "issue", description: "Issue key, id, or URL (or use --project)" }],
  flags: Type.Object({
    project: Type.Optional(Type.String({ description: "Project key or id instead of an issue" })),
    permissions: Type.Optional(
      Type.String({ description: "Comma-separated permission keys (default: common set)" }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl issue permissions ABC-123",
    "atl issue permissions --project ABC --permissions CREATE_ISSUES,DELETE_ISSUES",
  ],
  async run(ctx, input) {
    const issue = input.args.issue;
    if ((issue === undefined) === (input.flags.project === undefined)) {
      throw new AtlError("Pass exactly one of <issue> or --project", {
        code: "invalid_target",
        category: "input",
        hint: "e.g. atl issue permissions ABC-123, or atl issue permissions --project ABC",
      });
    }
    const requested = splitList(input.flags.permissions);
    const permissions = (requested.length > 0 ? requested : DEFAULT_PERMISSIONS).join(",");
    let session: Session;
    let query: Query;
    if (issue === undefined) {
      const project = projectKey(input.flags.project ?? "");
      session = await openSession(ctx, { fetch: jiraDeps.fetch });
      query = {
        permissions,
        ...(/^\d+$/.test(project) ? { projectId: project } : { projectKey: project }),
      };
    } else {
      const opened = await issueSession(ctx, issue);
      session = opened.session;
      query = {
        permissions,
        ...(/^\d+$/.test(opened.rawKey) ? { issueId: opened.rawKey } : { issueKey: opened.rawKey }),
      };
    }
    const result = await session.http.request<{
      permissions?: Record<string, { key?: string; havePermission?: boolean }>;
    }>({ method: "GET", url: session.jiraUrl("/rest/api/3/mypermissions"), query });
    if (ctx.full) {
      return result;
    }
    const entries = Object.entries(result.permissions ?? {});
    return {
      granted: entries.filter(([, p]) => p.havePermission === true).map(([key]) => key),
      denied: entries.filter(([, p]) => p.havePermission !== true).map(([key]) => key),
    };
  },
});

// --- status list ---

interface StatusRecord extends JiraStatus {
  untranslatedName?: string;
}

interface ProjectStatuses {
  id?: string;
  name?: string;
  subtask?: boolean;
  statuses?: StatusRecord[];
}

const compactStatus = (s: StatusRecord) => ({
  id: s.id,
  name: s.name,
  category: s.statusCategory?.key,
});

const statusList = defineCommand({
  name: "status.list",
  summary: "List statuses: per issue type for a project (--project), or site-wide",
  mcpTools: ["listJiraStatuses"],
  args: [],
  flags: Type.Object({
    project: Type.Optional(
      Type.String({ description: "Project key or id: statuses per issue type" }),
    ),
    issueType: Type.Optional(
      Type.String({ description: "Issue type name or id (needs --project)" }),
    ),
    status: Type.Optional(Type.String({ description: "One status by id or name" })),
    nameContains: Type.Optional(
      Type.String({ description: "Keep statuses whose name contains this" }),
    ),
    statusCategory: Type.Optional(
      Type.Union([Type.Literal("new"), Type.Literal("indeterminate"), Type.Literal("done")], {
        description: "Keep one status category: new (to do), indeterminate, done",
      }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl status list --project ABC",
    "atl status list --project ABC --issue-type Bug",
    "atl status list --status-category done --name-contains rev",
    "atl status list --status 10000",
  ],
  async run(ctx, input) {
    const flags = input.flags;
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    if (flags.issueType !== undefined && flags.project === undefined) {
      throw new AtlError("--issue-type needs --project", {
        code: "missing_project",
        category: "input",
        hint: "Add --project <key>.",
      });
    }
    if (flags.status !== undefined) {
      conflictingFlags("--status", flags, [
        "project",
        "issueType",
        "nameContains",
        "statusCategory",
      ]);
      const one = await session.http.request<StatusRecord>({
        method: "GET",
        url: session.jiraUrl(`/rest/api/3/status/${encodeURIComponent(flags.status)}`),
      });
      return { items: ctx.full ? [one] : [compactStatus(one)] };
    }
    const needle = flags.nameContains?.toLowerCase();
    const keep = (s: StatusRecord) =>
      (needle === undefined || (s.name ?? "").toLowerCase().includes(needle)) &&
      (flags.statusCategory === undefined || s.statusCategory?.key === flags.statusCategory);
    if (flags.project === undefined) {
      const all = await session.http.request<StatusRecord[]>({
        method: "GET",
        url: session.jiraUrl("/rest/api/3/status"),
      });
      const page = slicePage(all.filter(keep), flags, 50);
      return ctx.full ? page : { ...page, items: page.items.map(compactStatus) };
    }
    const types = await session.http.request<ProjectStatuses[]>({
      method: "GET",
      url: session.jiraUrl(
        `/rest/api/3/project/${encodeURIComponent(projectKey(flags.project))}/statuses`,
      ),
    });
    const wantedType = flags.issueType?.toLowerCase();
    const selected = types
      .filter(
        (t) =>
          wantedType === undefined ||
          t.id === flags.issueType ||
          (t.name ?? "").toLowerCase() === wantedType,
      )
      .map((t) => ({ type: t, statuses: (t.statuses ?? []).filter(keep) }))
      .filter(
        (t) =>
          t.statuses.length > 0 || (needle === undefined && flags.statusCategory === undefined),
      );
    if (ctx.full) {
      return {
        items: selected.map((t) => Object.assign({}, t.type, { statuses: t.statuses })),
        nextCursor: null,
      };
    }
    // Workflows are usually shared, so issue types with the same status set collapse into one item.
    const groups = new Map<
      string,
      { issueTypes: (string | undefined)[]; statuses: StatusRecord[] }
    >();
    for (const t of selected) {
      const signature = t.statuses.map((s) => s.id).join(",");
      const group = groups.get(signature);
      if (group === undefined) {
        groups.set(signature, { issueTypes: [t.type.name], statuses: t.statuses });
      } else {
        group.issueTypes.push(t.type.name);
      }
    }
    return {
      items: [...groups.values()].map((g) => ({
        issueTypes: g.issueTypes,
        statuses: g.statuses.map(compactStatus),
      })),
    };
  },
});

// --- component list ---

interface Component {
  id?: string;
  name?: string;
  description?: string;
  lead?: JiraUser;
  assigneeType?: string;
  assignee?: JiraUser;
}

const componentList = defineCommand({
  name: "component.list",
  summary: "List a project's components",
  mcpTools: ["listJiraProjectComponents"],
  args: [PROJECT_ARG],
  flags: Type.Object({
    query: Type.Optional(Type.String({ description: "Filter by component name" })),
    orderBy: Type.Optional(
      Type.String({
        description: "Sort field: name, description, lead, issueCount (prefix - to reverse)",
      }),
    ),
    componentSource: Type.Optional(
      Type.Union([Type.Literal("jira"), Type.Literal("compass"), Type.Literal("auto")], {
        description: "Component source (default jira)",
      }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: ["atl component list ABC", "atl component list ABC --query api --order-by name"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const paged = await offsetList<Component>(
      session,
      `/rest/api/3/project/${encodeURIComponent(projectKey(input.args.project ?? ""))}/component`,
      input.flags,
      {
        query: input.flags.query,
        orderBy: input.flags.orderBy,
        componentSource: input.flags.componentSource,
      },
      (page) => page.values,
    );
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      items: paged.items.map((c) => ({
        id: c.id,
        name: c.name,
        lead: userName(c.lead),
        assignee: userName(c.assignee),
        assigneeType: c.assigneeType === "PROJECT_DEFAULT" ? undefined : c.assigneeType,
        description: snippet(c.description),
      })),
    };
  },
});

// --- version list / get / related-work list ---

interface Version {
  id?: string;
  name?: string;
  description?: string;
  released?: boolean;
  archived?: boolean;
  overdue?: boolean;
  startDate?: string;
  releaseDate?: string;
  projectId?: number;
}

function compactVersion(v: Version, detail: boolean) {
  return {
    id: v.id,
    name: v.name,
    released: v.released === true ? true : undefined,
    archived: v.archived === true ? true : undefined,
    overdue: v.overdue === true ? true : undefined,
    startDate: v.startDate,
    releaseDate: v.releaseDate,
    projectId: detail ? v.projectId : undefined,
    description: detail ? v.description : snippet(v.description),
  };
}

const EXPAND_FLAG = Type.Optional(
  Type.String({ description: "API `expand`, comma-separated (operations, issuesstatus)" }),
);

const versionList = defineCommand({
  name: "version.list",
  summary: "List a project's versions (releases)",
  mcpTools: ["getJiraProjectVersions"],
  args: [PROJECT_ARG],
  flags: Type.Object({
    query: Type.Optional(Type.String({ description: "Filter by name or description" })),
    status: Type.Optional(
      Type.String({ description: "Comma-separated: released, unreleased, archived" }),
    ),
    orderBy: Type.Optional(
      Type.String({
        description: "description, name, releaseDate, sequence, startDate (prefix - to reverse)",
      }),
    ),
    expand: EXPAND_FLAG,
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl version list ABC",
    "atl version list ABC --status unreleased --order-by releaseDate",
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const paged = await offsetList<Version>(
      session,
      `/rest/api/3/project/${encodeURIComponent(projectKey(input.args.project ?? ""))}/version`,
      input.flags,
      {
        query: input.flags.query,
        status: input.flags.status,
        orderBy: input.flags.orderBy,
        expand: input.flags.expand,
      },
      (page) => page.values,
    );
    if (ctx.full) {
      return paged;
    }
    return { ...paged, items: paged.items.map((v) => compactVersion(v, false)) };
  },
});

const versionGet = defineCommand({
  name: "version.get",
  summary: "Get one version by id",
  mcpTools: ["getJiraProjectVersions"],
  args: [{ name: "id", description: "Version id", required: true }],
  flags: Type.Object({ expand: EXPAND_FLAG }),
  sideEffects: "none",
  examples: ["atl version get 10000"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const version = await session.http.request<Version>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/version/${encodeURIComponent(input.args.id ?? "")}`),
      query: { expand: input.flags.expand },
    });
    return ctx.full ? version : compactVersion(version, true);
  },
});

interface RelatedWork {
  relatedWorkId?: string;
  category?: string;
  title?: string;
  url?: string;
  issueId?: number | string;
}

const versionRelatedWorkList = defineCommand({
  name: "version.related-work.list",
  summary: "List the related work (designs, runbooks, change records) attached to a version",
  mcpTools: ["getJiraProjectVersionRelatedWork"],
  args: [{ name: "id", description: "Version id", required: true }],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl version related-work list 10000"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const work = await session.http.request<RelatedWork[]>({
      method: "GET",
      url: session.jiraUrl(
        `/rest/api/3/version/${encodeURIComponent(input.args.id ?? "")}/relatedwork`,
      ),
    });
    if (ctx.full) {
      return { items: work, nextCursor: null };
    }
    return {
      items: work.map((w) => ({
        id: w.relatedWorkId,
        category: w.category,
        title: w.title,
        url: w.url,
        issueId: w.issueId === undefined ? undefined : String(w.issueId),
      })),
    };
  },
});

// --- filter list ---

interface Filter {
  id?: string;
  name?: string;
  jql?: string;
  description?: string;
  owner?: JiraUser;
  favourite?: boolean;
}

const compactFilter = (f: Filter) => ({
  id: f.id,
  name: f.name,
  jql: f.jql,
  owner: userName(f.owner),
  favourite: f.favourite === true ? true : undefined,
  description: snippet(f.description),
});

const filterList = defineCommand({
  name: "filter.list",
  summary: "List saved filters with their JQL (search all visible, or --mine)",
  mcpTools: ["listJiraFilters"],
  args: [],
  flags: Type.Object({
    name: Type.Optional(Type.String({ description: "Filter by name substring" })),
    projectId: Type.Optional(Type.Integer({ description: "Filters visible in this project id" })),
    account: Type.Optional(Type.String({ description: "Owner account id" })),
    id: Type.Optional(Type.String({ description: "Comma-separated filter ids" })),
    orderBy: Type.Optional(
      Type.String({
        description:
          "description, favourite_count, id, is_favourite, name, owner (prefix - to reverse)",
      }),
    ),
    expand: Type.Optional(
      Type.String({
        description: "Extra API `expand` values (jql and owner are always requested)",
      }),
    ),
    mine: Type.Optional(
      Type.Boolean({ description: "Only filters you own (own list is not paged)" }),
    ),
    favourites: Type.Optional(
      Type.Boolean({ description: "With --mine: include favourite filters" }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl filter list",
    'atl filter list --name "sprint"',
    "atl filter list --mine --favourites",
  ],
  async run(ctx, input) {
    const flags = input.flags;
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const expand = [...new Set(["jql", "owner", ...splitList(flags.expand)])].join(",");
    if (flags.mine === true) {
      conflictingFlags("--mine", flags, ["name", "projectId", "account", "id", "orderBy"]);
      const own = await session.http.request<Filter[]>({
        method: "GET",
        url: session.jiraUrl("/rest/api/3/filter/my"),
        query: { expand, includeFavourites: flags.favourites === true ? true : undefined },
      });
      const page = slicePage(own, flags, 50);
      return ctx.full ? page : { ...page, items: page.items.map(compactFilter) };
    }
    if (flags.favourites === true) {
      throw new AtlError("--favourites needs --mine", {
        code: "invalid_flags",
        category: "input",
        hint: "Use atl filter list --mine --favourites.",
      });
    }
    const paged = await offsetList<Filter>(
      session,
      "/rest/api/3/filter/search",
      flags,
      {
        filterName: flags.name,
        projectId: flags.projectId,
        accountId: flags.account,
        id: flags.id === undefined ? undefined : splitList(flags.id),
        orderBy: flags.orderBy,
        expand,
      },
      (page) => page.values,
    );
    return ctx.full ? paged : { ...paged, items: paged.items.map(compactFilter) };
  },
});

// --- dashboard list ---

interface Dashboard {
  id?: string;
  name?: string;
  description?: string;
  owner?: JiraUser;
  isFavourite?: boolean;
  systemDashboard?: boolean;
}

const dashboardList = defineCommand({
  name: "dashboard.list",
  summary: "List dashboards visible to you (search, or --filter my|favourite)",
  mcpTools: ["listJiraDashboards"],
  args: [],
  flags: Type.Object({
    name: Type.Optional(Type.String({ description: "Filter by name substring" })),
    account: Type.Optional(Type.String({ description: "Owner account id" })),
    group: Type.Optional(Type.String({ description: "Shared with this group name" })),
    groupId: Type.Optional(Type.String({ description: "Shared with this group id" })),
    projectId: Type.Optional(Type.Integer({ description: "Shared with this project id" })),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("archived"), Type.Literal("deleted")], {
        description: "Dashboard status (default active)",
      }),
    ),
    orderBy: Type.Optional(
      Type.String({
        description:
          "description, favourite_count, id, is_favourite, name, owner (prefix - to reverse)",
      }),
    ),
    filter: Type.Optional(
      Type.Union([Type.Literal("my"), Type.Literal("favourite")], {
        description: "Only your own or your favourite dashboards (no other filters)",
      }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    "atl dashboard list",
    "atl dashboard list --name team",
    "atl dashboard list --filter my",
  ],
  async run(ctx, input) {
    const flags = input.flags;
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    let paged;
    if (flags.filter === undefined) {
      paged = await offsetList<Dashboard>(
        session,
        "/rest/api/3/dashboard/search",
        flags,
        {
          dashboardName: flags.name,
          accountId: flags.account,
          groupname: flags.group,
          groupId: flags.groupId,
          projectId: flags.projectId,
          status: flags.status,
          orderBy: flags.orderBy,
          expand: "owner,description",
        },
        (page) => page.values,
      );
    } else {
      conflictingFlags(`--filter ${flags.filter}`, flags, [
        "name",
        "account",
        "group",
        "groupId",
        "projectId",
        "status",
        "orderBy",
      ]);
      paged = await offsetList<Dashboard>(
        session,
        "/rest/api/3/dashboard",
        flags,
        { filter: flags.filter },
        (page) => page.dashboards,
      );
    }
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      items: paged.items.map((d) => ({
        id: d.id,
        name: d.name,
        owner: userName(d.owner),
        favourite: d.isFavourite === true ? true : undefined,
        system: d.systemDashboard === true ? true : undefined,
        description: snippet(d.description),
      })),
    };
  },
});

// --- property get ---

function requireFlag(flag: string | undefined, label: string, entity: string): string {
  if (flag === undefined) {
    throw new AtlError(`${entity} properties need ${label}`, {
      code: "missing_flag",
      category: "input",
      hint: `Add ${label}.`,
    });
  }
  return flag;
}

const PROPERTY_ENTITIES = ["issue", "comment", "project", "worklog", "dashboard-item"] as const;

const propertyGet = defineCommand({
  name: "property.get",
  summary: "Read an entity property value, or list the entity's property keys when no key is given",
  mcpTools: ["getJiraEntityProperty"],
  args: [
    {
      name: "entity",
      description: `One of ${PROPERTY_ENTITIES.join(", ")}`,
      required: true,
    },
    {
      name: "id",
      description: "Issue key, comment id, project key, worklog id, or dashboard id",
      required: true,
    },
    { name: "key", description: "Property key; omit to list keys" },
  ],
  flags: Type.Object({
    issue: Type.Optional(Type.String({ description: "Issue key or id (worklog entities)" })),
    item: Type.Optional(
      Type.String({ description: "Dashboard item id (dashboard-item entities)" }),
    ),
  }),
  sideEffects: "none",
  examples: [
    "atl property get issue ABC-123",
    "atl property get issue ABC-123 my.key",
    "atl property get worklog 10001 my.key --issue ABC-123",
    "atl property get dashboard-item 10000 my.key --item 10001",
  ],
  async run(ctx, input) {
    const entity = input.args.entity ?? "";
    const id = input.args.id ?? "";
    const key = input.args.key;
    let session: Session;
    let base: string;
    switch (entity) {
      case "issue": {
        const opened = await issueSession(ctx, id);
        session = opened.session;
        base = `/rest/api/3/issue/${opened.key}/properties`;
        break;
      }
      case "worklog": {
        const opened = await issueSession(
          ctx,
          requireFlag(input.flags.issue, "--issue <key>", "worklog"),
        );
        session = opened.session;
        base = `/rest/api/3/issue/${opened.key}/worklog/${encodeURIComponent(id)}/properties`;
        break;
      }
      case "comment":
      case "project":
      case "dashboard-item": {
        session = await openSession(ctx, { fetch: jiraDeps.fetch });
        if (entity === "comment") {
          base = `/rest/api/3/comment/${encodeURIComponent(id)}/properties`;
        } else if (entity === "project") {
          base = `/rest/api/3/project/${encodeURIComponent(id)}/properties`;
        } else {
          const item = requireFlag(input.flags.item, "--item <id>", "dashboard-item");
          base = `/rest/api/3/dashboard/${encodeURIComponent(id)}/items/${encodeURIComponent(item)}/properties`;
        }
        break;
      }
      default:
        throw new AtlError(`Unknown entity: ${entity}`, {
          code: "invalid_entity",
          category: "input",
          hint: `Use one of: ${PROPERTY_ENTITIES.join(", ")}.`,
        });
    }
    if (key === undefined) {
      const listed = await session.http.request<{ keys?: { key?: string }[] }>({
        method: "GET",
        url: session.jiraUrl(base),
      });
      return ctx.full ? listed : { items: (listed.keys ?? []).map((k) => k.key) };
    }
    const property = await session.http.request<{ key?: string; value?: unknown }>({
      method: "GET",
      url: session.jiraUrl(`${base}/${encodeURIComponent(key)}`),
    });
    return keepRaw({ key: property.key, value: property.value });
  },
});

// --- field / priority / resolution lookups ---

interface FieldRecord {
  id?: string;
  name?: string;
  untranslatedName?: string | null;
  clauseNames?: string[];
  custom?: boolean;
  schema?: { type?: string; items?: string; custom?: string };
}

const fieldListCommand = defineCommand({
  name: "field.list",
  summary: "List Jira fields (system and custom) with their ids and types",
  args: [],
  flags: Type.Object({
    query: Type.Optional(
      Type.String({ description: "Keep fields whose id or name contains this" }),
    ),
    custom: Type.Optional(Type.Boolean({ description: "Only custom fields" })),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: ["atl field list --query sprint", "atl field list --custom --all"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const fields = await fetchFields(session);
    const needle = input.flags.query?.toLowerCase();
    const kept = fields.filter(
      (f) =>
        (input.flags.custom !== true || f.custom === true) &&
        (needle === undefined ||
          (f.id ?? "").toLowerCase().includes(needle) ||
          (f.name ?? "").toLowerCase().includes(needle)),
    );
    const page = slicePage(kept, input.flags, 50);
    if (ctx.full) {
      return page;
    }
    return {
      ...page,
      items: page.items.map((f) => ({
        id: f.id,
        name: f.name,
        type:
          f.schema?.items === undefined ? f.schema?.type : `${f.schema.type}<${f.schema.items}>`,
        custom: f.custom === true ? true : undefined,
      })),
    };
  },
});

interface Priority {
  id: string;
  name?: string;
}

function fetchPriorities(session: Session): Promise<Priority[]> {
  return session.http.request<Priority[]>({
    method: "GET",
    url: session.jiraUrl("/rest/api/3/priority"),
  });
}

/** Resolve `--priority` (id or case-insensitive name) to a priority id. */
export async function resolvePriorityId(session: Session, wanted: string): Promise<string> {
  const text = wanted.trim();
  const priorities = await fetchPriorities(session);
  const match = priorities.find(
    (priority) =>
      priority.id === text || (priority.name ?? "").toLowerCase() === text.toLowerCase(),
  );
  if (match === undefined) {
    throw inputError(
      "unknown_priority",
      `Unknown priority "${wanted}". Available: ${priorities.map((priority) => priority.name ?? priority.id).join(", ")}`,
    );
  }
  return match.id;
}

const priorityList = defineCommand({
  name: "priority.list",
  summary: "List issue priorities",
  args: [],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl priority list"],
  async run(ctx) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const priorities = await fetchPriorities(session);
    return {
      items: ctx.full ? priorities : priorities.map((p) => ({ id: p.id, name: p.name })),
    };
  },
});

const resolutionList = defineCommand({
  name: "resolution.list",
  summary: "List issue resolutions",
  args: [],
  flags: Type.Object({ ...PAGING_FLAGS }),
  sideEffects: "none",
  examples: ["atl resolution list"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const paged = await offsetList<{ id?: string; name?: string; isDefault?: boolean }>(
      session,
      "/rest/api/3/resolution/search",
      input.flags,
      {},
      (page) => page.values,
    );
    if (ctx.full) {
      return paged;
    }
    return {
      ...paged,
      items: paged.items.map((r) => ({
        id: r.id,
        name: r.name,
        default: r.isDefault === true ? true : undefined,
      })),
    };
  },
});

// --- jql-check / jql-suggest (a `jql` leaf exists, so subcommands cannot be nested under it) ---

const jqlCheck = defineCommand({
  name: "jql-check",
  summary: "Validate JQL queries without running them (read-only parse)",
  args: [{ name: "query", description: "JQL query to validate", required: true, variadic: true }],
  flags: Type.Object({
    validation: Type.Optional(
      Type.Union([Type.Literal("strict"), Type.Literal("warn"), Type.Literal("none")], {
        description: "Validation level (default strict)",
      }),
    ),
  }),
  sideEffects: "none",
  examples: [
    'atl jql-check "project = ABC AND status = Done"',
    'atl jql-check "assignee =" "foo bar"',
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const result = await parseJql(session, input.rest, input.flags.validation ?? "strict");
    if (ctx.full) {
      return result;
    }
    return {
      items: (result.queries ?? []).map((q) => ({
        query: q.query,
        ok: q.errors === undefined || q.errors.length === 0 ? true : undefined,
        errors: q.errors,
      })),
    };
  },
});

interface Suggestion {
  value?: string;
  displayName?: string;
}

interface AutocompleteField {
  value?: string;
  displayName?: string;
  operators?: string[];
  auto?: string;
}

const jqlSuggest = defineCommand({
  name: "jql-suggest",
  summary:
    "JQL autocomplete: values for a field (--field), or the searchable fields and their operators",
  args: [],
  flags: Type.Object({
    field: Type.Optional(Type.String({ description: "Field name to suggest values for" })),
    value: Type.Optional(Type.String({ description: "Value prefix to complete (with --field)" })),
    predicate: Type.Optional(
      Type.String({
        description: "Predicate for history fields, e.g. by, from, to (with --field)",
      }),
    ),
    predicateValue: Type.Optional(
      Type.String({ description: "Predicate value prefix (with --predicate)" }),
    ),
    query: Type.Optional(
      Type.String({ description: "Without --field: keep fields whose name contains this" }),
    ),
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: ["atl jql-suggest --field status --value to", "atl jql-suggest --query fix"],
  async run(ctx, input) {
    const flags = input.flags;
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    if (flags.field !== undefined) {
      conflictingFlags("--field", flags, ["query"]);
      const result = await session.http.request<{ results?: Suggestion[] }>({
        method: "GET",
        url: session.jiraUrl("/rest/api/3/jql/autocompletedata/suggestions"),
        query: {
          fieldName: flags.field,
          fieldValue: flags.value,
          predicateName: flags.predicate,
          predicateValue: flags.predicateValue,
        },
      });
      const page = slicePage(result.results ?? [], flags, 50);
      if (ctx.full) {
        return page;
      }
      return {
        ...page,
        items: page.items.map((s) => {
          const label = s.displayName?.replaceAll(/<\/?b>/g, "");
          return { value: s.value, label: label === s.value ? undefined : label };
        }),
      };
    }
    conflictingFlags("listing fields", flags, ["value", "predicate", "predicateValue"]);
    const data = await session.http.request<{ visibleFieldNames?: AutocompleteField[] }>({
      method: "GET",
      url: session.jiraUrl("/rest/api/3/jql/autocompletedata"),
    });
    const needle = flags.query?.toLowerCase();
    const kept = (data.visibleFieldNames ?? []).filter(
      (f) => needle === undefined || (f.value ?? "").toLowerCase().includes(needle),
    );
    const page = slicePage(kept, flags, 50);
    if (ctx.full) {
      return page;
    }
    return {
      ...page,
      items: page.items.map((f) => ({
        field: f.value,
        operators: f.operators,
        values: f.auto === "true" ? true : undefined,
      })),
    };
  },
});

export const jiraCommands: readonly CommandSpec[] = [
  issueGet,
  issueTree,
  issueTransitions,
  issueLinks,
  issueLinkTypes,
  issueComments,
  issueChangelog,
  issueWorklogs,
  issueEditmeta,
  issueWatchers,
  issuePermissions,
  jql,
  jqlCheck,
  jqlSuggest,
  projectList,
  projectTypes,
  projectFields,
  statusList,
  componentList,
  versionList,
  versionGet,
  versionRelatedWorkList,
  filterList,
  dashboardList,
  propertyGet,
  fieldListCommand,
  priorityList,
  resolutionList,
];
