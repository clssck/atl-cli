import { Type } from "../core/schema.ts";
import type { AdfDoc } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { FetchLike, Query } from "../core/http.ts";
import {
  paginateConfluenceV1Search,
  paginateConfluenceV2,
  type ConfluenceCursorPage,
  type ConfluenceSearchPage,
  type Paged,
} from "../core/paginate.ts";
import { API_ORIGIN, openSession, type Session } from "../core/session.ts";
import { parseConfluenceRef, parseSpaceRef } from "../resolve/index.ts";
import {
  ADF_FORMAT_FLAG,
  PAGING_FLAGS,
  pagePolicy,
  renderAdf,
  shortTs,
  type AdfFormat,
  type PagingFlags,
} from "./common.ts";

export const confluenceGroups: Readonly<Record<string, string>> = {
  page: "Confluence pages and blog posts: get, tree, children, versions, labels, create, update",
  space: "List Confluence spaces and their pages",
  comment: "Confluence footer and inline comments: list, get, replies, versions, add, update",
};

/** Test seam: an injected `fetch` used for every session opened by this module. */
export const confluenceDeps: { fetch?: FetchLike | undefined } = {};

const V2 = { defaultLimit: 25, maxPageSize: 250 };
const CQL = { defaultLimit: 25, maxPageSize: 50 };

// ---------------------------------------------------------------------------
// API shapes (fields used here; `--full` returns the raw objects)
// ---------------------------------------------------------------------------

interface Links {
  webui?: string;
  base?: string;
}

interface Version {
  number?: number;
  message?: string;
  minorEdit?: boolean;
  authorId?: string;
  createdAt?: string;
}

export interface ApiPage {
  id: string;
  type?: string;
  title?: string;
  spaceId?: string;
  parentId?: string;
  status?: string;
  authorId?: string;
  createdAt?: string;
  version?: Version;
  body?: {
    storage?: { value?: string };
    atlas_doc_format?: { value?: string };
  };
  _links?: Links;
}

interface ApiTreeNode {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  parentId?: string;
  depth?: number;
  childPosition?: number;
  body?: ApiPage["body"];
}

interface ApiLabel {
  id: string;
  name?: string;
  prefix?: string;
}

interface ApiSpace {
  id: string;
  key?: string;
  name?: string;
  type?: string;
  status?: string;
  homepageId?: string;
  _links?: Links;
}

export interface ApiComment {
  id: string;
  status?: string;
  pageId?: string;
  blogPostId?: string;
  parentCommentId?: string;
  resolutionStatus?: string;
  version?: Version;
  properties?: { inlineOriginalSelection?: string };
  body?: { atlas_doc_format?: { value?: string } } | undefined;
  _links?: Links;
}

