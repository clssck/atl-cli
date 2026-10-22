import { Type } from "../core/schema.ts";
import { closestMatch, defineCommand, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { graphql } from "../core/graphql.ts";
import { isRecord } from "../core/guards.ts";
import type { FetchLike, HttpClient } from "../core/http.ts";
import { openSession, type Session } from "../core/session.ts";
import { decodeStateCursor, encodeStateCursor } from "../core/paginate.ts";
import {
  parseAnyRef,
  parseConfluenceRef,
  parseJiraRef,
  parseSpaceRef,
  type AnyRef,
  type JiraRef,
} from "../resolve/index.ts";
import { renderAdf, shortTs } from "./common.ts";
import { webUrl } from "./confluence.ts";
import { RELATIONSHIP_TYPES, type RelationshipType } from "./graph-catalog.ts";
import { applyArgv, planOrSend } from "./write.ts";

export const graphGroups: Readonly<Record<string, string>> = {
  graph: "Teamwork Graph: object context, hydration, and relationships",
};

/** Test seam: an injected `fetch` used by every command in this module. */
export const graphDeps: { fetch?: FetchLike | undefined } = {};

// ---------------------------------------------------------------------------
// Object model
// ---------------------------------------------------------------------------

/** Object types accepted by `graph.context` (the MCP `objectType` enum). */
const OBJECT_TYPES = [
  "AtlassianGoal",
  "AtlassianGoalUpdate",
  "AtlassianHomeComment",
  "AtlassianHomeTag",
  "AtlassianProject",
  "AtlassianProjectUpdate",
  "AtlassianTeam",
  "AtlassianUser",
  "CompassComponent",
  "ConfluenceBlogPost",
  "ConfluenceComment",
  "ConfluenceDatabase",
  "ConfluencePage",
  "ConfluenceSpace",
  "ConfluenceWhiteboard",
  "ExternalCalendarEvent",
  "ExternalConversation",
  "ExternalDeployment",
  "ExternalDesign",
  "ExternalDocument",
  "ExternalOrganisation",
  "ExternalPosition",
  "ExternalPullRequest",
  "ExternalRepository",
  "ExternalService",
  "FocusFocusArea",
  "JiraSpace",
  "JiraSprint",
  "JiraVersion",
  "JiraWorkItem",
  "JiraWorkItemComment",
  "AssetsObject",
  "LoomMeeting",
  "LoomMeetingRecurrence",
  "LoomVideo",
] as const;

/** Teamwork Graph node typename (as hydrated through GraphQL) to the object type name used in the API docs. */
const OBJECT_TYPE_OF: Readonly<Record<string, string>> = {
  AtlassianAccountUser: "AtlassianUser",
  ConfluenceFooterComment: "ConfluenceComment",
  ConfluenceInlineComment: "ConfluenceComment",
  ExternalSoftwareService: "ExternalService",
  JiraIssue: "JiraWorkItem",
  JiraPlatformComment: "JiraWorkItemComment",
  JiraProject: "JiraSpace",
  JiraConfluenceRemoteIssueLink: "JiraWorkItemRemoteLink",
  JiraCustomRemoteIssueLink: "JiraWorkItemRemoteLink",
  JiraIssueRemoteIssueLink: "JiraWorkItemRemoteLink",
  JiraWebRemoteIssueLink: "JiraWorkItemRemoteLink",
  JiraWorklog: "JiraWorkItemWorklog",
  MercuryFocusArea: "FocusFocusArea",
  TeamV2: "AtlassianTeam",
  TownsquareComment: "AtlassianHomeComment",
  TownsquareGoal: "AtlassianGoal",
  TownsquareGoalUpdate: "AtlassianGoalUpdate",
  TownsquareProject: "AtlassianProject",
  TownsquareProjectUpdate: "AtlassianProjectUpdate",
  TownsquareTag: "AtlassianHomeTag",
};

const USER_REF = "{ id user { accountId name } }";
const ACCOUNT_REF = "{ accountId name }";
const CONFLUENCE_BODY = "body { atlasDocFormat { value } }";

/**
 * Fields hydrated per node typename. Every field is aliased `<Type>__<field>` in the query:
 * fields that share a name across types (`status`, `key`, `name`) would otherwise conflict.
 */
const HYDRATION: Readonly<Record<string, readonly string[]>> = {
  AssetsObject: ["id", "label", "objectKey", "created", "updated"],
  AtlassianAccountUser: ["id", "accountId", "name", "email", "picture", "accountStatus"],
  CompassComponent: ["id", "name", "slug", "description", "state", "url", "typeId", "ownerId"],
  ConfluenceBlogPost: [
    "id",
    "blogPostId",
    "title",
    "status",
    "createdAt",
    `author ${USER_REF}`,
    `owner ${USER_REF}`,
    "space { key name }",
    "links { webUi }",
    CONFLUENCE_BODY,
  ],
  ConfluenceDatabase: [
    "id",
    "databaseId",
    "title",
    "status",
    `author ${USER_REF}`,
    `owner ${USER_REF}`,
    "space { key name }",
    "links { webUi }",
  ],
  ConfluenceFooterComment: ["id", "commentId", "status", `author ${USER_REF}`, CONFLUENCE_BODY],
  ConfluenceInlineComment: ["id", "commentId", "status", "resolutionStatus"],
  ConfluencePage: [
    "id",
    "pageId",
    "title",
    "status",
    "createdAt",
    `author ${USER_REF}`,
    `owner ${USER_REF}`,
    "space { key name }",
    "links { webUi }",
    CONFLUENCE_BODY,
  ],
  ConfluenceSpace: [
    "id",
    "spaceId",
    "key",
    "name",
    "type",
    "status",
    "createdDate",
    "links { webUi }",
  ],
  ConfluenceWhiteboard: [
    "id",
    "whiteboardId",
    "title",
    "status",
    `author ${USER_REF}`,
    `owner ${USER_REF}`,
    "space { key name }",
    "links { webUi }",
  ],
  ExternalCalendarEvent: [
    "id",
    "displayName",
    "url",
    "eventStartTime",
    "eventEndTime",
    "lastUpdated",
  ],
  ExternalConversation: ["id", "displayName", "url", "topic", "lastUpdated"],
  ExternalDeployment: ["id", "displayName", "url", "state", "lastUpdated"],
  ExternalDesign: ["id", "displayName", "url", "status", "lastUpdated"],
  ExternalDocument: ["id", "displayName", "url", "category", "status", "createdAt", "lastUpdated"],
  ExternalOrganisation: ["id", "displayName", "url", "lastUpdated"],
  ExternalPosition: ["id", "displayName", "jobTitle", "url"],
  ExternalPullRequest: [
    "id",
    "displayName",
    "title",
    "url",
    "status",
    "repositoryId",
    "createdAt",
    "lastUpdate",
  ],
  ExternalRepository: ["id", "displayName", "name", "url", "description", "lastUpdated"],
  ExternalSoftwareService: ["id", "displayName", "url", "tier", "lastUpdated"],
  JiraIssue: [
    "id",
    "issueId",
    "key",
    "summary",
    "webUrl",
    "created",
    "updated",
    "dueDate",
    "resolutionDate",
    "status { name statusCategory { name } }",
    "issueType { name }",
    "priority { name }",
    `assignee ${ACCOUNT_REF}`,
    `reporter ${ACCOUNT_REF}`,
    "project { key name }",
    "labels(first: 50) { edges { node { name } } }",
    "description { adfValue { json } }",
  ],
  JiraConfluenceRemoteIssueLink: ["id", "title", "href", "relationship"],
  JiraCustomRemoteIssueLink: [
    "id",
    "title",
    "href",
    "summary",
    "relationship",
    "applicationName",
    "globalId",
  ],
  JiraIssueRemoteIssueLink: ["id", "title", "href", "relationship"],
  JiraPlatformComment: [
    "id",
    "commentId",
    "webUrl",
    "created",
    "updated",
    `author ${ACCOUNT_REF}`,
    "issue { key }",
  ],
  JiraWebRemoteIssueLink: ["id", "title", "href", "summary", "relationship", "applicationName"],
  JiraProject: [
    "id",
    "projectId",
    "key",
    "name",
    "description",
    "webUrl",
    "projectTypeName",
    `lead ${ACCOUNT_REF}`,
  ],
  JiraSprint: [
    "id",
    "sprintId",
    "name",
    "state",
    "goal",
    "boardName",
    "startDate",
    "endDate",
    "completionDate",
  ],
  JiraVersion: ["id", "versionId", "name", "description", "status", "startDate", "releaseDate"],
  LoomMeeting: ["id", "title", "startsAt", "endsAt", "recurring"],
  LoomVideo: [
    "id",
    "name",
    "url",
    "description",
    "createdAt",
    "updatedAt",
    "shortSummary",
    "ownerId",
  ],
  MercuryFocusArea: ["id", "name", "url", "createdDate", "updatedDate", "archived"],
  TeamV2: ["id", "displayName", "description", "state", "memberCount", "profileUrl"],
  TownsquareComment: ["id", "commentText", "url", "creationDate", "editDate"],
  TownsquareGoal: [
    "id",
    "key",
    "name",
    "url",
    "description",
    "creationDate",
    "startDate",
    "isArchived",
    `owner ${ACCOUNT_REF}`,
  ],
  TownsquareGoalUpdate: ["id", "summary", "updateType", "creationDate", "url"],
  TownsquareProject: [
    "id",
    "key",
    "name",
    "url",
    "creationDate",
    "startDate",
    "isArchived",
    `owner ${ACCOUNT_REF}`,
  ],
  TownsquareProjectUpdate: ["id", "summary", "updateType", "creationDate", "url"],
  TownsquareTag: ["id", "name", "description", "url", "creationDate"],
};

const HYDRATION_FRAGMENTS = Object.entries(HYDRATION)
  .map(
    ([type, selections]) =>
      `... on ${type} { ${selections
        .map((selection) => `${type}__${/^\w+/.exec(selection)?.[0] ?? selection}: ${selection}`)
        .join(" ")} }`,
  )
  .join("\n");

// ---------------------------------------------------------------------------
// GraphQL documents (Teamwork Graph Cypher through `graphStore_cypherQueryV2`)
// ---------------------------------------------------------------------------

const HYDRATE_DOCUMENT = `query GraphHydrate($query: String!, $params: JSON, $context: String, $first: Int) {
  graphStore_cypherQueryV2(query: $query, params: $params, first: $first, version: V2, queryContext: $context) @optIn(to: "GraphStoreCypherQueryV2") {
    edges { node { columns { key value { __typename
      ... on GraphStoreCypherQueryV2AriNode { id data { __typename ${HYDRATION_FRAGMENTS} } }
    } } } }
  }
}`;

const EDGES_DOCUMENT = `query GraphEdges($queries: [GraphStoreCypherQueryV2BatchQueryRequestInput!]!, $params: [JSON], $context: String) {
  graphStore_cypherQueryV2Batch(queries: $queries, params: $params, version: V2, queryContext: $context) @optIn(to: "GraphStoreCypherQueryV2Batch") {
    results { pageInfo { hasNextPage } edges { node { columns { key value { __typename
      ... on GraphStoreCypherQueryV2BatchAriNode { id data { __typename } }
      ... on GraphStoreCypherQueryV2BatchIntObject { i: value }
      ... on GraphStoreCypherQueryV2BatchTimestampObject { t: value }
    } } } } }
  }
}`;

/** The batch endpoint rejects more than this many queries per request. */
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 6;
/** `ari:cloud:platform::site/<cloudId>` is the query context the Cypher endpoint requires. */
const siteContext = (cloudId: string): string => `ari:cloud:platform::site/${cloudId}`;

interface Hydrated {
  ari: string;
  /** Object type name from the API docs, e.g. `JiraWorkItem`. */
  type: string;
  typename: string;
  raw: Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function columnsOf(node: unknown): Map<string, Record<string, unknown>> {
  const columns = new Map<string, Record<string, unknown>>();
  const list = isRecord(node) && Array.isArray(node.columns) ? node.columns : [];
  for (const column of list) {
    if (isRecord(column) && typeof column.key === "string" && isRecord(column.value)) {
      columns.set(column.key, column.value);
    }
  }
  return columns;
}

function edgeNodes(connection: unknown): unknown[] {
  const edges = isRecord(connection) && Array.isArray(connection.edges) ? connection.edges : [];
  return edges.map((edge) => (isRecord(edge) ? edge.node : undefined));
}

/** Hydrate nodes by ARI in one Cypher query; ARIs the caller cannot read are simply absent. */
async function hydrate(
  http: HttpClient,
  cloudId: string,
  aris: readonly string[],
): Promise<{ objects: Map<string, Hydrated>; partialErrors: string[]; data: unknown }> {
  const unique = [...new Set(aris)];
  if (unique.length === 0) {
    return { objects: new Map(), partialErrors: [], data: null };
  }
  const { data, partialErrors } = await graphql(http, {
    operationName: "GraphHydrate",
    query: HYDRATE_DOCUMENT,
    variables: {
      query: "MATCH (n) WHERE n.ari IN $aris RETURN n",
      params: { aris: unique },
      context: siteContext(cloudId),
      first: unique.length,
    },
  });
  const objects = new Map<string, Hydrated>();
  const connection = data.graphStore_cypherQueryV2;
  for (const node of edgeNodes(connection)) {
    const value = columnsOf(node).get("n");
    const typedata = isRecord(value) && isRecord(value.data) ? value.data : undefined;
    const ari = value === undefined ? undefined : stringOf(value.id);
    const typename = typedata === undefined ? undefined : stringOf(typedata.__typename);
    if (ari === undefined || typedata === undefined || typename === undefined) {
      continue;
    }
    const prefix = `${typename}__`;
    const raw = Object.fromEntries(
      Object.entries(typedata)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, field]) => [key.slice(prefix.length), field]),
    );
    objects.set(ari, { ari, typename, type: OBJECT_TYPE_OF[typename] ?? typename, raw });
  }
  return { objects, partialErrors, data: connection };
}

