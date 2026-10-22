import { Type } from "../core/schema.ts";
import { adfToMarkdown, parseAdfBody, type AdfDoc } from "../adf/index.ts";
import { defineCommand, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { FetchLike } from "../core/http.ts";
import {
  decodeStateCursor,
  encodeStateCursor,
  nextPageToken,
  paginateConfluenceV1Search,
  type ConfluenceSearchPage,
} from "../core/paginate.ts";
import { openSession, type Session } from "../core/session.ts";
import { writeDiagnostic } from "../core/output.ts";
import { queryLiteral, shortTs } from "./common.ts";
import { searchHitSpaceKey, searchHitTitle, snippet, webUrl } from "./confluence.ts";

export const searchGroups: Readonly<Record<string, string>> = {
  user: "Find Atlassian users",
};

/** Test seam: a fake `fetch` used by every command in this module when set. */
export const searchDeps: { fetch?: FetchLike | undefined } = {};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function requireQuery(value: string | undefined, example: string): string {
  const query = (value ?? "").trim();
  if (query === "") {
    throw new AtlError("Query is empty", {
      code: "empty_query",
      category: "input",
      hint: `Pass a non-empty query, e.g. ${example}.`,
    });
  }
  return query;
}

// ---------------------------------------------------------------------------
// user.find
// ---------------------------------------------------------------------------

interface PickerUser {
  accountId?: string;
  accountType?: string;
  displayName?: string;
  html?: string;
  avatarUrl?: string;
}

interface PickerResponse {
  users?: { users?: PickerUser[] };
}

/** `<strong>name</strong> - <strong>name</strong>@example.com`: the address follows the dash. */
function emailFromHtml(html: string | undefined): string | undefined {
  if (html === undefined) {
    return undefined;
  }
  const text = html.replaceAll(/<[^>]*>/g, "");
  const at = text.lastIndexOf(" - ");
  const candidate = (at === -1 ? text : text.slice(at + 3)).trim();
  return /^\S+@\S+$/.test(candidate) ? candidate : undefined;
}

function compactUser(user: PickerUser, avatar: boolean): Record<string, unknown> {
  const item: Record<string, unknown> = {
    accountId: user.accountId,
    displayName: user.displayName,
  };
  const email = emailFromHtml(user.html);
  if (email !== undefined) {
    item.email = email;
  }
  item.accountType = user.accountType;
  if (avatar && user.avatarUrl !== undefined) {
    item.avatarUrl = user.avatarUrl;
  }
  return item;
}

const userFind = defineCommand({
  name: "user.find",
  summary: "Find Jira users by name or email and get their account ids",
  mcpTools: ["lookupJiraAccountId"],
  args: [{ name: "query", description: "Name or email fragment", required: true }],
  flags: Type.Object({
    avatar: Type.Optional(Type.Boolean({ description: "Include avatar URLs" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Maximum users to return" }),
    ),
  }),
  sideEffects: "none",
  examples: ['atl user find "jane"', "atl user find jane@example.com --avatar"],
  async run(ctx, input) {
    const query = requireQuery(input.args.query, 'atl user find "jane"');
    const session = await openSession(ctx, { fetch: searchDeps.fetch });
    const response = await session.http.request<PickerResponse>({
      method: "GET",
      url: session.jiraUrl("/rest/api/3/groupuserpicker"),
      query: {
        query,
        maxResults: input.flags.limit ?? DEFAULT_LIMIT,
        ...(input.flags.avatar === true ? { showAvatar: true } : {}),
      },
    });
    const users = response.users?.users ?? [];
    if (ctx.full) {
      return { items: users, nextCursor: null };
    }
    return { items: users.map((user) => compactUser(user, input.flags.avatar === true)) };
  },
});

interface BulkUser {
  accountId?: string;
  accountType?: string;
  accountStatus?: string;
  displayName?: string;
  email?: string;
  locale?: string;
}

/** Confluence `/user/bulk` takes at most 200 account ids per request. */
const BULK_USER_LIMIT = 200;

const userGet = defineCommand({
  name: "user.get",
  summary: "Get user profiles by account id (via Confluence; Jira's /user is out of token scope)",
  mcpTools: ["getJiraUser"],
  args: [
    { name: "accountId", description: "Atlassian account id", required: true, variadic: true },
  ],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl user get 5b10ac8d82e05b22cc7d4ef5", "atl user get <accountId> <accountId>"],
  async run(ctx, input) {
    const session = await openSession(ctx, { fetch: searchDeps.fetch });
    const ids = [...new Set(input.rest)];
    const found: BulkUser[] = [];
    for (let at = 0; at < ids.length; at += BULK_USER_LIMIT) {
      const chunk = ids.slice(at, at + BULK_USER_LIMIT);
      const page = await session.http.request<{ results?: BulkUser[] }>({
        method: "GET",
        url: session.confluenceUrl("/rest/api/user/bulk"),
        query: { accountId: chunk, limit: chunk.length },
      });
      found.push(...(page.results ?? []));
    }
    if (ctx.full) {
      return { items: found, nextCursor: null };
    }
    const seen = new Set(found.map((u) => u.accountId));
    return {
      items: found.map((u) => ({
        accountId: u.accountId,
        name: u.displayName,
        email: u.email,
        type: u.accountType === "atlassian" ? undefined : u.accountType,
        status: u.accountStatus === "active" ? undefined : u.accountStatus,
        locale: u.locale,
      })),
      missing: ids.filter((id) => !seen.has(id)),
    };
  },
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

type Product = "confluence" | "jira";

interface ConfluenceHit {
  content?: {
    id?: string;
    type?: string;
    title?: string;
    space?: { key?: string };
    ancestors?: { title?: string }[];
  };
  resultGlobalContainer?: { displayUrl?: string };
  space?: { id?: number | string };
  entityType?: string;
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
}

interface JiraHit {
  key?: string;
  fields?: {
    summary?: string;
    updated?: string;
    description?: AdfDoc | string | null;
    status?: { name?: string };
  };
}

interface JiraSearchPage {
  issues?: JiraHit[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface SourceState {
  done: boolean;
  cursor: string | undefined;
}

/** Position in both result streams plus which product is served first on the next call. */
interface SearchState {
  confluence: SourceState;
  jira: SourceState;
  turn: 0 | 1;
}

interface SourcePage<T> {
  items: T[];
  next: string | null;
}

function isSourceState(value: unknown): value is SourceState {
  return (
    isRecord(value) &&
    typeof value.done === "boolean" &&
    (value.cursor === undefined || typeof value.cursor === "string")
  );
}

function decodeCursor(cursor: string): SearchState {
  const value = decodeStateCursor(cursor);
  if (
    value === undefined ||
    !isSourceState(value.confluence) ||
    !isSourceState(value.jira) ||
    (value.turn !== 0 && value.turn !== 1)
  ) {
    throw new AtlError("--cursor is not a cursor returned by atl search", {
      code: "invalid_cursor",
      category: "input",
      hint: "Pass the nextCursor value from a previous atl search result unchanged.",
    });
  }
  return { confluence: value.confluence, jira: value.jira, turn: value.turn };
}

const JIRA_FIELDS = "summary,updated,status,issuetype,project,description";

/**
 * User text must match literally, but Lucene (behind both CQL and JQL `~`) reads upper-case
 * AND / OR / NOT as operators and a leading `-` as exclusion: lower-case the words (a lower-case
 * "and" is an ordinary stop word) and escape the dash. A trailing backslash would escape the
 * phrase's closing quote (HTTP 400 "Escaped end quote"): a space after it is insignificant.
 */
function literalText(query: string): string {
  return query
    .replaceAll(/(?<![\w])(?:AND|OR|NOT)(?![\w])/g, (word) => word.toLowerCase())
    .replaceAll(/(^|\s)-(?=\S)/g, "$1\\-")
    .replace(/\\$/, "\\ ");
}

/** The CQL `search` runs for Confluence (`text`), and the `atl cql` equivalent of it. */
function confluenceCql(query: string, type: string | undefined, field = "text"): string {
  return `${field} ~ ${queryLiteral(literalText(query))}${type === undefined ? "" : ` AND type = ${type}`}`;
}

function jiraJql(query: string, field = "text"): string {
  return `${field} ~ ${queryLiteral(literalText(query))}`;
}

/** One Confluence slice of `take` items; the paginator retries an empty or short index answer. */
async function searchConfluence(
  session: Session,
  query: string,
  type: string | undefined,
  take: number,
  cursor: string | undefined,
): Promise<SourcePage<ConfluenceHit>> {
  const cql = confluenceCql(query, type);
  const paged = await paginateConfluenceV1Search<ConfluenceHit>(
    { limit: take, defaultLimit: take, maxPageSize: take, cursor },
    ({ cursor: from, pageSize }) =>
      session.http.request<ConfluenceSearchPage<ConfluenceHit>>({
        method: "GET",
        url: session.confluenceUrl("/rest/api/search"),
        query: {
          cql,
          expand: "content.ancestors",
          limit: pageSize,
          ...(from === undefined ? {} : { cursor: from }),
        },
      }),
  );
  return { items: paged.items, next: paged.nextCursor };
}

async function searchJira(
  session: Session,
  query: string,
  take: number,
  cursor: string | undefined,
): Promise<SourcePage<JiraHit>> {
  const page = await session.http.request<JiraSearchPage>({
    method: "GET",
    url: session.jiraUrl("/rest/api/3/search/jql"),
    query: {
      jql: jiraJql(query),
      fields: JIRA_FIELDS,
      maxResults: take,
      ...(cursor === undefined ? {} : { nextPageToken: cursor }),
    },
  });
  return { items: page.issues ?? [], next: nextPageToken(page) };
}

/**
 * Same item shape as `cql`: bare content id plus type; the url only where id and type cannot
 * rebuild it. `spaceKey` and the immediate `parent` title tell apart hits with the same title.
 */
function compactConfluence(session: Session, hit: ConfluenceHit) {
  const type = hit.content?.type ?? hit.entityType;
  const id = hit.content?.id ?? (type === "space" ? hit.space?.id : undefined);
  return {
    id: id === undefined ? undefined : String(id),
    type,
    title: searchHitTitle(hit),
    spaceKey: searchHitSpaceKey(hit),
    parent: hit.content?.ancestors?.at(-1)?.title,
    text: snippet(hit.excerpt),
    lastModified: shortTs(hit.lastModified),
    url: type === "page" || type === "blogpost" ? undefined : webUrl(session, hit.url),
  };
}

/** The issue key is the identifier and rebuilds the url; the numeric id and project key are derivable. */
function compactJira(hit: JiraHit) {
  const description = hit.fields?.description;
  const text =
    description === undefined || description === null
      ? undefined
      : adfToMarkdown(parseAdfBody(description));
  return {
    key: hit.key,
    type: "issue",
    title: hit.fields?.summary,
    text: snippet(text),
    lastModified: shortTs(hit.fields?.updated),
    status: hit.fields?.status?.name,
  };
}

/** Alternate items from each list so neither product crowds out the other. */
function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) {
        out.push(item);
      }
    }
  }
  return out;
}

const search = defineCommand({
  name: "search",
  summary: "Search Confluence and Jira content by text",
  mcpTools: ["search"],
  args: [{ name: "query", description: "Search text", required: true }],
  flags: Type.Object({
    type: Type.Optional(
      Type.Union(
        [
          Type.Literal("page"),
          Type.Literal("blogpost"),
          Type.Literal("attachment"),
          Type.Literal("comment"),
          Type.Literal("space"),
          Type.Literal("issue"),
        ],
        { description: "Restrict to one content type (issue implies --product jira)" },
      ),
    ),
    product: Type.Optional(
      Type.Union([Type.Literal("confluence"), Type.Literal("jira")], {
        description: "Restrict to one product (default: both)",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Total items to return (default ${DEFAULT_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(Type.String({ description: "Resume from a previous nextCursor" })),
  }),
  sideEffects: "none",
  examples: [
    'atl search "release checklist"',
    'atl search "onboarding" --type page --limit 5',
    'atl search "login bug" --product jira',
  ],
  async run(ctx, input) {
    const query = requireQuery(input.args.query, 'atl search "release checklist"');
    const { type, product } = input.flags;
    const typeProduct: Product | undefined =
      type === undefined ? undefined : type === "issue" ? "jira" : "confluence";
    if (typeProduct !== undefined && product !== undefined && typeProduct !== product) {
      throw new AtlError(`--type ${type} cannot be searched in ${product}`, {
        code: "conflicting_filters",
        category: "input",
        hint:
          typeProduct === "jira"
            ? "Use --product jira, or drop --product."
            : "Use --product confluence, or drop --product.",
      });
    }
    const only = product ?? typeProduct;
    const limit = input.flags.limit ?? DEFAULT_LIMIT;

    const state: SearchState =
      input.flags.cursor === undefined
        ? {
            confluence: { done: false, cursor: undefined },
            jira: { done: false, cursor: undefined },
            turn: 0,
          }
        : decodeCursor(input.flags.cursor);
    if (only !== undefined) {
      state[only === "jira" ? "confluence" : "jira"].done = true;
    }

    const session = await openSession(ctx, { fetch: searchDeps.fetch });
    const order: Product[] = state.turn === 0 ? ["confluence", "jira"] : ["jira", "confluence"];
    const collected: { confluence: ConfluenceHit[]; jira: JiraHit[] } = {
      confluence: [],
      jira: [],
    };

    // Each source is asked for exactly the items consumed, so its cursor resumes without gaps.
    let remaining = limit;
    for (;;) {
      const active = order.filter((name) => !state[name].done);
      if (remaining === 0 || active.length === 0) {
        break;
      }
      const share = Math.ceil(remaining / active.length);
      for (const name of active) {
        const take = Math.min(share, remaining);
        if (take === 0) {
          break;
        }
        let page: SourcePage<unknown>;
        if (name === "confluence") {
          const found = await searchConfluence(
            session,
            query,
            type === "issue" ? undefined : type,
            take,
            state.confluence.cursor,
          );
          collected.confluence.push(...found.items);
          page = found;
        } else {
          const found = await searchJira(session, query, take, state.jira.cursor);
          collected.jira.push(...found.items);
          page = found;
        }
        remaining -= page.items.length;
        state[name] = {
          done: page.next === null || page.items.length === 0,
          cursor: page.next ?? undefined,
        };
      }
    }

    const lists: Record<Product, readonly object[]> = {
      confluence: ctx.full
        ? collected.confluence
        : collected.confluence.map((hit) => compactConfluence(session, hit)),
      jira: ctx.full ? collected.jira : collected.jira.map(compactJira),
    };
    state.turn = state.turn === 0 ? 1 : 0;
    const items = interleave(order.map((name) => lists[name]));
    if (items.length === 0 && input.flags.cursor === undefined) {
      // The empty first page was already retried by the paginator, so the query itself has no hit.
      const cqlType = type === "issue" ? undefined : type;
      writeDiagnostic({
        type: "hint",
        code: "empty_search",
        hint: "No results; try fewer or alternate terms, or match titles/summaries only",
        next: [
          ...(only === "jira" ? [] : [["atl", "cql", confluenceCql(query, cqlType, "title")]]),
          ...(only === "confluence" ? [] : [["atl", "jql", jiraJql(query, "summary")]]),
        ],
      });
    }
    return {
      items,
      nextCursor: state.confluence.done && state.jira.done ? null : encodeStateCursor(state),
    };
  },
});

export const searchCommands: readonly CommandSpec[] = [search, userFind, userGet];