interface ApiSearchResult {
  content?: { id?: string; type?: string; space?: { key?: string } };
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
  resultGlobalContainer?: { title?: string; displayUrl?: string };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export type ContentBase = "pages" | "blogposts";
export type CommentKind = "footer" | "inline";

export const TYPE_FLAG = Type.Optional(
  Type.Union([Type.Literal("page"), Type.Literal("blogpost")], {
    description: "Content type for bare ids (URLs and ARIs carry their own)",
  }),
);

export const INLINE_FLAG = Type.Optional(
  Type.Boolean({ description: "Target an inline comment instead of a footer comment" }),
);

export const COMMENT_SORT_FLAG = Type.Optional(
  Type.Union(
    [
      Type.Literal("created-date"),
      Type.Literal("-created-date"),
      Type.Literal("modified-date"),
      Type.Literal("-modified-date"),
    ],
    { description: "Sort order" },
  ),
);

/** Query asking Confluence v2 to return bodies as ADF. */
export const ADF_BODY = { "body-format": "atlas_doc_format" };

export function openConfluence(ctx: CommandContext, siteHint?: string): Promise<Session> {
  return openSession(ctx, { siteHint, fetch: confluenceDeps.fetch });
}

/** Resolve a page/blog post reference to its v2 collection and id. */
export function contentTarget(
  input: string,
  type: "page" | "blogpost" | undefined,
): { base: ContentBase; id: string; site: string | undefined } {
  const ref = parseConfluenceRef(input);
  if (ref.kind === "comment") {
    throw new AtlError(`${input} is a comment, not a page`, {
      code: "invalid_content_ref",
      category: "input",
      next: [["atl", "comment", "get", ref.id]],
    });
  }
  const kind =
    ref.kind === "blogpost"
      ? "blogpost"
      : ref.site === undefined && ref.cloudId === undefined
        ? (type ?? "page")
        : ref.kind === "unknown-content"
          ? (type ?? "page")
          : "page";
  return { base: kind === "blogpost" ? "blogposts" : "pages", id: ref.id, site: ref.site };
}

function pagesOnly(base: ContentBase, command: string): void {
  if (base === "blogposts") {
    throw new AtlError(`${command} is only available for pages; blog posts have no hierarchy`, {
      code: "unsupported_for_blogpost",
      category: "input",
    });
  }
}

/**
 * Canonical browser URL for a v2 `_links.webui` path (relative to `/wiki`): the
 * title slug after a page or blog post id is dropped; Confluence resolves either form.
 */
export function webUrl(session: Session, webui: string | undefined): string | undefined {
  if (webui === undefined) {
    return undefined;
  }
  const short = webui.replace(
    /^(\/spaces\/[^/]+\/(?:pages|blog\/\d{4}\/\d{2}\/\d{2})\/\d+)\/[^?#]*/,
    "$1",
  );
  return session.siteUrl(`/wiki${short}`);
}

const HIGHLIGHT = /@@@(?:end)?hl@@@/g;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};
const SNIPPET_MAX = 160;

/**
 * Search excerpt as one line: highlight markers stripped, HTML entities and literal
 * `\uXXXX` escapes decoded, whitespace collapsed, capped at 160 chars with an ellipsis.
 */
export function snippet(text: string | undefined): string | undefined {
  const flat = (text ?? "")
    .replaceAll(HIGHLIGHT, "")
    .replaceAll(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (flat === "") {
    return undefined;
  }
  const chars = Array.from(flat);
  return chars.length <= SNIPPET_MAX
    ? flat
    : `${chars
        .slice(0, SNIPPET_MAX - 1)
        .join("")
        .trimEnd()}…`;
}

interface ApiUser {
  accountId?: string;
  displayName?: string;
  publicName?: string;
}

const USER_BULK_MAX = 100;

/** Display names for account ids via `/rest/api/user/bulk`; ids the API omits map to themselves. */
export async function displayNames(
  session: Session,
  ids: Iterable<string | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => id !== undefined && id !== ""))];
  const names = new Map(unique.map((id) => [id, id]));
  for (let start = 0; start < unique.length; start += USER_BULK_MAX) {
    const page = await session.http.request<{ results?: ApiUser[] }>({
      method: "GET",
      url: session.confluenceUrl("/rest/api/user/bulk"),
      query: { accountId: unique.slice(start, start + USER_BULK_MAX) },
    });
    for (const user of page.results ?? []) {
      const name = user.displayName ?? user.publicName;
      if (user.accountId !== undefined && name !== undefined) {
        names.set(user.accountId, name);
      }
    }
  }
  return names;
}

/** Page/space-page list item; type and status appear only when not page/current. */
function listNode(node: ApiTreeNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    type: node.type === "page" ? undefined : node.type,
    status: node.status === "current" ? undefined : node.status,
  };
}