interface EdgeRequest {
  query: string;
  params: Record<string, unknown>;
  first: number;
}

interface EdgeRow {
  columns: Map<string, Record<string, unknown>>;
}

interface EdgeResult {
  rows: EdgeRow[];
  hasNextPage: boolean;
  /** Set when the gateway rejected this query (for example a third-party node). */
  error?: string;
}

function parseEdgeResult(result: unknown): EdgeResult {
  const pageInfo = isRecord(result) && isRecord(result.pageInfo) ? result.pageInfo : {};
  return {
    rows: edgeNodes(result).map((node) => ({ columns: columnsOf(node) })),
    hasNextPage: pageInfo.hasNextPage === true,
  };
}

async function sendBatch(
  http: HttpClient,
  cloudId: string,
  requests: readonly EdgeRequest[],
): Promise<EdgeResult[]> {
  const { data } = await graphql(http, {
    operationName: "GraphEdges",
    query: EDGES_DOCUMENT,
    variables: {
      queries: requests.map((request) => ({ query: request.query, first: request.first })),
      params: requests.map((request) => request.params),
      context: siteContext(cloudId),
    },
  });
  const batch = data.graphStore_cypherQueryV2Batch;
  const results = isRecord(batch) && Array.isArray(batch.results) ? batch.results : [];
  return requests.map((_, index) => parseEdgeResult(results[index]));
}

