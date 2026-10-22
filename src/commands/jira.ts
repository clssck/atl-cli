import { Type } from "../core/schema.ts";
import type { AdfDoc } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import type { FetchLike } from "../core/http.ts";
import { paginateJiraOffset, paginateJiraToken } from "../core/paginate.ts";
import { openSession, type Session } from "../core/session.ts";
import { parseJiraRef } from "../resolve/index.ts";
import {
  ADF_FORMAT_FLAG,
  PAGING_FLAGS,
  pagePolicy,
  renderAdf,
  shortTs,
  type AdfFormat,
} from "./common.ts";

/** Test seam: a fake `fetch` used by every Jira command when set. */
export const jiraDeps: { fetch?: FetchLike | undefined } = {};

export const jiraGroups: Readonly<Record<string, string>> = {
  issue: "Read, create, edit, comment on, transition, link, and log work on Jira issues",
  project: "List Jira projects, issue types, and create fields",
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

interface IssueTypeMeta {
  id: string;
  name?: string;
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
  return openSession(ctx, { siteHint: ref.site, fetch: jiraDeps.fetch }).then((session) => ({
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
    author: comment.author?.displayName ?? comment.author?.accountId,
    created,
    updated: updated === created ? undefined : updated,
    body: body(comment.body, format),
  };
}

const COMPACT_FIELD_KEYS: ReadonlySet<string> = new Set([...DEFAULT_ISSUE_FIELDS, "issuelinks"]);
const COMPACT_ISSUE_KEYS: ReadonlySet<string> = new Set(["id", "key", "fields", "self", "expand"]);

/** API fields a `jql` list item asks for by default; `--issue-fields` replaces this list. */
const LIST_ISSUE_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];

/**
 * Compact issue shape. `list` gives a minimal item (people as display names, no id/url/statusCategory)
 * containing only the fields that were requested; otherwise the richer single-issue view
 * (accountIds, id, url). Fields outside the compact set (components, custom fields, `*all`) and
 * top-level expansions (`renderedFields`, `names`, `properties`, ...) are carried through raw.
 */
export function compactIssue(
  session: Session,
  issue: JiraIssue,
  format: AdfFormat | undefined,
  withDescription: boolean,
  list = false,
): Record<string, unknown> {
  const f = issue.fields ?? {};
  const extraFields = Object.fromEntries(
    Object.entries(f).filter(([name]) => !COMPACT_FIELD_KEYS.has(name)),
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
    parent: list ? parent?.key : parent && { key: parent.key, summary: parent.fields?.summary },
    project: list ? f.project?.key : f.project && { key: f.project.key, name: f.project.name },
    created: shortTs(f.created),
    updated: shortTs(f.updated),
    description: withDescription ? body(f.description, format) : undefined,
    url: list ? undefined : session.siteUrl(`/browse/${encodeURIComponent(issue.key)}`),
    fields: extraFields,
    ...Object.fromEntries(Object.entries(issue).filter(([name]) => !COMPACT_ISSUE_KEYS.has(name))),
  };
}

function fieldList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw === undefined) {
    return [...fallback];
  }
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return list.length === 0 ? [...fallback] : list;
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
    const fields = fieldList(flags.issueFields, DEFAULT_ISSUE_FIELDS);
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
  mcpTools: ["getTransitionsForJiraIssue"],
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

const issueLinks = defineCommand({
  name: "issue.links",
  summary: "List issue links (or remote links with --remote)",
  mcpTools: ["getJiraIssueRemoteIssueLinks"],
  args: [ISSUE_ARG],
  flags: Type.Object({
    remote: Type.Optional(Type.Boolean({ description: "List remote (web) links instead" })),
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
  ],
  async run(ctx, input) {
    const { session, key } = await issueSession(ctx, input.args.issue ?? "");
    if (input.flags.remote === true || input.flags.globalId !== undefined) {
      const response = await session.http.request<RemoteLink | RemoteLink[]>({
        method: "GET",
        url: session.jiraUrl(`/rest/api/3/issue/${key}/remotelink`),
        query: { globalId: input.flags.globalId },
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
    const issue = await session.http.request<JiraIssue>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${key}`),
      query: { fields: "issuelinks" },
    });
    const links = issue.fields?.issuelinks ?? [];
    return { items: ctx.full ? links : links.map(compactIssueLink) };
  },
});

const issueLinkTypes = defineCommand({
  name: "issue.link-types",
  summary: "List issue link types",
  mcpTools: ["getIssueLinkTypes"],
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

interface SearchPage {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
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
    ...PAGING_FLAGS,
  }),
  sideEffects: "none",
  examples: [
    'atl jql "project = ABC AND statusCategory != Done ORDER BY updated DESC"',
    'atl jql "assignee = currentUser()" --issue-fields summary,status,description --all',
    'atl jql "project = ABC AND resolution = Unresolved" --result-mode count',
  ],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const query = input.args.query ?? "";
    const mode = input.flags.resultMode ?? "issues";
    let count: number | undefined;
    if (mode !== "issues") {
      const counted = await session.http.request<{ count?: number }>({
        method: "POST",
        url: session.jiraUrl("/rest/api/3/search/approximate-count"),
        body: { jql: query },
      });
      count = counted.count ?? 0;
      if (mode === "count") {
        return { count };
      }
    }
    const fields = fieldList(input.flags.issueFields, LIST_ISSUE_FIELDS);
    const paged = await paginateJiraToken(
      pagePolicy(input.flags, { defaultLimit: 25, maxPageSize: 100 }),
      (page: SearchPage) => page.issues ?? [],
      ({ cursor, pageSize }) =>
        session.http.request<SearchPage>({
          method: "GET",
          url: session.jiraUrl("/rest/api/3/search/jql"),
          query: {
            jql: query,
            fields: fields.join(","),
            maxResults: pageSize,
            ...(cursor === undefined ? {} : { nextPageToken: cursor }),
          },
        }),
    );
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
  mcpTools: ["getVisibleJiraProjects"],
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
          `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
        ),
        query: { startAt, maxResults: pageSize },
      }),
  );
}

const projectTypes = defineCommand({
  name: "project.types",
  summary: "List issue types you can create in a project",
  mcpTools: ["getJiraProjectIssueTypesMetadata"],
  args: [PROJECT_ARG],
  flags: Type.Object({ ...PAGING_FLAGS }),
  sideEffects: "none",
  examples: ["atl project types ABC"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: jiraDeps.fetch });
    const paged = await fetchIssueTypes(
      session,
      input.args.project ?? "",
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
    const project = input.args.project ?? "";
    const typeArg = (input.args.type ?? "").trim();
    let typeId = typeArg;
    if (!/^\d+$/.test(typeArg)) {
      const types = (await fetchIssueTypes(session, project, true, {})).items;
      const wanted = typeArg.toLowerCase();
      const match = types.find((t) => (t.name ?? "").toLowerCase() === wanted);
      if (match === undefined) {
        const names = types.map((t) => t.name ?? t.id);
        throw new AtlError(
          `Unknown issue type "${typeArg}" in ${project}. Available: ${names.join(", ")}`,
          {
            code: "unknown_issue_type",
            category: "input",
            hint: "Pass an issue type id or one of the listed names.",
            next: [["atl", "project", "types", project]],
          },
        );
      }
      typeId = match.id;
    }
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

export const jiraCommands: readonly CommandSpec[] = [
  issueGet,
  issueTransitions,
  issueLinks,
  issueLinkTypes,
  issueComments,
  jql,
  projectList,
  projectTypes,
  projectFields,
];