function listV2<T>(
  session: Session,
  path: string,
  flags: PagingFlags,
  query: Query = {},
): Promise<Paged<T>> {
  return paginateConfluenceV2<T>(pagePolicy(flags, V2), ({ cursor, pageSize }) =>
    session.http.request<ConfluenceCursorPage<T>>({
      method: "GET",
      url: session.confluenceUrl(path),
      query: { ...query, limit: pageSize, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
}

function mapPaged<T, U>(paged: Paged<T>, full: boolean, map: (item: T) => U): Paged<T | U> {
  return { ...paged, items: full ? paged.items : paged.items.map(map) };
}

/** Comma-separated flag value to a list; empty entries are dropped. */
function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function commentPath(kind: CommentKind): string {
  return kind === "inline" ? "/api/v2/inline-comments" : "/api/v2/footer-comments";
}

/** Browser URL of a comment: its webui path, else the page viewer focused on the comment. */
export function commentUrl(session: Session, comment: ApiComment): string | undefined {
  const contentId = comment.pageId ?? comment.blogPostId;
  return (
    webUrl(session, comment._links?.webui) ??
    (contentId === undefined
      ? undefined
      : session.siteUrl(
          `/wiki/pages/viewpage.action?pageId=${encodeURIComponent(contentId)}&focusedCommentId=${encodeURIComponent(comment.id)}`,
        ))
  );
}

function inlineFields(comment: ApiComment, kind: CommentKind): Record<string, unknown> {
  return kind === "inline"
    ? {
        resolutionStatus: comment.resolutionStatus,
        selection: comment.properties?.inlineOriginalSelection,
      }
    : {};
}

/** Single-comment view: ids, author name and accountId, body, and URL. */
function compactComment(
  session: Session,
  comment: ApiComment,
  kind: CommentKind,
  format: AdfFormat | undefined,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const adf = comment.body?.atlas_doc_format?.value;
  const authorId = comment.version?.authorId;
  return {
    id: comment.id,
    type: `${kind}-comment`,
    pageId: comment.pageId ?? comment.blogPostId,
    parentCommentId: comment.parentCommentId,
    status: comment.status,
    version: comment.version?.number,
    author: authorId === undefined ? undefined : names.get(authorId),
    authorId,
    updated: shortTs(comment.version?.createdAt),
    ...inlineFields(comment, kind),
    body: adf === undefined ? undefined : renderAdf(adf, format),
    url: commentUrl(session, comment),
  };
}

/** List item: id, author name, time, body; page id and url come from the request or `comment get`. */
function listComment(
  comment: ApiComment,
  kind: CommentKind,
  format: AdfFormat | undefined,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const adf = comment.body?.atlas_doc_format?.value;
  const authorId = comment.version?.authorId;
  return {
    id: comment.id,
    parentCommentId: comment.parentCommentId,
    status: comment.status === "current" ? undefined : comment.status,
    author: authorId === undefined ? undefined : names.get(authorId),
    updated: shortTs(comment.version?.createdAt),
    ...inlineFields(comment, kind),
    body: adf === undefined ? undefined : renderAdf(adf, format),
  };
}

/** Version list item: author as display name, minorEdit only when true. */
function listVersion(
  version: Version,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    number: version.number,
    message: version.message === "" ? undefined : version.message,
    minorEdit: version.minorEdit === true ? true : undefined,
    author: version.authorId === undefined ? undefined : names.get(version.authorId),
    created: shortTs(version.createdAt),
  };
}

// ---------------------------------------------------------------------------
// page.*
// ---------------------------------------------------------------------------

const PageGetFlags = Type.Object({
  format: Type.Optional(
    Type.Union([Type.Literal("md"), Type.Literal("adf"), Type.Literal("storage")], {
      description: "Body format: markdown (default), raw ADF, or storage XHTML",
      default: "md",
    }),
  ),
  type: TYPE_FLAG,
});

export const pageGet = defineCommand({
  name: "page.get",
  mcpTools: ["getConfluencePage"],
  summary: "Get a page or blog post with its body and url",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageGetFlags,
  sideEffects: "none",
  examples: [
    "atl page get 123456",
    "atl page get https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Title --format storage",
  ],
  async run(ctx, input) {
    const target = contentTarget(input.args.page ?? "", input.flags.type);
    const session = await openConfluence(ctx, target.site);
    const storage = input.flags.format === "storage";
    const page = await session.http.request<ApiPage>({
      method: "GET",
      url: session.confluenceUrl(`/api/v2/${target.base}/${encodeURIComponent(target.id)}`),
      query: { "body-format": storage ? "storage" : "atlas_doc_format" },
    });
    if (ctx.full) {
      return page;
    }
    const adf = page.body?.atlas_doc_format?.value;
    const body: string | string[] | AdfDoc | undefined = storage
      ? page.body?.storage?.value
      : adf === undefined
        ? undefined
        : renderAdf(adf, input.flags.format === "adf" ? "adf" : "md");
    return {
      id: page.id,
      type: target.base === "blogposts" ? "blogpost" : "page",
      title: page.title,
      spaceId: page.spaceId,
      parentId: page.parentId,
      status: page.status,
      version: page.version?.number,
      authorId: page.authorId,
      created: shortTs(page.createdAt),
      updated: shortTs(page.version?.createdAt),
      url: webUrl(session, page._links?.webui),
      body,
    };
  },
});

const PageTreeFlags = Type.Object({
  depth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Levels below the page (1-5, API default 5)",
    }),
  ),
  ...PAGING_FLAGS,
});