/** The gateway answers 400 for a query it will not run (for example one returning a third-party node). */
function isRejection(error: unknown): error is AtlError {
  return error instanceof AtlError && error.status === 400;
}

/**
 * Run Cypher queries in batches of ten. A rejected batch is retried query by query so that one
 * unsupported relationship (the gateway refuses third-party nodes) does not hide the others.
 */
async function runEdges(
  http: HttpClient,
  cloudId: string,
  requests: readonly EdgeRequest[],
): Promise<EdgeResult[]> {
  const chunks: EdgeRequest[][] = [];
  for (let at = 0; at < requests.length; at += BATCH_SIZE) {
    chunks.push(requests.slice(at, at + BATCH_SIZE));
  }
  const settled: EdgeResult[][] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const chunk = chunks[index];
      if (chunk === undefined) {
        return;
      }
      try {
        settled[index] = await sendBatch(http, cloudId, chunk);
      } catch (error) {
        if (!isRejection(error)) {
          throw error;
        }
        if (chunk.length === 1) {
          settled[index] = [{ rows: [], hasNextPage: false, error: error.message }];
          continue;
        }
        const single: EdgeResult[] = [];
        for (const request of chunk) {
          try {
            single.push(...(await sendBatch(http, cloudId, [request])));
          } catch (inner) {
            if (!isRejection(inner)) {
              throw inner;
            }
            single.push({ rows: [], hasNextPage: false, error: inner.message });
          }
        }
        settled[index] = single;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, () => worker()),
  );
  return settled.flat();
}

// ---------------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------------

const isAri = (text: string): boolean => /^ari:[a-z0-9-]+:/i.test(text);

function ariRequired(objectType: string, identifier: string): AtlError {
  return new AtlError(`${objectType} cannot be resolved from "${identifier}"`, {
    code: "ari_required",
    category: "input",
    hint: `Pass the ${objectType} ARI (for example from \`atl graph context\` targets or \`atl graph object\`).`,
  });
}

function invalidIdentifier(objectType: string, identifier: string, hint: string): AtlError {
  return new AtlError(`Not a ${objectType} identifier: ${identifier}`, {
    code: "invalid_object_identifier",
    category: "input",
    hint,
  });
}

