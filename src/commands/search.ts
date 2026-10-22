import { Type } from "../core/schema.ts";
import { adfToMarkdown, parseAdfBody, type AdfDoc } from "../adf/index.ts";
import { defineCommand, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { FetchLike } from "../core/http.ts";
import { cursorFromNextLink, decodeStateCursor, encodeStateCursor } from "../core/paginate.ts";
import { openSession, type Session } from "../core/session.ts";
import { shortTs } from "./common.ts";
import { snippet, webUrl } from "./confluence.ts";

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

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

type Product = "confluence" | "jira";

interface ConfluenceHit {
  content?: { id?: string; type?: string };
  space?: { id?: number | string };
  entityType?: string;
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
}

interface ConfluenceSearchPage {
  results?: ConfluenceHit[];
  cursor?: string;
  _links?: { next?: string };
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

const HIGHLIGHT = /@@@(?:end)?hl@@@/g;
const JIRA_FIELDS = "summary,updated,status,issuetype,project,description";

async function searchConfluence(
  session: Session,
  query: string,
  type: string | undefined,
  take: number,
  cursor: string | undefined,
): Promise<SourcePage<ConfluenceHit>> {
  const cql = `text ~ ${JSON.stringify(query)}${type === undefined ? "" : ` AND type = ${type}`}`;
  const page = await session.http.request<ConfluenceSearchPage>({
    method: "GET",
    url: session.confluenceUrl("/rest/api/search"),
    query: { cql, limit: take, ...(cursor === undefined ? {} : { cursor }) },
  });
  const linked = cursorFromNextLink(page._links?.next);
  return {
    items: page.results ?? [],
    next: linked ?? (page.cursor === undefined || page.cursor === "" ? null : page.cursor),
  };
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
      jql: `text ~ ${JSON.stringify(query)}`,
      fields: JIRA_FIELDS,
      maxResults: take,
      ...(cursor === undefined ? {} : { nextPageToken: cursor }),
    },
  });
  const more =
    page.isLast !== true && page.nextPageToken !== undefined && page.nextPageToken !== "";
  return { items: page.issues ?? [], next: more ? (page.nextPageToken ?? null) : null };
}

/** Same item shape as `cql`: bare content id plus type; the url only where id and type cannot rebuild it. */
function compactConfluence(session: Session, hit: ConfluenceHit) {
  const type = hit.content?.type ?? hit.entityType;
  const id = hit.content?.id ?? (type === "space" ? hit.space?.id : undefined);
  return {
    id: id === undefined ? undefined : String(id),
    type,
    title: hit.title?.replaceAll(HIGHLIGHT, ""),
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
    return {
      items: interleave(order.map((name) => lists[name])),
      nextCursor: state.confluence.done && state.jira.done ? null : encodeStateCursor(state),
    };
  },
});

export const searchCommands: readonly CommandSpec[] = [search, userFind];