export const pageTree = defineCommand({
  name: "page.tree",
  mcpTools: ["getConfluencePageDescendants"],
  summary: "List descendants of a page, depth-limited; items omit url (see page get)",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageTreeFlags,
  sideEffects: "none",
  examples: ["atl page tree 123456 --depth 2", "atl page tree 123456 --all"],
  async run(ctx, input) {
    const target = contentTarget(input.args.page ?? "", "page");
    pagesOnly(target.base, "page tree");
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<ApiTreeNode>(
      session,
      `/api/v2/pages/${encodeURIComponent(target.id)}/descendants`,
      input.flags,
      input.flags.depth === undefined ? {} : { depth: input.flags.depth },
    );
    return mapPaged(paged, ctx.full, (node) => ({
      ...listNode(node),
      parentId: node.parentId ?? undefined,
      depth: node.depth,
    }));
  },
});

const PagingOnly = Type.Object({ ...PAGING_FLAGS });

export const pageChildren = defineCommand({
  name: "page.children",
  summary: "List the direct children of a page; url is <site>/wiki/spaces/<KEY>/pages/<id>",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PagingOnly,
  sideEffects: "none",
  examples: ["atl page children 123456"],
  async run(ctx, input) {
    const target = contentTarget(input.args.page ?? "", "page");
    pagesOnly(target.base, "page children");
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<ApiTreeNode>(
      session,
      `/api/v2/pages/${encodeURIComponent(target.id)}/direct-children`,
      input.flags,
    );
    return mapPaged(paged, ctx.full, listNode);
  },
});

const ContentListFlags = Type.Object({ type: TYPE_FLAG, ...PAGING_FLAGS });

export const pageVersions = defineCommand({
  name: "page.versions",
  summary: "List versions of a page or blog post; author is a display name",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: ContentListFlags,
  sideEffects: "none",
  examples: ["atl page versions 123456 --limit 5"],
  async run(ctx, input) {
    const target = contentTarget(input.args.page ?? "", input.flags.type);
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<Version>(
      session,
      `/api/v2/${target.base}/${encodeURIComponent(target.id)}/versions`,
      input.flags,
    );
    if (ctx.full) {
      return paged;
    }
    const names = await displayNames(
      session,
      paged.items.map((version) => version.authorId),
    );
    return { ...paged, items: paged.items.map((version) => listVersion(version, names)) };
  },
});

export const pageLabels = defineCommand({
  name: "page.labels",
  summary: "List labels on a page or blog post",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: ContentListFlags,
  sideEffects: "none",
  examples: ["atl page labels 123456"],
  async run(ctx, input) {
    const target = contentTarget(input.args.page ?? "", input.flags.type);
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<ApiLabel>(
      session,
      `/api/v2/${target.base}/${encodeURIComponent(target.id)}/labels`,
      input.flags,
    );
    return mapPaged(paged, ctx.full, (label) => ({
      id: label.id,
      name: label.name,
      prefix: label.prefix === "global" ? undefined : label.prefix,
    }));
  },
});

// ---------------------------------------------------------------------------
// space.*
// ---------------------------------------------------------------------------

/** Space list item; type and status appear only when not global/current. */
function compactSpace(space: ApiSpace): Record<string, unknown> {
  return {
    id: space.id,
    key: space.key,
    name: space.name,
    type: space.type === "global" ? undefined : space.type,
    status: space.status === "current" ? undefined : space.status,
    homepageId: space.homepageId,
  };
}