/** URL path segment that follows `marker`, e.g. the key in `/projects/KAN/board`. */
function segmentAfter(identifier: string, markers: readonly string[]): string | undefined {
  let path: string;
  try {
    path = new URL(identifier).pathname;
  } catch {
    return undefined;
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  const at = segments.findIndex((segment) => markers.includes(segment));
  const found = at === -1 ? undefined : segments[at + 1];
  return found === undefined ? undefined : decodeURIComponent(found);
}

/** Site host carried by a URL identifier, so the right site is opened before resolving. */
function siteHintOf(identifier: string): string | undefined {
  const text = identifier.trim();
  if (isAri(text)) {
    return undefined;
  }
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]+$/;

async function jiraProjectId(session: Session, identifier: string): Promise<string> {
  const text = identifier.trim();
  const candidate = /^https?:\/\//i.test(text)
    ? (segmentAfter(text, ["projects", "browse"]) ?? "")
    : text;
  if (/^\d+$/.test(candidate)) {
    return candidate;
  }
  const key = /^[A-Z][A-Z0-9_]+-\d+$/i.test(candidate) ? candidate.split("-")[0] : candidate;
  if (key === undefined || !PROJECT_KEY.test(key)) {
    throw invalidIdentifier("JiraSpace", identifier, "Pass a project key, id, URL, or ARI.");
  }
  const project = await session.http.request<{ id?: string }>({
    method: "GET",
    url: session.jiraUrl(`/rest/api/3/project/${encodeURIComponent(key)}`),
  });
  if (project.id === undefined) {
    throw invalidIdentifier("JiraSpace", identifier, "The project has no id in the response.");
  }
  return project.id;
}

async function issueId(session: Session, identifier: string): Promise<string> {
  const ref = parseJiraRef(identifier);
  if (ref.id !== undefined) {
    return ref.id;
  }
  const issue = await session.http.request<{ id?: string }>({
    method: "GET",
    url: session.jiraUrl(`/rest/api/3/issue/${encodeURIComponent(ref.key ?? identifier)}`, {
      fields: "summary",
    }),
  });
  if (issue.id === undefined) {
    throw invalidIdentifier("JiraWorkItem", identifier, "The issue has no id in the response.");
  }
  return issue.id;
}

async function confluenceSpaceId(session: Session, identifier: string): Promise<string> {
  const ref = parseSpaceRef(identifier);
  if (ref.id !== undefined) {
    return ref.id;
  }
  const page = await session.http.request<{ results?: { id?: string }[] }>({
    method: "GET",
    url: session.confluenceUrl("/api/v2/spaces", { keys: ref.key }),
  });
  const id = page.results?.[0]?.id;
  if (id === undefined) {
    throw new AtlError(`Confluence space not found: ${identifier}`, {
      code: "not_found",
      category: "api",
      hint: "Check the space key and that --site points at the right site.",
    });
  }
  return id;
}

/** Resource id inside an ARI for the types a human identifier can name directly. */
async function resolveAri(
  session: Session,
  objectType: string,
  identifier: string,
): Promise<string> {
  const text = identifier.trim();
  if (isAri(text)) {
    return text;
  }
  const { cloudId } = session.site;
  switch (objectType) {
    case "JiraWorkItem":
      return `ari:cloud:jira:${cloudId}:issue/${await issueId(session, text)}`;
    case "JiraSpace":
      return `ari:cloud:jira:${cloudId}:project/${await jiraProjectId(session, text)}`;
    case "JiraSprint":
    case "JiraVersion": {
      const id = /^\d+$/.test(text)
        ? text
        : segmentAfter(text, objectType === "JiraSprint" ? ["sprint"] : ["versions"]);
      if (id === undefined || !/^\d+$/.test(id)) {
        throw invalidIdentifier(objectType, identifier, "Pass the numeric id or an ARI.");
      }
      return `ari:cloud:jira:${cloudId}:${objectType === "JiraSprint" ? "sprint" : "version"}/${id}`;
    }
    case "ConfluencePage":
    case "ConfluenceBlogPost":
    case "ConfluenceComment":
    case "ConfluenceDatabase":
    case "ConfluenceWhiteboard": {
      const resource = {
        ConfluencePage: "page",
        ConfluenceBlogPost: "blogpost",
        ConfluenceComment: "comment",
        ConfluenceDatabase: "database",
        ConfluenceWhiteboard: "whiteboard",
      }[objectType];
      const ref = parseConfluenceRef(text);
      return `ari:cloud:confluence:${cloudId}:${resource}/${objectType === "ConfluenceComment" ? (ref.commentId ?? ref.id) : ref.id}`;
    }
    case "ConfluenceSpace":
      return `ari:cloud:confluence:${cloudId}:space/${await confluenceSpaceId(session, text)}`;
    case "AtlassianUser": {
      const accountId = /^https?:\/\//i.test(text) ? segmentAfter(text, ["people"]) : text;
      if (accountId === undefined || !/^[\w:-]{6,}$/.test(accountId)) {
        throw invalidIdentifier(
          "AtlassianUser",
          identifier,
          "Pass an accountId, profile URL, or ARI.",
        );
      }
      return `ari:cloud:identity::user/${accountId}`;
    }
    case "AtlassianTeam": {
      const teamId = /^https?:\/\//i.test(text) ? segmentAfter(text, ["team"]) : text;
      if (teamId === undefined || !/^[\w-]{8,}$/.test(teamId)) {
        throw invalidIdentifier("AtlassianTeam", identifier, "Pass a team id, team URL, or ARI.");
      }
      return `ari:cloud:identity::team/${teamId}`;
    }
    default:
      throw ariRequired(objectType, identifier);
  }
}

// ---------------------------------------------------------------------------
// Compact projection
// ---------------------------------------------------------------------------

function textField(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = stringOf(raw[name]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** One line per object: identity plus whatever title-like and URL-like fields the type has. */
function brief(session: Session, object: Hydrated): Record<string, unknown> {
  const { raw } = object;
  const webUi = isRecord(raw.links) ? stringOf(raw.links.webUi) : undefined;
  const key = textField(raw, "key", "objectKey");
  const url = textField(raw, "webUrl", "url", "href") ?? webUrl(session, webUi);
  return {
    ari: object.ari,
    type: object.type,
    key,
    title: textField(raw, "title", "name", "displayName", "label"),
    summary: textField(raw, "summary"),
    // A Jira issue key already rebuilds its browse URL.
    webUrl: key !== undefined && url?.endsWith(`/browse/${key}`) ? undefined : url,
  };
}

const SUBSECOND_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+/;

/**
 * Hydrated fields without API scaffolding: nothing the ARI or `key` already gives (`id`, `<type>Id`,
 * a `/browse/<key>` URL), ADF bodies as markdown, `{ id: <ARI>, user: { accountId, name } }` person
 * refs as `{ accountId, name }`, label connections as name lists, timestamps without sub-seconds.
 */
function compactRaw(value: unknown, ari?: string): unknown {
  if (typeof value === "string") {
    return SUBSECOND_TS.test(value) ? shortTs(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactRaw(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (isRecord(value.user) && typeof value.user.accountId === "string") {
    return { accountId: value.user.accountId, name: value.user.name };
  }
  if (isRecord(value.adfValue) && isRecord(value.adfValue.json)) {
    return renderAdf(JSON.stringify(value.adfValue.json), "md");
  }
  if (isRecord(value.atlasDocFormat) && typeof value.atlasDocFormat.value === "string") {
    return renderAdf(value.atlasDocFormat.value, "md");
  }
  if (Array.isArray(value.edges)) {
    return value.edges.map((edge) =>
      isRecord(edge) && isRecord(edge.node) ? compactRaw(edge.node.name) : undefined,
    );
  }
  const resourceId = ari?.slice(ari.lastIndexOf("/") + 1);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, field]) =>
          !(key === "id" && field === ari) &&
          !(
            key.endsWith("Id") &&
            key !== "accountId" &&
            ari !== undefined &&
            field === resourceId
          ) &&
          !(
            key === "webUrl" &&
            typeof field === "string" &&
            typeof value.key === "string" &&
            field.endsWith(`/browse/${value.key}`)
          ),
      )
      .map(([key, field]) => [key, compactRaw(field)]),
  );
}

function decodeCursor(cursor: string): Record<string, unknown> {
  const parsed = decodeStateCursor(cursor);
  if (parsed !== undefined) {
    return parsed;
  }
  throw new AtlError("Invalid --after cursor", {
    code: "invalid_cursor",
    category: "input",
    hint: "Pass the nextCursor of a previous `atl graph context` call made with the same flags.",
  });
}

// ---------------------------------------------------------------------------
// graph.object
// ---------------------------------------------------------------------------

const MAX_OBJECTS = 25;

/** An identifier that names a Jira or Confluence resource: ARI, URL, or issue key. */
async function resolveAnyAri(session: Session, identifier: string): Promise<string> {
  const text = identifier.trim();
  if (isAri(text)) {
    return text;
  }
  const parsed = parseAnyRef(text);
  if (parsed.product === "jira") {
    return resolveAri(session, "JiraWorkItem", text);
  }
  const kind = {
    page: "ConfluencePage",
    blogpost: "ConfluenceBlogPost",
    comment: "ConfluenceComment",
    "unknown-content": "ConfluencePage",
  }[parsed.ref.kind];
  return resolveAri(session, kind, text);
}

function describeFailure(identifier: string, error: unknown): string {
  return `${identifier}: ${error instanceof Error ? error.message : String(error)}`;
}

const graphObject = defineCommand({
  name: "graph.object",
  summary: "Hydrate Teamwork Graph objects from ARIs, URLs, or issue keys",
  mcpTools: ["getTeamworkGraphObject"],
  args: [
    {
      name: "id",
      description: `ARI, browser URL, or issue key (max ${MAX_OBJECTS})`,
      required: true,
      variadic: true,
    },
  ],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: [
    "atl graph object https://acme.atlassian.net/browse/ENG-1 ari:cloud:jira:<cloudId>:issue/123",
    "atl graph object ENG-1",
  ],
  async run(ctx, input) {
    const ids = [...input.rest];
    if (ids.length > MAX_OBJECTS) {
      throw new AtlError(`At most ${MAX_OBJECTS} objects per call (got ${ids.length})`, {
        code: "too_many_objects",
        category: "input",
      });
    }
    const hints = new Set(ids.map(siteHintOf).filter((host) => host !== undefined));
    if (hints.size > 1) {
      throw new AtlError(`Objects span several sites: ${[...hints].join(", ")}`, {
        code: "mixed_sites",
        category: "input",
        hint: "Call `atl graph object` once per site.",
      });
    }
    const session = await openSession(ctx, { siteHint: [...hints][0], fetch: graphDeps.fetch });
    const resolved = new Map<string, string>();
    const errors: string[] = [];
    for (const id of ids) {
      try {
        resolved.set(id, await resolveAnyAri(session, id));
      } catch (error) {
        if (!(error instanceof AtlError) || error.category !== "input") {
          throw error;
        }
        errors.push(describeFailure(id, error));
      }
    }
    if (resolved.size === 0) {
      throw new AtlError(`Not an ARI, URL, or issue key: ${ids.join(", ")}`, {
        code: "invalid_ari",
        category: "input",
        hint: "Pass ARIs like ari:cloud:jira:<cloudId>:issue/<id>, browser URLs, or issue keys.",
      });
    }
    const hydrated = await hydrate(session.http, session.site.cloudId, [...resolved.values()]);
    if (ctx.full) {
      return { data: hydrated.data, partialErrors: hydrated.partialErrors };
    }
    const items: Record<string, unknown>[] = [];
    for (const [id, ari] of resolved) {
      const object = hydrated.objects.get(ari);
      if (object === undefined) {
        errors.push(`${id}: no object with ARI ${ari} is readable with this token`);
      } else {
        items.push({ ari: object.ari, type: object.type, raw: compactRaw(object.raw, object.ari) });
      }
    }
    if (items.length === 0) {
      throw new AtlError(
        `No object resolved for ${ids.join(", ")}: ${errors.join("; ").slice(0, 400)}`,
        {
          code: "not_found",
          category: "api",
          hint: "Check the ARI or URL, and that --site points at the right site.",
        },
      );
    }
    const messages = [...errors, ...hydrated.partialErrors];
    return { items, nextCursor: null, ...(messages.length === 0 ? {} : { errors: messages }) };
  },
});

// ---------------------------------------------------------------------------
// graph.context
// ---------------------------------------------------------------------------

/** One Cypher traversal: a relationship type in one direction, optionally to one target object type. */
interface Traversal {
  relationship: RelationshipType;
  direction: "outgoing" | "incoming";
  /** Object types on the far end of this relationship. */
  others: readonly string[];
  /** Restricts the far end to this object type. */
  target?: string;
}

const DEFAULT_FIRST = 50;

function timeBounds(range: string): { from?: number; to?: number } {
  const at = range.indexOf("..");
  const parts = at === -1 ? [] : [range.slice(0, at), range.slice(at + 2)];
  const [fromText = "", toText = ""] = parts;
  const from = fromText === "" ? undefined : Date.parse(fromText);
  const to = toText === "" ? undefined : Date.parse(toText);
  if (
    parts.length === 0 ||
    (fromText === "" && toText === "") ||
    Number.isNaN(from) ||
    Number.isNaN(to)
  ) {
    throw new AtlError(`Invalid --time-range "${range}"`, {
      code: "invalid_time_range",
      category: "input",
      hint: "Use FROM..TO with ISO 8601 date-times; either side may be empty, e.g. 2025-01-01T00:00:00Z..",
    });
  }
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

const normalizeName = (name: string): string => name.trim().toLowerCase().replaceAll("-", "_");

function selectObjectType(value: string): string {
  const match = OBJECT_TYPES.find((type) => type.toLowerCase() === value.trim().toLowerCase());
  if (match === undefined) {
    const guess = closestMatch(value, OBJECT_TYPES);
    throw new AtlError(`Unknown object type "${value}"`, {
      code: "unknown_object_type",
      category: "input",
      hint: guess === undefined ? `One of: ${OBJECT_TYPES.join(", ")}` : `Did you mean ${guess}?`,
    });
  }
  return match;
}

function planTraversals(
  objectType: string,
  relationshipTypes: readonly string[] | undefined,
  targetObjectTypes: readonly string[] | undefined,
): { traversals: Traversal[]; warnings: string[] } {
  const wanted =
    relationshipTypes === undefined ? undefined : new Set(relationshipTypes.map(normalizeName));
  const known = new Set(RELATIONSHIP_TYPES.map((relationship) => relationship.name));
  const warnings: string[] = [];
  for (const name of wanted ?? []) {
    if (!known.has(name)) {
      const guess = closestMatch(name, [...known]);
      throw new AtlError(`Unknown relationship type "${name}"`, {
        code: "unknown_relationship_type",
        category: "input",
        hint:
          guess === undefined
            ? "See the Teamwork Graph relationship types reference."
            : `Did you mean ${guess}?`,
      });
    }
  }
  const targets = targetObjectTypes?.map(selectObjectType);
  const traversals: Traversal[] = [];
  for (const relationship of RELATIONSHIP_TYPES) {
    if (wanted !== undefined && !wanted.has(relationship.name)) {
      continue;
    }
    for (const direction of ["outgoing", "incoming"] as const) {
      const here = direction === "outgoing" ? relationship.from : relationship.to;
      const others = direction === "outgoing" ? relationship.to : relationship.from;
      if (!here.includes(objectType)) {
        continue;
      }
      if (targets === undefined) {
        traversals.push({ relationship, direction, others });
        continue;
      }
      for (const target of others.filter((type) => targets.includes(type))) {
        traversals.push({ relationship, direction, others, target });
      }
    }
  }
  if (wanted !== undefined) {
    for (const name of wanted) {
      if (!traversals.some((traversal) => traversal.relationship.name === name)) {
        warnings.push(
          `${name} does not apply to ${objectType}${targets === undefined ? "" : " with these target types"}`,
        );
      }
    }
  }
  return { traversals, warnings };
}

function traversalQuery(
  traversal: Traversal,
  bounds: { from?: number; to?: number },
  mode: "count" | "rows",
  skip: number,
): { query: string; params: Record<string, unknown> } {
  const arrow =
    traversal.direction === "outgoing"
      ? `-[r:${traversal.relationship.name}]->`
      : `<-[r:${traversal.relationship.name}]-`;
  const conditions = [
    ...(bounds.from === undefined ? [] : ["r.lastUpdated >= $from"]),
    ...(bounds.to === undefined ? [] : ["r.lastUpdated <= $to"]),
  ];
  const head = `MATCH (n {ari: $ari})${arrow}(m${traversal.target === undefined ? "" : `:${traversal.target}`})${
    conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`
  }`;
  const params = {
    ...(bounds.from === undefined ? {} : { from: bounds.from }),
    ...(bounds.to === undefined ? {} : { to: bounds.to }),
  };
  return {
    query:
      mode === "count"
        ? `${head} RETURN count(m) AS c`
        : `${head} RETURN m, r.lastUpdated AS updated ORDER BY r.lastUpdated DESC${skip > 0 ? ` SKIP ${skip}` : ""}`,
    params,
  };
}

const intColumn = (row: EdgeRow | undefined, key: string): number => {
  const value = row?.columns.get(key)?.i;
  return typeof value === "number" ? value : 0;
};

const relationshipLabel = (traversal: Traversal) => ({
  relationshipName: traversal.relationship.name,
  direction: traversal.direction,
});

async function summarize(
  session: Session,
  ari: string,
  traversals: readonly Traversal[],
  bounds: { from?: number; to?: number },
  window: { first: number; offset: number },
  errors: string[],
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const { http, site } = session;
  const requests = (list: readonly Traversal[]): EdgeRequest[] =>
    list.map((traversal) => {
      const { query, params } = traversalQuery(traversal, bounds, "count", 0);
      return { query, params: { ari, ...params }, first: 1 };
    });
  const counted = await runEdges(http, site.cloudId, requests(traversals));
  const totals: { traversal: Traversal; total: number }[] = [];
  counted.forEach((result, index) => {
    const traversal = traversals[index];
    if (traversal === undefined) {
      return;
    }
    if (result.error !== undefined) {
      errors.push(`${traversal.relationship.name}: ${result.error}`);
      return;
    }
    const total = intColumn(result.rows[0], "c");
    if (total > 0) {
      totals.push({ traversal, total });
    }
  });

  // Several far-end types and no explicit filter: split the non-empty relationships per type.
  const splits = totals.filter(
    ({ traversal }) => traversal.target === undefined && traversal.others.length > 1,
  );
  const perType = splits.flatMap(({ traversal }) =>
    traversal.others.map((target): Traversal => ({ ...traversal, target })),
  );
  const typeCounts = new Map<Traversal, number>();
  if (perType.length > 0) {
    const results = await runEdges(http, site.cloudId, requests(perType));
    results.forEach((result, index) => {
      const traversal = perType[index];
      if (traversal !== undefined && result.error === undefined) {
        typeCounts.set(traversal, intColumn(result.rows[0], "c"));
      }
    });
  }

  const grouped = new Map<
    string,
    { label: Traversal; counts: Record<string, number>; total: number }
  >();
  for (const { traversal, total } of totals) {
    const key = `${traversal.relationship.name}:${traversal.direction}`;
    const entry = grouped.get(key) ?? { label: traversal, counts: {}, total: 0 };
    entry.total += total;
    if (traversal.target !== undefined) {
      entry.counts[traversal.target] = total;
    } else if (traversal.others.length === 1 && traversal.others[0] !== undefined) {
      entry.counts[traversal.others[0]] = total;
    } else {
      for (const [split, count] of typeCounts) {
        if (
          count > 0 &&
          split.relationship === traversal.relationship &&
          split.direction === traversal.direction &&
          split.target !== undefined
        ) {
          entry.counts[split.target] = count;
        }
      }
    }
    grouped.set(key, entry);
  }
  const all = [...grouped.values()].map(({ label, counts, total }) => ({
    relationshipName: label.relationship.name,
    direction: label.direction,
    targetObjectTypes: Object.keys(counts),
    countsByTargetType: counts,
    totalCount: total,
  }));
  const end = window.offset + window.first;
  const page = all.slice(window.offset, end);
  return { items: page, nextCursor: end < all.length ? encodeStateCursor({ o: end }) : null };
}

interface TargetGroup {
  relationshipName: string;
  direction: string;
  targetObjectType?: string;
  targets: Record<string, unknown>[];
}

interface TargetRow {
  traversal: Traversal;
  ari: string;
  updatedAt: string | undefined;
}

async function listTargets(
  session: Session,
  ari: string,
  traversals: readonly Traversal[],
  bounds: { from?: number; to?: number },
  start: { unit: number; skip: number },
  first: number,
  errors: string[],
): Promise<{ rows: TargetRow[]; next: { unit: number; skip: number } | null }> {
  const rows: TargetRow[] = [];
  let unit = start.unit;
  let skip = start.skip;
  while (unit < traversals.length) {
    const remaining = first - rows.length;
    const chunk = traversals.slice(unit, unit + BATCH_SIZE);
    const results = await runEdges(
      session.http,
      session.site.cloudId,
      chunk.map((traversal, index) => {
        const { query, params } = traversalQuery(traversal, bounds, "rows", index === 0 ? skip : 0);
        return { query, params: { ari, ...params }, first: remaining + 1 };
      }),
    );
    for (const [index, result] of results.entries()) {
      const traversal = chunk[index];
      if (traversal === undefined) {
        continue;
      }
      const offset = index === 0 ? skip : 0;
      if (result.error !== undefined) {
        errors.push(`${traversal.relationship.name}: ${result.error}`);
        continue;
      }
      const room = first - rows.length;
      const found = result.rows.flatMap((row) => {
        const value = row.columns.get("m");
        const id = value === undefined ? undefined : stringOf(value.id);
        const stamp = row.columns.get("updated")?.t;
        return id === undefined
          ? []
          : [
              {
                id,
                updatedAt: typeof stamp === "number" ? new Date(stamp).toISOString() : undefined,
              },
            ];
      });
      for (const row of found.slice(0, room)) {
        rows.push({ traversal, ari: row.id, updatedAt: row.updatedAt });
      }
      if (found.length > room) {
        return { rows, next: { unit: unit + index, skip: offset + room } };
      }
      if (rows.length >= first) {
        return {
          rows,
          next: unit + index + 1 < traversals.length ? { unit: unit + index + 1, skip: 0 } : null,
        };
      }
    }
    unit += chunk.length;
    skip = 0;
  }
  return { rows, next: null };
}

const graphContext = defineCommand({
  name: "graph.context",
  summary: "Teamwork Graph relationships and context for one object",
  mcpTools: ["getTeamworkGraphContext"],
  args: [
    {
      name: "objectType",
      description: `Object type, one of: ${OBJECT_TYPES.join(", ")}`,
      required: true,
    },
    {
      name: "objectIdentifier",
      description: "Key, id, ARI, or URL; format depends on the object type",
      required: true,
    },
  ],
  flags: Type.Object({
    detailLevel: Type.Optional(
      Type.Union([Type.Literal("summary"), Type.Literal("full")], {
        description: "summary (counts and metadata, default) or full (the related objects)",
      }),
    ),
    relationshipTypes: Type.Optional(
      Type.Array(Type.String(), { description: "Only these relationship types; repeatable" }),
    ),
    targetObjectTypes: Type.Optional(
      Type.Array(Type.String(), { description: "Only relationships to these object types" }),
    ),
    timeRange: Type.Optional(
      Type.String({ description: "Filter by relationship update time: FROM..TO (ISO 8601)" }),
    ),
    first: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: `Max related items (default ${DEFAULT_FIRST})`,
      }),
    ),
    after: Type.Optional(Type.String({ description: "Pagination cursor from a previous result" })),
  }),
  sideEffects: "none",
  examples: [
    "atl graph context JiraWorkItem ENG-123",
    "atl graph context ConfluencePage 123456 --detail-level full --target-object-types AtlassianUser",
    "atl graph context AtlassianUser <accountId> --detail-level full --relationship-types atlassian_user_owns_confluence_page",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const objectType = selectObjectType(input.args.objectType ?? "");
    const identifier = input.args.objectIdentifier ?? "";
    const bounds = flags.timeRange === undefined ? {} : timeBounds(flags.timeRange);
    const { traversals, warnings } = planTraversals(
      objectType,
      flags.relationshipTypes,
      flags.targetObjectTypes,
    );
    const session = await openSession(ctx, {
      siteHint: siteHintOf(identifier),
      fetch: graphDeps.fetch,
    });
    const ari = await resolveAri(session, objectType, identifier);
    const found = await hydrate(session.http, session.site.cloudId, [ari]);
    const source = found.objects.get(ari);
    if (source === undefined) {
      throw new AtlError(`No ${objectType} found for ${identifier}`, {
        code: "not_found",
        category: "api",
        hint: "Check the identifier, and that --site points at the right site.",
      });
    }
    const first = flags.first ?? DEFAULT_FIRST;
    const cursor = flags.after === undefined ? undefined : decodeCursor(flags.after);
    const errors: string[] = [];
    const level = flags.detailLevel ?? "summary";

    let relationships: { items: Record<string, unknown>[]; nextCursor: string | null } | undefined;
    let rows: TargetRow[] = [];
    let next: { unit: number; skip: number } | null = null;
    if (level === "summary") {
      const offset = typeof cursor?.o === "number" ? cursor.o : 0;
      relationships = await summarize(session, ari, traversals, bounds, { first, offset }, errors);
    } else {
      if (cursor !== undefined && cursor.n !== traversals.length) {
        throw new AtlError("The --after cursor belongs to a different set of flags", {
          code: "invalid_cursor",
          category: "input",
          hint: "Page with the same --relationship-types, --target-object-types, and --time-range.",
        });
      }
      const start = {
        unit: typeof cursor?.u === "number" ? cursor.u : 0,
        skip: typeof cursor?.s === "number" ? cursor.s : 0,
      };
      ({ rows, next } = await listTargets(session, ari, traversals, bounds, start, first, errors));
    }

    const targets = await hydrate(
      session.http,
      session.site.cloudId,
      rows.map((row) => row.ari),
    );
    const nextCursor =
      relationships === undefined
        ? next === null
          ? null
          : encodeStateCursor({ u: next.unit, s: next.skip, n: traversals.length })
        : relationships.nextCursor;

    if (ctx.full) {
      return {
        object: { ari: source.ari, type: source.type, raw: source.raw },
        relationships: relationships?.items,
        targets: rows.map((row) => ({
          ...relationshipLabel(row.traversal),
          updatedAt: row.updatedAt,
          object: targets.objects.get(row.ari) ?? { ari: row.ari },
        })),
        nextCursor,
        errors,
        warnings,
      };
    }

    let items: unknown[];
    if (relationships !== undefined) {
      items = relationships.items;
    } else {
      const groups = new Map<string, TargetGroup>();
      for (const row of rows) {
        const object = targets.objects.get(row.ari);
        const type =
          object?.type ??
          row.traversal.target ??
          (row.traversal.others.length === 1 ? row.traversal.others[0] : undefined);
        const key = `${row.traversal.relationship.name}:${row.traversal.direction}:${type ?? ""}`;
        const group = groups.get(key) ?? {
          relationshipName: row.traversal.relationship.name,
          direction: row.traversal.direction,
          ...(type === undefined ? {} : { targetObjectType: type }),
          targets: [],
        };
        group.targets.push({
          ...(object === undefined ? { ari: row.ari } : brief(session, object)),
          updatedAt: shortTs(row.updatedAt),
        });
        groups.set(key, group);
      }
      items = [...groups.values()];
    }
    return {
      object: brief(session, source),
      items,
      nextCursor,
      ...(errors.length === 0 ? {} : { errors }),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  },
});

// ---------------------------------------------------------------------------
// graph.add
// ---------------------------------------------------------------------------

const ADD_TYPES = [
  "jira-work-item-links-jira-work-item",
  "jira-work-item-blocks-jira-work-item",
  "jira-work-item-links-jira-work-item-remote-link",
  "jira-work-item-tracks-atlassian-project",
  "jira-work-item-contributes-to-atlassian-goal",
] as const;

/** Atlas (Townsquare) writes: the mutation needs a scope the CLI's OAuth client is never granted. */
const ATLAS_SCOPES: Readonly<Record<string, { mutation: string; scope: string }>> = {
  "jira-work-item-tracks-atlassian-project": {
    mutation: "projects_addJiraWorkItemLink",
    scope: "write:project:projects",
  },
  "jira-work-item-contributes-to-atlassian-goal": {
    mutation: "goals_linkWorkItem",
    scope: "write:goal:goals",
  },
};

/** Jira issue reference for a request body: the key when known, else the numeric id. */
function issuePointer(ref: JiraRef): { key: string } | { id: string } {
  return ref.key === undefined ? { id: ref.id ?? "" } : { key: ref.key };
}

interface LinkTypeEntry {
  id?: string;
  name?: string;
}

async function remoteTarget(
  session: Session,
  identifier: string,
): Promise<{ url: string; title: string }> {
  const text = identifier.trim();
  if (/^https?:\/\//i.test(text) && siteHintOf(text) !== session.site.host) {
    return { url: text, title: text };
  }
  const parsed: AnyRef = /^\d+$/.test(text)
    ? { product: "confluence", ref: parseConfluenceRef(text) }
    : parseAnyRef(text);
  if (parsed.product === "jira") {
    const ref = parsed.ref;
    const issue = await session.http.request<{ key?: string; fields?: { summary?: string } }>({
      method: "GET",
      url: session.jiraUrl(`/rest/api/3/issue/${encodeURIComponent(ref.key ?? ref.id ?? text)}`, {
        fields: "summary",
      }),
    });
    const key = issue.key ?? ref.key ?? text;
    return {
      url: session.siteUrl(`/browse/${key}`),
      title: `${key}: ${issue.fields?.summary ?? ""}`.trim(),
    };
  }
  const page = await session.http.request<{ title?: string; _links?: { webui?: string } }>({
    method: "GET",
    url: session.confluenceUrl(`/api/v2/pages/${encodeURIComponent(parsed.ref.id)}`),
  });
  const url = webUrl(session, page._links?.webui);
  if (url === undefined) {
    throw new AtlError(`Confluence page ${parsed.ref.id} has no web URL`, {
      code: "unexpected_response",
      category: "api",
    });
  }
  return { url, title: page.title ?? url };
}

const graphAdd = defineCommand({
  name: "graph.add",
  summary: "Create a relationship between two Jira work items, or attach a remote link",
  mcpTools: ["addTeamworkGraphContext"],
  args: [
    {
      name: "relationshipType",
      description: `One of: ${ADD_TYPES.join(", ")}`,
      required: true,
    },
    { name: "objectIdentifier", description: "Source work item: ARI, URL, or key", required: true },
    {
      name: "targetObjectIdentifier",
      description:
        "Target: work item key/URL/ARI, or (remote links) a URL, page id, page URL, or ARI",
      required: true,
    },
  ],
  flags: Type.Object({
    title: Type.Optional(
      Type.String({ description: "Display label for the target (remote links)" }),
    ),
  }),
  sideEffects: "write",
  examples: [
    "atl graph add jira-work-item-blocks-jira-work-item ENG-1 ENG-2",
    "atl graph add jira-work-item-links-jira-work-item-remote-link ENG-1 https://example.com/doc --title Spec --plan",
  ],
  async run(ctx, input) {
    const type = normalizeName(input.args.relationshipType ?? "").replaceAll("_", "-");
    if (!ADD_TYPES.some((candidate) => candidate === type)) {
      const guess = closestMatch(type, ADD_TYPES);
      throw new AtlError(`Unsupported relationship type "${input.args.relationshipType ?? ""}"`, {
        code: "unsupported_relationship_type",
        category: "input",
        hint: guess === undefined ? `One of: ${ADD_TYPES.join(", ")}` : `Did you mean ${guess}?`,
      });
    }
    const atlas = ATLAS_SCOPES[type];
    if (atlas !== undefined) {
      throw new AtlError(
        `${type} needs the Atlas ${atlas.mutation} mutation, which this token cannot call`,
        {
          code: "missing_scope",
          category: "auth",
          hint: `atl's OAuth grant does not include ${atlas.scope}; link the work item in Atlas instead.`,
        },
      );
    }

    const sourceInput = input.args.objectIdentifier ?? "";
    const source = parseJiraRef(sourceInput);
    const session = await openSession(ctx, { siteHint: source.site, fetch: graphDeps.fetch });
    const sourceKey = source.key ?? source.id ?? sourceInput;
    const next = [applyArgv(ctx.argv)];

    if (type === "jira-work-item-links-jira-work-item-remote-link") {
      const target = await remoteTarget(session, input.args.targetObjectIdentifier ?? "");
      const title = input.flags.title ?? target.title;
      const sent = await planOrSend<unknown>(
        ctx,
        session.http,
        {
          method: "POST",
          url: session.jiraUrl(`/rest/api/3/issue/${encodeURIComponent(sourceKey)}/remotelink`),
          body: { object: { url: target.url, title } },
        },
        next,
      );
      if (isRecord(sent) && sent.type === "plan") {
        return sent;
      }
      const remoteId = isRecord(sent) ? sent.id : undefined;
      return {
        relationshipType: type,
        object: sourceKey,
        target: target.url,
        title,
        remoteLinkId:
          typeof remoteId === "number" || typeof remoteId === "string" ? String(remoteId) : null,
        next: [["atl", "issue", "links", sourceKey, "--remote"]],
      };
    }

    const wantedName = type === "jira-work-item-blocks-jira-work-item" ? "Blocks" : "Relates";
    const linkTypes = await session.http.request<{ issueLinkTypes?: LinkTypeEntry[] }>({
      method: "GET",
      url: session.jiraUrl("/rest/api/3/issueLinkType"),
    });
    const linkType = linkTypes.issueLinkTypes?.find(
      (entry) => entry.name?.toLowerCase() === wantedName.toLowerCase(),
    );
    if (linkType?.name === undefined) {
      throw new AtlError(`This site has no "${wantedName}" issue link type`, {
        code: "unknown_link_type",
        category: "input",
        hint: "Use `atl issue link` with one of the site's link types.",
        next: [["atl", "issue", "link-types"]],
      });
    }
    const targetInput = input.args.targetObjectIdentifier ?? "";
    const target = parseJiraRef(targetInput);
    const sent = await planOrSend<unknown>(
      ctx,
      session.http,
      {
        method: "POST",
        url: session.jiraUrl("/rest/api/3/issueLink"),
        body: {
          type: { name: linkType.name },
          inwardIssue: issuePointer(source),
          outwardIssue: issuePointer(target),
        },
      },
      next,
    );
    if (isRecord(sent) && sent.type === "plan") {
      return sent;
    }
    return {
      relationshipType: type,
      object: sourceKey,
      target: target.key ?? target.id ?? targetInput,
      linkType: linkType.name,
      next: [["atl", "issue", "links", sourceKey]],
    };
  },
});

export const graphCommands: readonly CommandSpec[] = [graphContext, graphObject, graphAdd];