const SpaceListFlags = Type.Object({
  ids: Type.Optional(Type.String({ description: "Comma-separated space ids" })),
  keys: Type.Optional(Type.String({ description: "Comma-separated space keys" })),
  type: Type.Optional(
    Type.Union([Type.Literal("global"), Type.Literal("personal")], {
      description: "Space type filter",
    }),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("current"), Type.Literal("archived"), Type.Literal("trashed")], {
      description: "Space status filter",
    }),
  ),
  labels: Type.Optional(Type.String({ description: "Comma-separated space labels" })),
  favourite: Type.Optional(Type.Boolean({ description: "Only spaces you have favorited" })),
  favoritedBy: Type.Optional(
    Type.String({ description: "Only spaces favorited by this account id" }),
  ),
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal("id"),
        Type.Literal("-id"),
        Type.Literal("key"),
        Type.Literal("-key"),
        Type.Literal("name"),
        Type.Literal("-name"),
      ],
      { description: "Sort order" },
    ),
  ),
  ...PAGING_FLAGS,
});

async function currentAccountId(session: Session): Promise<string> {
  const me = await session.http.request({ method: "GET", url: `${API_ORIGIN}/me` });
  if (isRecord(me) && typeof me.account_id === "string") {
    return me.account_id;
  }
  throw new AtlError("/me returned no account_id", {
    code: "unexpected_response",
    category: "api",
  });
}

export const spaceList = defineCommand({
  name: "space.list",
  summary: "List spaces; items omit url (<site>/wiki/spaces/<key>)",
  mcpTools: ["getConfluenceSpaces"],
  args: [],
  flags: SpaceListFlags,
  sideEffects: "none",
  examples: [
    "atl space list --type global",
    "atl space list --keys ENG,OPS",
    "atl space list --labels runbooks --status current --sort name",
    "atl space list --favourite",
  ],
  async run(ctx, input) {
    const { flags } = input;
    if (flags.favourite === true && flags.favoritedBy !== undefined) {
      throw new AtlError("--favourite and --favorited-by are mutually exclusive", {
        code: "invalid_flag_combination",
        category: "input",
        hint: "--favourite uses your own account id",
      });
    }
    const session = await openConfluence(ctx);
    const favoritedBy =
      flags.favourite === true ? await currentAccountId(session) : flags.favoritedBy;
    const paged = await listV2<ApiSpace>(session, "/api/v2/spaces", flags, {
      ids: splitList(flags.ids),
      keys: splitList(flags.keys),
      type: flags.type,
      status: flags.status,
      labels: splitList(flags.labels),
      "favorited-by": favoritedBy,
      sort: flags.sort,
    });
    return mapPaged(paged, ctx.full, compactSpace);
  },
});

/** Site host named by a space URL, so the right site is opened; undefined for keys and ids. */
export function spaceSiteHint(raw: string): string | undefined {
  return /^https?:\/\//i.test(raw) ? new URL(raw).hostname : undefined;
}

/** Numeric space id for a space key, id, or space URL. */
export async function resolveSpaceId(session: Session, raw: string): Promise<string> {
  const ref = parseSpaceRef(raw);
  if (ref.id !== undefined) {
    return ref.id;
  }
  const found = await session.http.request<ConfluenceCursorPage<ApiSpace>>({
    method: "GET",
    url: session.confluenceUrl("/api/v2/spaces"),
    query: { keys: ref.key ?? "", limit: 1 },
  });
  const id = found.results[0]?.id;
  if (id === undefined) {
    throw new AtlError(`Space ${ref.key ?? raw} not found`, {
      code: "space_not_found",
      category: "input",
      next: [["atl", "space", "list"]],
    });
  }
  return id;
}

const SpacePagesFlags = Type.Object({
  type: Type.Optional(
    Type.Union([Type.Literal("page"), Type.Literal("blogpost")], {
      description: "List pages (default) or blog posts",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Exact title filter" })),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("current"),
        Type.Literal("archived"),
        Type.Literal("deleted"),
        Type.Literal("trashed"),
      ],
      { description: "Status filter (archived: pages only)" },
    ),
  ),
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal("id"),
        Type.Literal("-id"),
        Type.Literal("created-date"),
        Type.Literal("-created-date"),
        Type.Literal("modified-date"),
        Type.Literal("-modified-date"),
        Type.Literal("title"),
        Type.Literal("-title"),
      ],
      { description: "Sort order (title: pages only)" },
    ),
  ),
  body: Type.Optional(Type.Boolean({ description: "Include each item's body (see --format)" })),
  format: ADF_FORMAT_FLAG,
  ...PAGING_FLAGS,
});

export const spacePages = defineCommand({
  name: "space.pages",
  summary: "List pages or blog posts in a space; url is <site>/wiki/spaces/<KEY>/pages/<id>",
  mcpTools: ["getPagesInConfluenceSpace"],
  args: [{ name: "space", description: "Space key, id, or space URL", required: true }],
  flags: SpacePagesFlags,
  sideEffects: "none",
  examples: [
    "atl space pages ENG --limit 50",
    "atl space pages ENG --title 'Runbook'",
    "atl space pages ENG --type blogpost --sort -created-date",
    "atl space pages ENG --body --format md --limit 5",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const raw = input.args.space ?? "";
    const session = await openConfluence(ctx, spaceSiteHint(raw));
    const spaceId = await resolveSpaceId(session, raw);
    const collection = flags.type === "blogpost" ? "blogposts" : "pages";
    const paged = await listV2<ApiTreeNode>(
      session,
      `/api/v2/spaces/${encodeURIComponent(spaceId)}/${collection}`,
      flags,
      {
        title: flags.title,
        status: flags.status,
        sort: flags.sort,
        ...(flags.body === true ? ADF_BODY : {}),
      },
    );
    return mapPaged(paged, ctx.full, (node) => {
      const adf = node.body?.atlas_doc_format?.value;
      return {
        ...listNode(node),
        parentId: node.parentId ?? undefined,
        ...(flags.body === true && adf !== undefined ? { body: renderAdf(adf, flags.format) } : {}),
      };
    });
  },
});

// ---------------------------------------------------------------------------
// comment.*
// ---------------------------------------------------------------------------

const CommentListFlags = Type.Object({
  inline: Type.Optional(
    Type.Boolean({ description: "Inline comments instead of footer comments" }),
  ),
  replies: Type.Optional(
    Type.Boolean({
      description:
        "Nest replies under each comment (one extra request per comment, each bounded by --limit)",
    }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("current"),
        Type.Literal("archived"),
        Type.Literal("trashed"),
        Type.Literal("deleted"),
        Type.Literal("historical"),
        Type.Literal("draft"),
      ],
      { description: "Comment status filter" },
    ),
  ),
  resolution: Type.Optional(
    Type.Union(
      [
        Type.Literal("open"),
        Type.Literal("resolved"),
        Type.Literal("reopened"),
        Type.Literal("dangling"),
      ],
      { description: "Inline comment resolution filter (requires --inline)" },
    ),
  ),
  sort: COMMENT_SORT_FLAG,
  repliesPerComment: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 25,
      description: "Replies fetched per comment with --replies (default: --limit)",
    }),
  ),
  format: ADF_FORMAT_FLAG,
  type: TYPE_FLAG,
  ...PAGING_FLAGS,
});

export const commentList = defineCommand({
  name: "comment.list",
  mcpTools: ["getConfluencePageFooterComments", "getConfluencePageInlineComments"],
  summary:
    "List footer or inline comments on a page or blog post; items omit pageId and url (see comment get)",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: CommentListFlags,
  sideEffects: "none",
  examples: [
    "atl comment list 123456",
    "atl comment list 123456 --inline --resolution open",
    "atl comment list 123456 --replies --limit 10",
  ],
  async run(ctx, input) {
    const { flags } = input;
    if (flags.resolution !== undefined && flags.inline !== true) {
      throw new AtlError("--resolution only applies to inline comments", {
        code: "invalid_flag_combination",
        category: "input",
        hint: "Add --inline or drop --resolution",
      });
    }
    const kind: CommentKind = flags.inline === true ? "inline" : "footer";
    const target = contentTarget(input.args.page ?? "", flags.type);
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<ApiComment>(
      session,
      `/api/v2/${target.base}/${encodeURIComponent(target.id)}/${kind}-comments`,
      flags,
      {
        ...ADF_BODY,
        ...(flags.status === undefined ? {} : { status: flags.status }),
        sort: flags.sort,
        ...(flags.resolution === undefined ? {} : { "resolution-status": flags.resolution }),
      },
    );
    const replies =
      flags.replies === true
        ? await Promise.all(
            paged.items.map((comment) =>
              listV2<ApiComment>(
                session,
                `${commentPath(kind)}/${encodeURIComponent(comment.id)}/children`,
                { limit: flags.repliesPerComment ?? flags.limit },
                { ...ADF_BODY, sort: flags.sort },
              ),
            ),
          )
        : undefined;
    if (ctx.full) {
      return {
        ...paged,
        items: paged.items.map((comment, index) => {
          const nested = replies?.[index];
          return nested === undefined
            ? comment
            : {
                ...comment,
                replies: nested.items,
                ...(nested.nextCursor === null ? {} : { repliesNextCursor: nested.nextCursor }),
              };
        }),
      };
    }
    const names = await displayNames(
      session,
      [...paged.items, ...(replies ?? []).flatMap((nested) => nested.items)].map(
        (comment) => comment.version?.authorId,
      ),
    );
    const item = (comment: ApiComment) => listComment(comment, kind, flags.format, names);
    return {
      ...paged,
      items: paged.items.map((comment, index) => {
        const out = item(comment);
        const nested = replies?.[index];
        if (nested !== undefined && nested.items.length > 0) {
          out.replies = nested.items.map(item);
        }
        if (nested !== undefined && nested.nextCursor !== null) {
          out.repliesNextCursor = nested.nextCursor;
        }
        return out;
      }),
    };
  },
});

/** Comment id from a bare id or a page URL carrying `focusedCommentId`. */
export function commentTarget(input: string): { id: string; site: string | undefined } {
  const text = input.trim();
  if (/^\d+$/.test(text)) {
    return { id: text, site: undefined };
  }
  const ref = parseConfluenceRef(text);
  if (ref.commentId !== undefined) {
    return { id: ref.commentId, site: ref.site };
  }
  if (ref.kind === "comment") {
    return { id: ref.id, site: ref.site };
  }
  throw new AtlError(`No comment id in ${input}`, {
    code: "invalid_comment_ref",
    category: "input",
    hint: "Pass a comment id or a page URL with ?focusedCommentId=<id>",
    next: [["atl", "comment", "list", text]],
  });
}

const CommentGetFlags = Type.Object({ inline: INLINE_FLAG, format: ADF_FORMAT_FLAG });

export const commentGet = defineCommand({
  name: "comment.get",
  summary: "Get one footer or inline comment",
  args: [
    { name: "comment", description: "Comment id or URL with focusedCommentId", required: true },
  ],
  flags: CommentGetFlags,
  sideEffects: "none",
  examples: [
    "atl comment get 789",
    "atl comment get 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123?focusedCommentId=789'",
    "atl comment get 790 --inline",
  ],
  async run(ctx, input) {
    const target = commentTarget(input.args.comment ?? "");
    const kind: CommentKind = input.flags.inline === true ? "inline" : "footer";
    const session = await openConfluence(ctx, target.site);
    const comment = await session.http.request<ApiComment>({
      method: "GET",
      url: session.confluenceUrl(`${commentPath(kind)}/${encodeURIComponent(target.id)}`),
      query: ADF_BODY,
    });
    if (ctx.full) {
      return comment;
    }
    const names = await displayNames(session, [comment.version?.authorId]);
    return compactComment(session, comment, kind, input.flags.format, names);
  },
});

const CommentRepliesFlags = Type.Object({
  inline: INLINE_FLAG,
  sort: COMMENT_SORT_FLAG,
  format: ADF_FORMAT_FLAG,
  ...PAGING_FLAGS,
});

export const commentReplies = defineCommand({
  name: "comment.replies",
  mcpTools: ["getConfluenceCommentChildren"],
  summary: "List replies to a comment; author is a display name, url comes from comment get",
  args: [
    { name: "comment", description: "Comment id or URL with focusedCommentId", required: true },
  ],
  flags: CommentRepliesFlags,
  sideEffects: "none",
  examples: ["atl comment replies 789", "atl comment replies 790 --inline"],
  async run(ctx, input) {
    const target = commentTarget(input.args.comment ?? "");
    const kind: CommentKind = input.flags.inline === true ? "inline" : "footer";
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<ApiComment>(
      session,
      `${commentPath(kind)}/${encodeURIComponent(target.id)}/children`,
      input.flags,
      { ...ADF_BODY, sort: input.flags.sort },
    );
    if (ctx.full) {
      return paged;
    }
    const names = await displayNames(
      session,
      paged.items.map((comment) => comment.version?.authorId),
    );
    return {
      ...paged,
      items: paged.items.map((comment) => listComment(comment, kind, input.flags.format, names)),
    };
  },
});

const CommentVersionsFlags = Type.Object({ inline: INLINE_FLAG, ...PAGING_FLAGS });

export const commentVersions = defineCommand({
  name: "comment.versions",
  summary: "List versions of a comment; author is a display name",
  args: [
    { name: "comment", description: "Comment id or URL with focusedCommentId", required: true },
  ],
  flags: CommentVersionsFlags,
  sideEffects: "none",
  examples: ["atl comment versions 789"],
  async run(ctx, input) {
    const target = commentTarget(input.args.comment ?? "");
    const kind: CommentKind = input.flags.inline === true ? "inline" : "footer";
    const session = await openConfluence(ctx, target.site);
    const paged = await listV2<Version>(
      session,
      `${commentPath(kind)}/${encodeURIComponent(target.id)}/versions`,
      input.flags,
    );
    if (ctx.full) {
      return paged;
    }
    const names = await displayNames(
      session,
      paged.items.map((version) => version.authorId),
    );
    return { ...paged, items: paged.items.map((version) => listVersion(version, names)) };
  },
});

// ---------------------------------------------------------------------------
// cql
// ---------------------------------------------------------------------------

const CqlFlags = Type.Object({
  cqlContext: Type.Optional(
    Type.String({ description: 'CQL context JSON, e.g. {"spaceKey":"ENG"}' }),
  ),
  expand: Type.Optional(Type.String({ description: "Comma-separated properties to expand" })),
  ...PAGING_FLAGS,
});

export const cql = defineCommand({
  name: "cql",
  mcpTools: ["searchConfluenceUsingCql"],
  summary: "Search Confluence with CQL; page and blog post hits omit url (see page get)",
  args: [{ name: "query", description: "CQL query", required: true }],
  flags: CqlFlags,
  sideEffects: "none",
  examples: [
    "atl cql 'space = ENG AND type = page AND title ~ \"runbook\"'",
    "atl cql 'label = \"release\"' --all",
  ],
  async run(ctx, input) {
    const session = await openConfluence(ctx);
    const paged = await paginateConfluenceV1Search<ApiSearchResult>(
      pagePolicy(input.flags, CQL),
      ({ cursor, pageSize }) =>
        session.http.request<ConfluenceSearchPage<ApiSearchResult>>({
          method: "GET",
          url: session.confluenceUrl("/rest/api/search"),
          query: {
            cql: input.args.query ?? "",
            cqlcontext: input.flags.cqlContext,
            expand: input.flags.expand,
            limit: pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          },
        }),
    );
    return mapPaged(paged, ctx.full, (result) => {
      const displayUrl = result.resultGlobalContainer?.displayUrl;
      const containerKey = displayUrl?.match(/^\/spaces\/([^/]+)/)?.[1];
      const type = result.content?.type;
      return {
        id: result.content?.id,
        type: type === "page" ? undefined : type,
        title: result.title?.replaceAll(HIGHLIGHT, ""),
        spaceKey:
          containerKey === undefined
            ? result.content?.space?.key
            : decodeURIComponent(containerKey),
        excerpt: snippet(result.excerpt),
        lastModified: shortTs(result.lastModified),
        url: type === "page" || type === "blogpost" ? undefined : webUrl(session, result.url),
      };
    });
  },
});

export const confluenceCommands: readonly CommandSpec[] = [
  pageGet,
  pageTree,
  pageChildren,
  pageVersions,
  pageLabels,
  spaceList,
  spacePages,
  commentList,
  commentGet,
  commentReplies,
  commentVersions,
  cql,
];
