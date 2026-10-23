import { Type } from "../core/schema.ts";
import { adfToMarkdown, parseAdfBody, type AdfDoc } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, inputError, type NextCommand } from "../core/errors.ts";
import type { FetchLike, Query } from "../core/http.ts";
import { keepRaw, splitList, withSource, writeDiagnostic } from "../core/output.ts";
import {
  decodeStateCursor,
  encodeStateCursor,
  paginateConfluenceV1Search,
  paginateConfluenceV2,
  type ConfluenceCursorPage,
  type ConfluenceSearchPage,
  type Paged,
} from "../core/paginate.ts";
import { currentAccountId, openSession, type Session } from "../core/session.ts";
import {
  pageTitleRef,
  parseConfluenceRef,
  parseDisplayLink,
  parseSpaceRef,
} from "../resolve/index.ts";
import {
  ADF_FORMAT_FLAG,
  PAGING_FLAGS,
  pagePolicy,
  BODY_LINE_BYTES,
  bodyLines,
  renderAdf,
  queryLiteral,
  shortTs,
  type AdfFormat,
  type PagingFlags,
} from "./common.ts";
import { GREP_RANGE_CAP, grepPattern, grepRanges } from "./grep.ts";

export const confluenceGroups: Readonly<Record<string, string>> = {
  page: "Confluence pages and blog posts: get, diff, ancestors, tree, children, versions, labels, permissions, restriction, operations, properties, property set|delete, create, update",
  space: "Confluence spaces: list, get, personal, pages",
  attachment: "Confluence attachment metadata: list, get (downloads need a scope the token lacks)",
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
  /** The v2 versions endpoints embed the content as it was in that version. */
  page?: { title?: string };
}

export interface ApiPage {
  id: string;
  type?: string;
  title?: string;
  spaceId?: string;
  parentId?: string;
  /** `page`, `folder`, `whiteboard`, `database` or `embed`. */
  parentType?: string;
  status?: string;
  authorId?: string;
  createdAt?: string;
  version?: Version;
  body?: {
    storage?: { value?: string };
    atlas_doc_format?: { value?: string };
    view?: { value?: string };
  };
  _links?: Links;
}

interface ApiTreeNode {
  id: string;
  title?: string;
  type?: string;
  spaceId?: string;
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
  content?: {
    id?: string;
    type?: string;
    title?: string;
    space?: { key?: string };
    ancestors?: { title?: string }[];
  };
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
  resultGlobalContainer?: { title?: string; displayUrl?: string };
}

/** Id of the page or blog post an attachment hit belongs to (its `?pageId=` url); other hits have none. */
export function searchHitContainerId(
  hit: Pick<ApiSearchResult, "content" | "url">,
): string | undefined {
  return hit.content?.type === "attachment" ? hit.url?.match(/[?&]pageId=(\d+)/)?.[1] : undefined;
}

/** Space key of a v1 search hit: the container's `/spaces/KEY` display URL, else the expanded space. */
export function searchHitSpaceKey(
  hit: Pick<ApiSearchResult, "content" | "resultGlobalContainer">,
): string | undefined {
  const containerKey = hit.resultGlobalContainer?.displayUrl?.match(/^\/spaces\/([^/]+)/)?.[1];
  return containerKey === undefined ? hit.content?.space?.key : decodeURIComponent(containerKey);
}

/**
 * Title of a v1 search hit. The top-level `title` is HTML-escaped (`&quot;`, `&#39;`, `&amp;`) and
 * may carry highlight markers; the content's own title is the stored text, so it wins when present.
 */
export function searchHitTitle(
  hit: Pick<ApiSearchResult, "content" | "title">,
): string | undefined {
  return (
    hit.content?.title ??
    (hit.title === undefined ? undefined : decodeEntities(hit.title.replaceAll(HIGHLIGHT, "")))
  );
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

/** Narrows a page title to one space; ids and links name their own page. */
const PAGE_SPACE_FLAG = Type.Optional(
  Type.String({
    description: "Space key, id, or URL: narrows a page title (ignored for ids and links)",
  }),
);

const PAGE_ARG =
  "Page id, URL, tiny link, ARI, or exact title (titles repeat across spaces: add --space)";

const COMMENT_KIND_LITERALS = [Type.Literal("footer"), Type.Literal("inline")] as const;

export const COMMENT_KIND_FLAG = Type.Optional(
  Type.Union(COMMENT_KIND_LITERALS, {
    description: "Comment kind (default footer)",
    default: "footer",
  }),
);

/** Comment kind to read: no default, so `readComment` can look at both when none is given. */
export const COMMENT_LOOKUP_KIND_FLAG = Type.Optional(
  Type.Union(COMMENT_KIND_LITERALS, {
    description: "Comment kind (default: footer, then inline when the id is not a footer comment)",
  }),
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

export function openConfluence(
  ctx: CommandContext,
  siteHint?: string,
  cloudId?: string,
): Promise<Session> {
  return openSession(ctx, { siteHint, cloudId, fetch: confluenceDeps.fetch });
}

export interface ContentTarget {
  base: ContentBase;
  id: string;
  site: string | undefined;
  /** Cloud id of a content ARI: the site it belongs to. */
  cloudId: string | undefined;
  /** `pageVersion=` of a page URL. */
  version: number | undefined;
  /** The reference does not say page or blog post and no --type was given: a miss on `base` is retried on the other collection. */
  probe: boolean;
}

/** Resolve a page/blog post reference to its v2 collection and id. */
export function contentTarget(input: string, type: "page" | "blogpost" | undefined): ContentTarget {
  const ref = parseConfluenceRef(input);
  if (ref.kind === "comment") {
    throw new AtlError(`${input} is a comment, not a page`, {
      code: "invalid_content_ref",
      category: "input",
      next: [["atl", "comment", "get", ref.id]],
    });
  }
  // A bare id and a content-only link (viewer, tiny link, content ARI) do not say page or blog post.
  const undetermined =
    ref.kind === "unknown-content" ||
    (ref.kind === "page" && ref.site === undefined && ref.cloudId === undefined);
  const kind = ref.kind === "blogpost" ? "blogpost" : undetermined ? (type ?? "page") : "page";
  return {
    base: kind === "blogpost" ? "blogposts" : "pages",
    id: ref.id,
    site: ref.site,
    cloudId: ref.cloudId,
    version: ref.version,
    probe: undetermined && type === undefined,
  };
}

/** Search results fetched per title lookup; enough to tell a case variant from the exact title. */
const TITLE_LOOKUP_LIMIT = 50;
/** Candidates listed by an ambiguous-title error. */
const TITLE_CANDIDATES_MAX = 10;
/** Characters that print as a plain space or nothing, so two titles differing only by them look equal. */
const INVISIBLE_CHARS = /[\u00A0\u200B-\u200D\u2060\uFEFF]/;

/** Pages (or blog posts) titled `title`: the exact-case matches, else the case-insensitive ones. */
async function contentByTitle(
  session: Session,
  base: ContentBase,
  title: string,
  spaceId: string | undefined,
): Promise<ApiTreeNode[]> {
  const path =
    spaceId === undefined
      ? `/api/v2/${base}`
      : `/api/v2/spaces/${encodeURIComponent(spaceId)}/${base}`;
  const found = await session.http.request<ConfluenceCursorPage<ApiTreeNode>>({
    method: "GET",
    url: session.confluenceUrl(path),
    query: { title, limit: TITLE_LOOKUP_LIMIT },
  });
  const exact = found.results.filter((node) => node.title === title);
  if (exact.length > 0) {
    return exact;
  }
  const lower = title.toLowerCase();
  return found.results.filter((node) => node.title?.toLowerCase() === lower);
}

/** `atl page get <title>` found no page. */
function titleNotFound(title: string, space: string | undefined): AtlError {
  const scope = space === undefined ? "" : ` in space ${space}`;
  const invisible = INVISIBLE_CHARS.test(title)
    ? "; the title contains non-breaking or zero-width characters, which count as different from plain spaces"
    : "";
  return new AtlError(`No page titled "${title}"${scope}`, {
    code: "not_found",
    category: "api",
    hint: `Titles match exactly (case-insensitive fallback only); search by words instead: atl search "${title}"${invisible}`,
    next: [["atl", "search", title]],
  });
}

/** The invocation with the title argument replaced by a page id, so each candidate is one command away. */
function candidateArgv(ctx: CommandContext, input: string, id: string): NextCommand {
  const argv = ctx.argv.includes(input)
    ? ctx.argv.map((arg) => (arg === input ? id : arg))
    : ["page", "get", id];
  return ["atl", ...argv];
}

/** Several pages share the title (titles are unique per space only): list them with their spaces. */
async function ambiguousTitle(
  ctx: CommandContext,
  session: Session,
  input: string,
  title: string,
  matches: readonly ApiTreeNode[],
): Promise<AtlError> {
  const shown = matches.slice(0, TITLE_CANDIDATES_MAX);
  const spaceIds = [...new Set(shown.map((node) => node.spaceId).filter((id) => id !== undefined))];
  const keys = new Map<string, string>();
  if (spaceIds.length > 0) {
    const spaces = await session.http.request<ConfluenceCursorPage<ApiSpace>>({
      method: "GET",
      url: session.confluenceUrl("/api/v2/spaces"),
      query: { ids: spaceIds, limit: spaceIds.length },
    });
    for (const space of spaces.results) {
      if (space.key !== undefined) {
        keys.set(space.id, space.key);
      }
    }
  }
  const lines = shown.map(
    (node) =>
      `${node.id}  ${keys.get(node.spaceId ?? "") ?? node.spaceId ?? "?"}  ${node.title ?? title}`,
  );
  const more = matches.length > shown.length ? `\n(and ${matches.length - shown.length} more)` : "";
  return new AtlError(
    `Title "${title}" matches ${matches.length} pages; pick one by id:\n${lines.join("\n")}${more}`,
    {
      code: "ambiguous_title",
      category: "input",
      hint: "Pass the page id, or narrow with --space <KEY>",
      next: shown.map((node) => candidateArgv(ctx, input, node.id)),
    },
  );
}

/** Find the one page (or blog post with --type blogpost) with this title, optionally within a space. */
async function openTitle(
  ctx: CommandContext,
  input: string,
  title: string,
  options: ContentRefOptions,
): Promise<{ session: Session; target: ContentTarget }> {
  const { space } = options;
  const session = await openConfluence(ctx, space === undefined ? undefined : spaceSiteHint(space));
  const base: ContentBase = options.type === "blogpost" ? "blogposts" : "pages";
  const spaceId = space === undefined ? undefined : await resolveSpaceId(session, space);
  const matches = await contentByTitle(session, base, title, spaceId);
  const [match] = matches;
  if (match === undefined) {
    throw titleNotFound(title, space);
  }
  if (matches.length > 1) {
    throw await ambiguousTitle(ctx, session, input, title, matches);
  }
  const target: ContentTarget = {
    base,
    id: match.id,
    site: undefined,
    cloudId: undefined,
    version: undefined,
    probe: false,
  };
  return { session, target };
}

/** How a page reference is read: `type` for bare ids, `space` to narrow a title. */
export interface ContentRefOptions {
  type?: "page" | "blogpost" | undefined;
  space?: string | undefined;
}

/** The reference to repeat in follow-up commands: the id once a title has been resolved. */
function resolvedRef(input: string, target: ContentTarget): string {
  return pageTitleRef(input) === undefined ? input : target.id;
}

/**
 * Open the session for a page/blog post reference and resolve it. A title (anything that is not an
 * id, ARI, or URL) is looked up by exact title; a legacy `/display/<SPACE>/<Title>` link carries no
 * id and is looked up the same way in its space.
 */
async function openContent(
  ctx: CommandContext,
  input: string,
  options: ContentRefOptions,
): Promise<{ session: Session; target: ContentTarget }> {
  const title = pageTitleRef(input);
  if (title !== undefined) {
    return await openTitle(ctx, input, title, options);
  }
  const display = parseDisplayLink(input);
  if (display === undefined) {
    const target = contentTarget(input, options.type);
    return { session: await openConfluence(ctx, target.site, target.cloudId), target };
  }
  const session = await openConfluence(ctx, display.site);
  const spaceId = await resolveSpaceId(session, display.spaceKey);
  const [page] = await contentByTitle(session, "pages", display.title, spaceId);
  if (page === undefined) {
    throw new AtlError(`No page titled "${display.title}" in space ${display.spaceKey}`, {
      code: "page_not_found",
      category: "api",
      next: [["atl", "space", "pages", display.spaceKey, "--title", display.title]],
    });
  }
  const target: ContentTarget = {
    base: "pages",
    id: page.id,
    site: display.site,
    cloudId: undefined,
    version: undefined,
    probe: false,
  };
  return { session, target };
}

function isMissing(error: unknown): error is AtlError {
  return error instanceof AtlError && (error.status === 404 || error.status === 400);
}

/**
 * Run a request against a page or blog post. When the reference does not say which
 * (`target.probe`), a 404/400 from the page collection is retried on blog posts; the page error is
 * reported when both miss. The returned target names the collection that answered, for the
 * requests that follow. `run` must be a read: it can be repeated.
 */
export async function probeBase<T>(
  target: ContentTarget,
  run: (target: ContentTarget) => Promise<T>,
): Promise<{ target: ContentTarget; value: T }> {
  try {
    return { target, value: await run(target) };
  } catch (error) {
    if (!target.probe || !isMissing(error)) {
      throw error;
    }
    const blog: ContentTarget = { ...target, base: "blogposts", probe: false };
    try {
      return { target: blog, value: await run(blog) };
    } catch (second) {
      throw isMissing(second) ? error : second;
    }
  }
}

/** Run a read against a page or blog post (see `probeBase`). */
async function readContent<T>(
  ctx: CommandContext,
  input: string,
  options: ContentRefOptions,
  run: (session: Session, target: ContentTarget) => Promise<T>,
): Promise<T> {
  const { session, target } = await openContent(ctx, input, options);
  return (await probeBase(target, (probed) => run(session, probed))).value;
}

/** The `atl page versions` argv that lists the versions of this content. */
function versionsArgv(input: string, base: ContentBase): string[] {
  return [
    "atl",
    "page",
    "versions",
    input,
    ...(base === "blogposts" ? ["--type", "blogpost"] : []),
  ];
}

/** A 404 while reading an explicit version: keep the error, add a pointer to the version list. */
function missingVersion(
  error: unknown,
  version: number | undefined,
  list: readonly string[],
): unknown {
  if (version === undefined || !(error instanceof AtlError) || error.status !== 404) {
    return error;
  }
  return new AtlError(error.message, {
    code: error.code,
    category: error.category,
    status: error.status,
    hint: `Version ${version} may not exist; list the existing versions first`,
    next: [list],
  });
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
  nbsp: " ",
};
const SNIPPET_MAX = 160;

/** Decode the HTML entities search results carry: the named ones above and numeric `&#39;` / `&#x27;`. */
function decodeEntities(text: string): string {
  return text.replaceAll(
    /&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g,
    (match, name?: string, dec?: string, hex?: string) => {
      if (name !== undefined) {
        return ENTITIES[name] ?? match;
      }
      const code = dec === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(dec, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

/**
 * Search excerpt as one line: highlight markers stripped, HTML entities and literal
 * `\uXXXX` escapes decoded, whitespace collapsed, capped at 160 chars with an ellipsis.
 */
export function snippet(text: string | undefined): string | undefined {
  const flat = decodeEntities(
    (text ?? "")
      .replaceAll(HIGHLIGHT, "")
      .replaceAll(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      ),
  )
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

export function commentPath(kind: CommentKind): string {
  return kind === "inline" ? "/api/v2/inline-comments" : "/api/v2/footer-comments";
}

/** The `atl comment get` argv that re-reads a comment of this kind. */
export function commentGetArgv(id: string, kind: CommentKind): string[] {
  return ["atl", "comment", "get", id, ...(kind === "inline" ? ["--kind", "inline"] : [])];
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
    pageId: comment.pageId,
    blogPostId: comment.blogPostId,
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

/**
 * Version list item: author as display name, minorEdit only when true. The title is dropped when it
 * equals the `previous` row's (the row above), so a page's repeated title shows only where it changes.
 */
function listVersion(
  version: Version,
  names: ReadonlyMap<string, string>,
  previous?: Version,
): Record<string, unknown> {
  return {
    number: version.number,
    title: previous?.page?.title === version.page?.title ? undefined : version.page?.title,
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
    Type.Union(
      [Type.Literal("md"), Type.Literal("adf"), Type.Literal("storage"), Type.Literal("view")],
      {
        description:
          "Body format: markdown (default), raw ADF, storage XHTML, or view (the rendered HTML with macros resolved)",
        default: "md",
      },
    ),
  ),
  version: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Read this historical version instead of the current",
    }),
  ),
  type: TYPE_FLAG,
  space: PAGE_SPACE_FLAG,
  grep: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Return only the body lines matching this regex (case-insensitive) as {lines, matches:[{from, to?, hits?, text}]} instead of the body; line numbers are 1-based in the rendered body (markdown by default; the same lines --output writes)",
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 50,
      description: "With --grep: lines of context around each match; overlapping ranges merge",
    }),
  ),
});

/**
 * Compact `parent` of a page: id and title from one extra GET. A parent that is not a page
 * (folder, whiteboard, ...) needs scopes the token may lack, so it carries its type instead of a
 * title; a page parent the caller cannot read (403/404) keeps its id only.
 */
async function parentRef(
  session: Session,
  page: ApiPage,
): Promise<{ id: string; title?: string | undefined; type?: string } | undefined> {
  const id = page.parentId;
  if (typeof id !== "string" || id === "") {
    return undefined;
  }
  if (page.parentType !== undefined && page.parentType !== "page") {
    return { id, type: page.parentType };
  }
  try {
    const parent = await session.http.request<ApiPage>({
      method: "GET",
      url: session.confluenceUrl(`/api/v2/pages/${encodeURIComponent(id)}`),
    });
    return { id, title: parent.title };
  } catch (error) {
    if (error instanceof AtlError && (error.status === 403 || error.status === 404)) {
      return { id };
    }
    throw error;
  }
}

const BODY_FORMATS = {
  md: "atlas_doc_format",
  adf: "atlas_doc_format",
  storage: "storage",
  view: "view",
} as const;

export const pageGet = defineCommand({
  name: "page.get",
  mcpTools: [
    "getConfluencePage",
    "getConfluenceContent",
    "getConfluenceContentVersion",
    "resolveConfluenceContentMacros",
  ],
  summary:
    "Get a page or blog post (current or --version N) with its body, parent {id, title} and url; --grep <regex> returns only matching lines; --format view returns the whole rendered HTML, not per-macro",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: PageGetFlags,
  sideEffects: "none",
  examples: [
    "atl page get 123456",
    'atl page get "Release Process" --space ENG',
    "atl page get https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Title --format storage",
    "atl page get 123456 --version 3",
    "atl page get 123456 --format view",
    'atl page get 123456 --grep "cold storage" --context 1',
  ],
  async run(ctx, input) {
    const { flags } = input;
    if (flags.context !== undefined && flags.grep === undefined) {
      throw inputError("invalid_flag_combination", "--context needs --grep", "Add --grep <regex>");
    }
    if (flags.grep !== undefined && (ctx.full || flags.format === "adf")) {
      throw inputError(
        "invalid_flag_combination",
        `--grep searches text lines and cannot be combined with ${ctx.full ? "--full" : "--format adf"}`,
        "Use the default markdown, --format storage, or --format view",
      );
    }
    const matcher = flags.grep === undefined ? undefined : grepPattern(flags.grep);
    return await readContent(ctx, input.args.page ?? "", flags, async (session, target) => {
      const format = flags.format ?? "md";
      // A `pageVersion=` link names a version; an explicit --version wins.
      const version = flags.version ?? target.version;
      let page: ApiPage;
      try {
        page = await session.http.request<ApiPage>({
          method: "GET",
          url: session.confluenceUrl(`/api/v2/${target.base}/${encodeURIComponent(target.id)}`),
          query: { "body-format": BODY_FORMATS[format], version },
        });
      } catch (error) {
        throw missingVersion(
          error,
          version,
          versionsArgv(resolvedRef(input.args.page ?? "", target), target.base),
        );
      }
      if (ctx.full) {
        return page;
      }
      const adf = page.body?.atlas_doc_format?.value;
      // A historical version's link points at a throwaway content id, not at the page.
      const url = page.status === "historical" ? undefined : webUrl(session, page._links?.webui);
      if (matcher !== undefined) {
        const text =
          format === "storage"
            ? page.body?.storage?.value
            : format === "view"
              ? page.body?.view?.value
              : adf === undefined
                ? undefined
                : adfToMarkdown(parseAdfBody(adf));
        const rows = (text ?? "").split("\n");
        const ranges = grepRanges(rows, matcher, flags.context ?? 0, format === "md");
        // keepRaw: an empty `matches` is the answer "no hits", so compact output must not prune it.
        return keepRaw({
          id: page.id,
          title: page.title,
          parent: await parentRef(session, page),
          version: page.version?.number,
          url,
          lines: text === undefined ? 0 : rows.length,
          matches: ranges.slice(0, GREP_RANGE_CAP),
          moreMatches: ranges.length > GREP_RANGE_CAP ? ranges.length - GREP_RANGE_CAP : undefined,
        });
      }
      const html = page.body?.view?.value;
      const storage = page.body?.storage?.value;
      let body: string[] | AdfDoc | undefined;
      if (format === "storage") {
        body = storage === undefined ? undefined : bodyLines(storage);
      } else if (format === "view") {
        body = html === undefined ? undefined : bodyLines(html);
      } else if (adf !== undefined) {
        body = renderAdf(adf, format);
      }
      return {
        id: page.id,
        type: target.base === "blogposts" ? "blogpost" : "page",
        title: page.title,
        spaceId: page.spaceId,
        parent: await parentRef(session, page),
        status: page.status,
        version: page.version?.number,
        authorId: page.authorId,
        created: shortTs(page.createdAt),
        updated: shortTs(page.version?.createdAt),
        url,
        body,
      };
    });
  },
});

/** `page tree` asks for this many levels when `--depth` is absent (the API itself returns only 2). */
const TREE_DEFAULT_DEPTH = 5;
/** At most this many pages at the deepest level are checked for children. */
const TREE_PROBE_CAP = 50;
const TREE_PROBE_BATCH = 10;

/** Ids among `ids` that have at least one child page: one direct-children request each. */
async function pagesWithChildren(session: Session, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < ids.length; start += TREE_PROBE_BATCH) {
    const batch = ids.slice(start, start + TREE_PROBE_BATCH);
    const children = await Promise.all(
      batch.map((id) =>
        session.http.request<ConfluenceCursorPage<ApiTreeNode>>({
          method: "GET",
          url: session.confluenceUrl(`/api/v2/pages/${encodeURIComponent(id)}/direct-children`),
          query: { limit: 1 },
        }),
      ),
    );
    batch.forEach((id, index) => {
      if ((children[index]?.results.length ?? 0) > 0) {
        found.add(id);
      }
    });
  }
  return found;
}

const PageTreeFlags = Type.Object({
  depth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Levels below the page (1-5, default 5)",
    }),
  ),
  space: PAGE_SPACE_FLAG,
  ...PAGING_FLAGS,
});

export const pageTree = defineCommand({
  name: "page.tree",
  mcpTools: ["getConfluencePageDescendants", "getConfluenceContentDescendants"],
  summary: "List descendants of a page, depth-limited; items omit url (see page get)",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: PageTreeFlags,
  sideEffects: "none",
  examples: ["atl page tree 123456 --depth 2", "atl page tree 123456 --all"],
  async run(ctx, input) {
    const { session, target } = await openContent(ctx, input.args.page ?? "", {
      type: "page",
      space: input.flags.space,
    });
    pagesOnly(target.base, "page tree");
    // The API returns 2 levels when no depth is sent.
    const depth = input.flags.depth ?? TREE_DEFAULT_DEPTH;
    const paged = await listV2<ApiTreeNode>(
      session,
      `/api/v2/pages/${encodeURIComponent(target.id)}/descendants`,
      input.flags,
      { depth },
    );
    if (ctx.full) {
      return paged;
    }
    const edge = paged.items
      .filter((node) => node.depth === depth && (node.type ?? "page") === "page")
      .map((node) => node.id);
    const deeper = await pagesWithChildren(session, edge.slice(0, TREE_PROBE_CAP));
    if (edge.length > TREE_PROBE_CAP) {
      writeDiagnostic({
        type: "hint",
        code: "tree_depth_unchecked",
        hint: `${edge.length - TREE_PROBE_CAP} pages at depth ${depth} were not checked for children; run page tree on a page to go deeper`,
      });
    }
    return mapPaged(paged, false, (node) => ({
      ...listNode(node),
      parentId: node.parentId ?? undefined,
      depth: node.depth,
      hasChildren: deeper.has(node.id) ? true : undefined,
    }));
  },
});

const PagingOnly = Type.Object({ space: PAGE_SPACE_FLAG, ...PAGING_FLAGS });

export const pageChildren = defineCommand({
  name: "page.children",
  summary: "List the direct children of a page; url is <site>/wiki/spaces/<KEY>/pages/<id>",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: PagingOnly,
  sideEffects: "none",
  examples: ["atl page children 123456"],
  async run(ctx, input) {
    const { session, target } = await openContent(ctx, input.args.page ?? "", {
      type: "page",
      space: input.flags.space,
    });
    pagesOnly(target.base, "page children");
    const paged = await listV2<ApiTreeNode>(
      session,
      `/api/v2/pages/${encodeURIComponent(target.id)}/direct-children`,
      input.flags,
    );
    return mapPaged(paged, ctx.full, listNode);
  },
});

const ContentListFlags = Type.Object({ type: TYPE_FLAG, space: PAGE_SPACE_FLAG, ...PAGING_FLAGS });

export const pageVersions = defineCommand({
  name: "page.versions",
  mcpTools: ["listConfluenceContentVersions"],
  summary:
    "List versions of a page or blog post; author is a display name; title appears on the first row and where it changes from the row above",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: ContentListFlags,
  sideEffects: "none",
  examples: ["atl page versions 123456 --limit 5"],
  async run(ctx, input) {
    return await readContent(ctx, input.args.page ?? "", input.flags, async (session, target) => {
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
      return {
        ...paged,
        items: paged.items.map((version, index) =>
          listVersion(version, names, paged.items[index - 1]),
        ),
      };
    });
  },
});

export const pageLabels = defineCommand({
  name: "page.labels",
  summary: "List labels on a page or blog post",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: ContentListFlags,
  sideEffects: "none",
  examples: ["atl page labels 123456"],
  async run(ctx, input) {
    return await readContent(ctx, input.args.page ?? "", input.flags, async (session, target) => {
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
    });
  },
});

// ---------------------------------------------------------------------------
// page.ancestors / diff / permissions / restriction / operations / properties
// ---------------------------------------------------------------------------

interface ApiAncestor {
  id?: string;
  type?: string;
  title?: string;
}

interface ApiAncestorSearch {
  results?: { content?: { type?: string; ancestors?: ApiAncestor[] } }[];
}

const AncestorsFlags = Type.Object({
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Keep only the nearest N ancestors" }),
  ),
  space: PAGE_SPACE_FLAG,
});

export const pageAncestors = defineCommand({
  name: "page.ancestors",
  mcpTools: ["getConfluenceContentAncestors"],
  summary:
    "List a page's ancestors, root first (CQL expand: the v2 ancestors endpoint needs a scope the token lacks)",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: AncestorsFlags,
  sideEffects: "none",
  examples: ["atl page ancestors 123456", "atl page ancestors 123456 --limit 1"],
  async run(ctx, input) {
    const { session, target } = await openContent(ctx, input.args.page ?? "", {
      type: "page",
      space: input.flags.space,
    });
    pagesOnly(target.base, "page ancestors");
    if (!/^\d+$/.test(target.id)) {
      throw new AtlError(`${target.id} is not a numeric page id`, {
        code: "invalid_content_ref",
        category: "input",
      });
    }
    const found = await session.http.request<ApiAncestorSearch>({
      method: "GET",
      url: session.confluenceUrl("/rest/api/search"),
      query: { cql: `id = ${target.id}`, expand: "content.ancestors", limit: 1 },
    });
    if (ctx.full) {
      return found;
    }
    const content = found.results?.[0]?.content;
    if (content === undefined) {
      throw new AtlError(`Page ${target.id} not found`, {
        code: "page_not_found",
        category: "api",
      });
    }
    if (content.type === "blogpost") {
      throw new AtlError(`${target.id} is a blog post; blog posts have no hierarchy`, {
        code: "unsupported_for_blogpost",
        category: "input",
      });
    }
    const ancestors = content.ancestors ?? [];
    const nearest =
      input.flags.limit === undefined ? ancestors : ancestors.slice(-input.flags.limit);
    return {
      items: nearest.map((ancestor) => ({
        id: ancestor.id,
        title: ancestor.title,
        type: ancestor.type === "page" ? undefined : ancestor.type,
      })),
    };
  },
});

// Unified diff, computed locally: the Confluence API has no diff endpoint.

interface DiffOp {
  kind: " " | "-" | "+";
  text: string;
}

/** Edit budget for the exact (Myers) search; the trace keeps one snapshot per edit step. */
const MAX_EDIT = 2000;

function myersOps(a: readonly string[], b: readonly string[]): DiffOp[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  a: readonly string[],
  b: readonly string[],
  offset: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (const [index, snapshot] of trace.toReversed().entries()) {
    const d = trace.length - 1 - index;
    const k = x - y;
    const down =
      k === -d || (k !== d && (snapshot[offset + k - 1] ?? 0) < (snapshot[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = snapshot[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: " ", text: a[x] ?? "" });
    }
    if (d > 0) {
      if (down) {
        y--;
        ops.push({ kind: "+", text: b[y] ?? "" });
      } else {
        x--;
        ops.push({ kind: "-", text: a[x] ?? "" });
      }
    }
  }
  return ops.toReversed();
}

/**
 * Line edit script from `a` to `b`: common head and tail are trimmed, then Myers on the middle.
 * A middle needing more than `MAX_EDIT` edits (a near-total rewrite) is reported as one block
 * of deletions followed by one block of insertions, which is a valid, if not minimal, script.
 */
function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  const edits = midA.length === 0 || midB.length === 0 ? undefined : myersOps(midA, midB);
  return [
    ...a.slice(0, head).map((text): DiffOp => ({ kind: " ", text })),
    ...(edits ?? [
      ...midA.map((text): DiffOp => ({ kind: "-", text })),
      ...midB.map((text): DiffOp => ({ kind: "+", text })),
    ]),
    ...a.slice(tailA).map((text): DiffOp => ({ kind: " ", text })),
  ];
}

/** Unified-diff range: a zero-length side names the line before the hunk. */
function hunkRange(before: number, length: number): string {
  return length === 0 ? `${before},0` : `${before + 1},${length}`;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** Unified-diff rows (`@@` headers, `+`/`-`/space lines) with `context` unchanged lines around each change. */
function unifiedRows(ops: readonly DiffOp[], context: number): string[] {
  const changed: number[] = [];
  const aBefore: number[] = [];
  const bBefore: number[] = [];
  let aSeen = 0;
  let bSeen = 0;
  for (const [index, op] of ops.entries()) {
    aBefore.push(aSeen);
    bBefore.push(bSeen);
    if (op.kind !== "+") {
      aSeen++;
    }
    if (op.kind !== "-") {
      bSeen++;
    }
    if (op.kind !== " ") {
      changed.push(index);
    }
  }
  const rows: string[] = [];
  let first = 0;
  while (first < changed.length) {
    let last = first;
    while (
      (changed[last + 1] ?? Number.POSITIVE_INFINITY) - (changed[last] ?? 0) - 1 <=
      2 * context
    ) {
      last++;
    }
    const start = Math.max(0, (changed[first] ?? 0) - context);
    const end = Math.min(ops.length, (changed[last] ?? 0) + context + 1);
    const slice = ops.slice(start, end);
    const aLen = slice.filter((op) => op.kind !== "+").length;
    const bLen = slice.filter((op) => op.kind !== "-").length;
    rows.push(
      `@@ -${hunkRange(aBefore[start] ?? 0, aLen)} +${hunkRange(bBefore[start] ?? 0, bLen)} @@`,
      ...slice.map((op) => `${op.kind}${op.text}`),
    );
    first = last + 1;
  }
  return rows;
}

/** A diff row within the stdout line budget: a long row is soft-wrapped and every piece repeats its marker. */
function displayRow(row: string): string[] {
  if (Buffer.byteLength(JSON.stringify(row)) <= BODY_LINE_BYTES) {
    return [row];
  }
  const marker = row.charAt(0);
  return bodyLines(row.slice(1)).map((piece) => `${marker}${piece}`);
}

async function versionText(
  session: Session,
  target: { base: ContentBase; id: string },
  version: number | undefined,
  storage: boolean,
  listArgv: readonly string[],
): Promise<{ page: ApiPage; text: string }> {
  let page: ApiPage;
  try {
    page = await session.http.request<ApiPage>({
      method: "GET",
      url: session.confluenceUrl(`/api/v2/${target.base}/${encodeURIComponent(target.id)}`),
      query: { "body-format": storage ? "storage" : "atlas_doc_format", version },
    });
  } catch (error) {
    throw missingVersion(error, version, listArgv);
  }
  const adf = page.body?.atlas_doc_format?.value;
  const text = storage
    ? page.body?.storage?.value
    : adf === undefined
      ? undefined
      : adfToMarkdown(parseAdfBody(adf));
  return { page, text: text ?? "" };
}

const PageDiffFlags = Type.Object({
  from: Type.Optional(
    Type.Integer({ minimum: 1, description: "Older version (default: the one before --to)" }),
  ),
  to: Type.Optional(Type.Integer({ minimum: 1, description: "Newer version (default: current)" })),
  format: Type.Optional(
    Type.Union([Type.Literal("md"), Type.Literal("storage")], {
      description: "Diff the markdown (default) or the storage XHTML of each version",
      default: "md",
    }),
  ),
  context: Type.Optional(
    Type.Integer({ minimum: 0, description: "Unchanged lines around each change (default 3)" }),
  ),
  type: TYPE_FLAG,
  space: PAGE_SPACE_FLAG,
});

export const pageDiff = defineCommand({
  name: "page.diff",
  mcpTools: ["diffConfluenceContentVersions"],
  summary:
    "Unified diff of two versions of a page or blog post, computed locally; default: previous vs current",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: PageDiffFlags,
  sideEffects: "none",
  examples: [
    "atl page diff 123456",
    "atl page diff 123456 --from 2 --to 5",
    "atl page diff 123456 --format storage --context 0",
  ],
  async run(ctx, input) {
    const { flags } = input;
    return await readContent(ctx, input.args.page ?? "", flags, async (session, target) => {
      const storage = flags.format === "storage";
      const versions = versionsArgv(resolvedRef(input.args.page ?? "", target), target.base);
      const newer = await versionText(session, target, flags.to, storage, versions);
      const to = newer.page.version?.number ?? flags.to ?? 1;
      const from = flags.from ?? to - 1;
      if (from < 1) {
        throw new AtlError(`Version ${to} is the first version; there is nothing to diff against`, {
          code: "no_previous_version",
          category: "input",
          next: [versions],
        });
      }
      const older = await versionText(session, target, from, storage, versions);
      if (ctx.full) {
        return { from: older.page, to: newer.page };
      }
      const ops = diffOps(splitLines(older.text), splitLines(newer.text));
      const rows = unifiedRows(ops, flags.context ?? 3);
      return {
        id: newer.page.id,
        title: newer.page.title,
        renamed:
          older.page.title === newer.page.title
            ? undefined
            : { from: older.page.title, to: newer.page.title },
        from,
        to,
        added: ops.filter((op) => op.kind === "+").length,
        removed: ops.filter((op) => op.kind === "-").length,
        diff: withSource(rows.flatMap(displayRow), rows.join("\n")),
      };
    });
  },
});

interface ApiPermission {
  operation?: string;
  principal?: { principalType?: string; principalId?: string };
}

interface ApiOperation {
  operation?: string;
  targetType?: string;
}

/** Operation names; `create` and operations on another target type read `operation:targetType` (`create:page`, `create:folder`). */
function operationNames(operations: readonly ApiOperation[] | undefined, own: string): string[] {
  return (operations ?? []).map((entry) =>
    entry.targetType === own && entry.operation !== "create"
      ? (entry.operation ?? "")
      : `${entry.operation}:${entry.targetType}`,
  );
}

const PermissionsListFlags = Type.Object({
  operation: Type.Optional(
    Type.String({ description: "Only grants for this operation (read or update)" }),
  ),
  principalType: Type.Optional(
    Type.String({ description: "Only grants to this principal type (user or group)" }),
  ),
  principalId: Type.Optional(
    Type.String({ description: "Only grants to this account or group id" }),
  ),
  type: TYPE_FLAG,
  space: PAGE_SPACE_FLAG,
  ...PAGING_FLAGS,
});

export const pagePermissionsList = defineCommand({
  name: "page.permissions.list",
  mcpTools: ["getConfluenceContentPermissions"],
  summary:
    "List the explicit permission grants on a page or blog post; groups show their id (names need a scope the token lacks)",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: PermissionsListFlags,
  sideEffects: "none",
  examples: [
    "atl page permissions list 123456",
    "atl page permissions list 123456 --operation update",
  ],
  async run(ctx, input) {
    const { flags } = input;
    return await readContent(ctx, input.args.page ?? "", flags, async (session, target) => {
      const paged = await listV2<ApiPermission>(
        session,
        `/api/v2/${target.base}/${encodeURIComponent(target.id)}/permissions`,
        flags,
        {
          operation: flags.operation,
          "principal-type": flags.principalType,
          "principal-id": flags.principalId,
        },
      );
      if (ctx.full) {
        return paged;
      }
      const names = await displayNames(
        session,
        paged.items.map((grant) =>
          grant.principal?.principalType === "user" ? grant.principal.principalId : undefined,
        ),
      );
      return {
        ...paged,
        items: paged.items.map((grant) => {
          const kind = grant.principal?.principalType ?? "principal";
          const id = grant.principal?.principalId;
          return {
            operation: grant.operation,
            [kind]: kind === "user" && id !== undefined ? names.get(id) : id,
          };
        }),
      };
    });
  },
});

const TypeOnly = Type.Object({ type: TYPE_FLAG, space: PAGE_SPACE_FLAG });

export const pageRestriction = defineCommand({
  name: "page.restriction",
  mcpTools: ["getConfluenceContentRestrictionState"],
  summary: "Show the general access state of a page or blog post (OPEN or restricted)",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: TypeOnly,
  sideEffects: "none",
  examples: ["atl page restriction 123456"],
  async run(ctx, input) {
    return await readContent(ctx, input.args.page ?? "", input.flags, async (session, target) => {
      const state = await session.http.request<Record<string, unknown>>({
        method: "GET",
        url: session.confluenceUrl(
          `/api/v2/${target.base}/${encodeURIComponent(target.id)}/restriction-state`,
        ),
      });
      if (ctx.full) {
        return state;
      }
      const { _links: _omitted, ...rest } = state;
      return rest;
    });
  },
});

export const pageOperations = defineCommand({
  name: "page.operations",
  summary:
    "List what you may do on a page or blog post (read, update, delete, ...; create:<type> for children)",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: TypeOnly,
  sideEffects: "none",
  examples: ["atl page operations 123456"],
  async run(ctx, input) {
    return await readContent(ctx, input.args.page ?? "", input.flags, async (session, target) => {
      const found = await session.http.request<{ operations?: ApiOperation[] }>({
        method: "GET",
        url: session.confluenceUrl(
          `/api/v2/${target.base}/${encodeURIComponent(target.id)}/operations`,
        ),
      });
      if (ctx.full) {
        return found;
      }
      return {
        operations: operationNames(
          found.operations,
          target.base === "blogposts" ? "blogpost" : "page",
        ),
      };
    });
  },
});

interface ApiProperty {
  id?: string;
  key?: string;
  value?: unknown;
}

const PropertiesFlags = Type.Object({
  key: Type.Optional(Type.String({ description: "Only the property with this key" })),
  type: TYPE_FLAG,
  space: PAGE_SPACE_FLAG,
  ...PAGING_FLAGS,
});

export const pageProperties = defineCommand({
  name: "page.properties",
  summary:
    "List content properties (key and JSON value as stored) of a page or blog post; apps keep state here",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: PropertiesFlags,
  sideEffects: "none",
  examples: ["atl page properties 123456", "atl page properties 123456 --key editor"],
  async run(ctx, input) {
    const { flags } = input;
    return await readContent(ctx, input.args.page ?? "", flags, async (session, target) => {
      const paged = await listV2<ApiProperty>(
        session,
        `/api/v2/${target.base}/${encodeURIComponent(target.id)}/properties`,
        flags,
        { key: flags.key },
      );
      return mapPaged(paged, ctx.full, (property) => ({
        key: property.key,
        value: property.value,
      }));
    });
  },
});

// ---------------------------------------------------------------------------
// attachment.* (metadata only: the attachment endpoints and downloads are 401 for this token)
// ---------------------------------------------------------------------------

interface ApiAttachment {
  id: string;
  title?: string;
  version?: { number?: number; when?: string; by?: { displayName?: string; publicName?: string } };
  container?: { id?: string };
  metadata?: { mediaType?: string };
  extensions?: { mediaType?: string; fileSize?: number; comment?: string };
}

function compactAttachment(attachment: ApiAttachment): Record<string, unknown> {
  const { version, extensions } = attachment;
  return {
    id: attachment.id,
    title: attachment.title,
    mediaType: extensions?.mediaType ?? attachment.metadata?.mediaType,
    size: extensions?.fileSize,
    comment: extensions?.comment,
    version: version?.number === 1 ? undefined : version?.number,
    by: version?.by?.displayName ?? version?.by?.publicName,
    updated: shortTs(version?.when),
    pageId: attachment.container?.id,
  };
}

const ATTACHMENT_ORDER = {
  title: "title",
  "-title": "title desc",
  created: "created",
  "-created": "created desc",
  modified: "lastmodified",
  "-modified": "lastmodified desc",
} as const;

const AttachmentListFlags = Type.Object({
  filename: Type.Optional(Type.String({ description: "Exact file name" })),
  mediaType: Type.Optional(
    Type.String({
      description:
        "Keep attachments whose media type starts with this (image, image/png); applied per page of results",
    }),
  ),
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal("title"),
        Type.Literal("-title"),
        Type.Literal("created"),
        Type.Literal("-created"),
        Type.Literal("modified"),
        Type.Literal("-modified"),
      ],
      { description: "Sort order" },
    ),
  ),
  ...PAGING_FLAGS,
});

export const attachmentList = defineCommand({
  name: "attachment.list",
  mcpTools: ["listConfluenceAttachments"],
  summary:
    "List attachment metadata of a page or blog post via CQL (the attachment endpoints and downloads are 401 for this token)",
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: AttachmentListFlags,
  sideEffects: "none",
  examples: [
    "atl attachment list 123456",
    "atl attachment list 123456 --filename report.pdf",
    "atl attachment list 123456 --media-type image --sort -created",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const target = contentTarget(input.args.page ?? "", "page");
    if (!/^\d+$/.test(target.id)) {
      throw new AtlError(`${target.id} is not a numeric page id`, {
        code: "invalid_content_ref",
        category: "input",
      });
    }
    const session = await openConfluence(ctx, target.site);
    const clauses = [
      "type = attachment",
      `container = ${target.id}`,
      ...(flags.filename === undefined ? [] : [`title = ${queryLiteral(flags.filename)}`]),
    ];
    const order = flags.sort === undefined ? "" : ` order by ${ATTACHMENT_ORDER[flags.sort]}`;
    const cqlQuery = `${clauses.join(" AND ")}${order}`;
    const paged = await paginateConfluenceV1Search<ApiAttachment>(
      pagePolicy(flags, CQL),
      ({ cursor, pageSize }) =>
        session.http.request<ConfluenceSearchPage<ApiAttachment>>({
          method: "GET",
          url: session.confluenceUrl("/rest/api/content/search"),
          query: {
            cql: cqlQuery,
            expand: "extensions,version",
            limit: pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          },
        }),
    );
    const wanted = flags.mediaType?.toLowerCase();
    const items =
      wanted === undefined
        ? paged.items
        : paged.items.filter((attachment) =>
            (attachment.extensions?.mediaType ?? attachment.metadata?.mediaType ?? "")
              .toLowerCase()
              .startsWith(wanted),
          );
    return mapPaged({ ...paged, items }, ctx.full, (attachment) => {
      const { pageId: _pageId, ...item } = compactAttachment(attachment);
      return item;
    });
  },
});

export const attachmentGet = defineCommand({
  name: "attachment.get",
  mcpTools: ["getConfluenceAttachment"],
  summary:
    "Get one attachment's metadata by id via CQL (version history and downloads are 401 for this token)",
  args: [{ name: "attachment", description: "Attachment id (att123 or 123)", required: true }],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl attachment get att123456"],
  async run(ctx, input) {
    const match = /^(?:att)?(\d+)$/.exec((input.args.attachment ?? "").trim());
    if (match === null) {
      throw new AtlError(`${input.args.attachment ?? ""} is not an attachment id`, {
        code: "invalid_attachment_ref",
        category: "input",
        hint: "Pass att<digits> or digits; `atl attachment list <page>` shows ids",
      });
    }
    const session = await openConfluence(ctx);
    const found = await session.http.request<ConfluenceCursorPage<ApiAttachment>>({
      method: "GET",
      url: session.confluenceUrl("/rest/api/content/search"),
      query: {
        cql: `type = attachment AND id = att${match[1]}`,
        expand: "extensions,version,container",
        limit: 1,
      },
    });
    if (ctx.full) {
      return found;
    }
    const attachment = found.results[0];
    if (attachment === undefined) {
      throw new AtlError(`Attachment att${match[1]} not found`, {
        code: "attachment_not_found",
        category: "api",
      });
    }
    return compactAttachment(attachment);
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

export const spaceList = defineCommand({
  name: "space.list",
  summary: "List spaces; items omit url (<site>/wiki/spaces/<key>)",
  mcpTools: ["getConfluenceSpaces", "listConfluenceSpaces"],
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
      category: "api",
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
  mcpTools: ["getPagesInConfluenceSpace", "listConfluenceContent"],
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
        type: node.type ?? (collection === "blogposts" ? "blogpost" : "page"),
        parentId: node.parentId ?? undefined,
        ...(flags.body === true && adf !== undefined ? { body: renderAdf(adf, flags.format) } : {}),
      };
    });
  },
});

interface ApiSpaceDetail extends ApiSpace {
  spaceOwnerId?: string;
  createdAt?: string;
  description?: { plain?: { value?: string } };
  labels?: { results?: ApiLabel[] };
  operations?: { results?: ApiOperation[] };
  properties?: { results?: ApiProperty[] };
}

const SpaceGetFlags = Type.Object({
  labels: Type.Optional(Type.Boolean({ description: "Include the space's labels" })),
  operations: Type.Optional(Type.Boolean({ description: "Include what you may do in the space" })),
  properties: Type.Optional(Type.Boolean({ description: "Include space properties" })),
});

export const spaceGet = defineCommand({
  name: "space.get",
  mcpTools: ["getConfluenceSpace"],
  summary: "Get one space by key, id or URL: owner, homepage, description, optional labels",
  args: [{ name: "space", description: "Space key, id, or space URL", required: true }],
  flags: SpaceGetFlags,
  sideEffects: "none",
  examples: ["atl space get ENG", "atl space get ENG --labels --operations"],
  async run(ctx, input) {
    const { flags } = input;
    const raw = input.args.space ?? "";
    const session = await openConfluence(ctx, spaceSiteHint(raw));
    const spaceId = await resolveSpaceId(session, raw);
    const space = await session.http.request<ApiSpaceDetail>({
      method: "GET",
      url: session.confluenceUrl(`/api/v2/spaces/${encodeURIComponent(spaceId)}`),
      query: {
        "description-format": "plain",
        "include-labels": flags.labels,
        "include-operations": flags.operations,
        "include-properties": flags.properties,
      },
    });
    if (ctx.full) {
      return space;
    }
    const names = await displayNames(session, [space.spaceOwnerId]);
    return {
      ...compactSpace(space),
      owner: space.spaceOwnerId === undefined ? undefined : names.get(space.spaceOwnerId),
      created: shortTs(space.createdAt),
      description: bodyLines(space.description?.plain?.value ?? ""),
      labels: space.labels?.results?.map((label) =>
        label.prefix === "global" || label.prefix === undefined
          ? label.name
          : `${label.prefix}:${label.name}`,
      ),
      operations:
        space.operations === undefined
          ? undefined
          : operationNames(space.operations.results, "space"),
      properties: space.properties?.results?.map((property) => ({
        key: property.key,
        value: property.value,
      })),
      url: webUrl(session, space._links?.webui),
    };
  },
});

interface ApiUserWithSpace {
  personalSpace?: {
    id?: number | string;
    key?: string;
    name?: string;
    status?: string;
    _links?: Links;
  };
}

export const spacePersonal = defineCommand({
  name: "space.personal",
  mcpTools: ["getConfluencePersonalSpace"],
  summary: "Get a user's personal space (default: yours)",
  args: [{ name: "accountId", description: "Atlassian account id (default: you)" }],
  flags: Type.Object({}),
  sideEffects: "none",
  examples: ["atl space personal", "atl space personal 5b10ac8d82e05b22cc7d4ef5"],
  async run(ctx, input) {
    const session = await openConfluence(ctx);
    const accountId = input.args.accountId ?? (await currentAccountId(session));
    const user = await session.http.request<ApiUserWithSpace>({
      method: "GET",
      url: session.confluenceUrl("/rest/api/user"),
      query: { accountId, expand: "personalSpace" },
    });
    if (ctx.full) {
      return user;
    }
    const space = user.personalSpace;
    if (space === undefined) {
      throw new AtlError(`Account ${accountId} has no personal space`, {
        code: "space_not_found",
        category: "api",
      });
    }
    return {
      id: space.id === undefined ? undefined : String(space.id),
      key: space.key,
      name: space.name,
      status: space.status === "current" ? undefined : space.status,
      url: webUrl(session, space._links?.webui),
    };
  },
});

// ---------------------------------------------------------------------------
// comment.*
// ---------------------------------------------------------------------------

const CommentListFlags = Type.Object({
  kind: Type.Optional(
    Type.Union([...COMMENT_KIND_LITERALS, Type.Literal("all")], {
      description:
        "Comment kind (default footer); all returns footer then inline in one result, each item tagged kind",
      default: "footer",
    }),
  ),
  replies: Type.Optional(
    Type.Boolean({
      description:
        "Nest replies under each comment, to full depth (one extra request per comment, each bounded by --limit; stops after 10 levels or 200 requests)",
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
      { description: "Inline comment resolution filter (requires --kind inline)" },
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
  space: PAGE_SPACE_FLAG,
  ...PAGING_FLAGS,
});

/** Resume points of `--kind all`, one per kind; `null` marks a kind that has no more pages. */
function allKindsCursor(
  cursor: string | undefined,
): Record<CommentKind, string | null | undefined> {
  if (cursor === undefined) {
    return { footer: undefined, inline: undefined };
  }
  const state = decodeStateCursor(cursor);
  const footer = state?.footer;
  const inline = state?.inline;
  if (
    (footer !== null && typeof footer !== "string") ||
    (inline !== null && typeof inline !== "string")
  ) {
    throw inputError(
      "invalid_cursor",
      "--cursor is not a cursor returned by atl comment list --kind all",
      "Pass the nextCursor value from a previous --kind all result unchanged.",
    );
  }
  return { footer, inline };
}

/** `--replies` follows reply threads this many levels down and with at most this many requests. */
const MAX_REPLY_DEPTH = 10;
const MAX_REPLY_REQUESTS = 200;

interface ReplyThread {
  items: { comment: ApiComment; replies: ReplyThread }[];
  nextCursor: string | null;
}

interface ReplyBudget {
  requests: number;
  truncated: boolean;
}

function threadComments(thread: ReplyThread): ApiComment[] {
  return thread.items.flatMap((node) => [node.comment, ...threadComments(node.replies)]);
}

/** Replies to a comment, each with its own replies, down to `MAX_REPLY_DEPTH` or until `budget` runs out. */
async function loadReplies(
  session: Session,
  kind: CommentKind,
  commentId: string,
  options: { limit: number | undefined; sort: string | undefined },
  budget: ReplyBudget,
  depth: number,
): Promise<ReplyThread> {
  if (depth > MAX_REPLY_DEPTH || budget.requests <= 0) {
    budget.truncated = true;
    return { items: [], nextCursor: null };
  }
  budget.requests--;
  const paged = await listV2<ApiComment>(
    session,
    `${commentPath(kind)}/${encodeURIComponent(commentId)}/children`,
    { limit: options.limit },
    { ...ADF_BODY, sort: options.sort },
  );
  const items = await Promise.all(
    paged.items.map(async (comment) => ({
      comment,
      replies: await loadReplies(session, kind, comment.id, options, budget, depth + 1),
    })),
  );
  return { items, nextCursor: paged.nextCursor };
}

export const commentList = defineCommand({
  name: "comment.list",
  mcpTools: [
    "getConfluencePageFooterComments",
    "getConfluencePageInlineComments",
    "listConfluenceComments",
  ],
  summary:
    "List footer, inline or --kind all comments on a page or blog post; items omit pageId and url (see comment get). --kind all lists footer then inline, each item tagged kind; --limit applies to each kind and nextCursor resumes both",
  args: [{ name: "page", description: PAGE_ARG, required: true }],
  flags: CommentListFlags,
  sideEffects: "none",
  examples: [
    "atl comment list 123456",
    "atl comment list 123456 --kind inline --resolution open",
    "atl comment list 123456 --kind all --replies",
    "atl comment list 123456 --replies --limit 10",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const kind = flags.kind ?? "footer";
    if (flags.resolution !== undefined && kind !== "inline") {
      throw new AtlError("--resolution only applies to inline comments", {
        code: "invalid_flag_combination",
        category: "input",
        hint: "Add --kind inline or drop --resolution",
      });
    }
    const kinds: CommentKind[] = kind === "all" ? ["footer", "inline"] : [kind];
    const resume =
      kind === "all"
        ? allKindsCursor(flags.cursor)
        : { footer: flags.cursor, inline: flags.cursor };
    return await readContent(ctx, input.args.page ?? "", flags, async (session, target) => {
      const budget: ReplyBudget = { requests: MAX_REPLY_REQUESTS, truncated: false };
      const batches: {
        kind: CommentKind;
        paged: Paged<ApiComment>;
        replies: ReplyThread[] | undefined;
      }[] = [];
      for (const each of kinds) {
        const from = resume[each];
        const paged: Paged<ApiComment> =
          from === null
            ? { items: [], nextCursor: null }
            : await listV2<ApiComment>(
                session,
                `/api/v2/${target.base}/${encodeURIComponent(target.id)}/${each}-comments`,
                { ...flags, cursor: from },
                {
                  ...ADF_BODY,
                  ...(flags.status === undefined ? {} : { status: flags.status }),
                  sort: flags.sort,
                  ...(flags.resolution === undefined
                    ? {}
                    : { "resolution-status": flags.resolution }),
                },
              );
        const replies =
          flags.replies === true
            ? await Promise.all(
                paged.items.map((comment) =>
                  loadReplies(
                    session,
                    each,
                    comment.id,
                    { limit: flags.repliesPerComment ?? flags.limit, sort: flags.sort },
                    budget,
                    1,
                  ),
                ),
              )
            : undefined;
        batches.push({ kind: each, paged, replies });
      }
      if (budget.truncated) {
        writeDiagnostic({
          type: "hint",
          code: "replies_truncated",
          hint: `--replies stops after ${MAX_REPLY_DEPTH} levels or ${MAX_REPLY_REQUESTS} requests; read deeper threads with atl comment replies <id>`,
        });
      }
      const tagged = kind === "all";
      const nextCursor =
        !tagged || batches.every((batch) => batch.paged.nextCursor === null)
          ? (batches[0]?.paged.nextCursor ?? null)
          : encodeStateCursor(
              Object.fromEntries(batches.map((batch) => [batch.kind, batch.paged.nextCursor])),
            );
      const truncated = batches.some((batch) => batch.paged.truncated === true);
      const tail = { nextCursor, ...(truncated ? { truncated: true as const } : {}) };
      if (ctx.full) {
        const fullThread = (thread: ReplyThread): Record<string, unknown> => ({
          replies: thread.items.map((node) => ({
            ...node.comment,
            ...(node.replies.items.length === 0 && node.replies.nextCursor === null
              ? {}
              : fullThread(node.replies)),
          })),
          ...(thread.nextCursor === null ? {} : { repliesNextCursor: thread.nextCursor }),
        });
        return {
          items: batches.flatMap((batch) =>
            batch.paged.items.map((comment, index) => {
              const thread = batch.replies?.[index];
              return {
                ...(tagged ? { kind: batch.kind } : {}),
                ...comment,
                ...(thread === undefined ? {} : fullThread(thread)),
              };
            }),
          ),
          ...tail,
        };
      }
      const names = await displayNames(
        session,
        batches
          .flatMap((batch) => [
            ...batch.paged.items,
            ...(batch.replies ?? []).flatMap((thread) => threadComments(thread)),
          ])
          .map((comment) => comment.version?.authorId),
      );
      return {
        items: batches.flatMap((batch) => {
          const compactThread = (thread: ReplyThread): Record<string, unknown> => ({
            ...(thread.items.length === 0
              ? {}
              : {
                  replies: thread.items.map((node) => ({
                    ...listComment(node.comment, batch.kind, flags.format, names),
                    ...compactThread(node.replies),
                  })),
                }),
            repliesNextCursor: thread.nextCursor ?? undefined,
          });
          return batch.paged.items.map((comment, index) => {
            const thread = batch.replies?.[index];
            return {
              ...(tagged ? { kind: batch.kind } : {}),
              ...listComment(comment, batch.kind, flags.format, names),
              ...(thread === undefined ? {} : compactThread(thread)),
            };
          });
        }),
        ...tail,
      };
    });
  },
});

/** Comment id from a bare id or a page URL carrying `focusedCommentId`. */
export function commentTarget(input: string): {
  id: string;
  site: string | undefined;
  cloudId: string | undefined;
} {
  const text = input.trim();
  if (/^\d+$/.test(text)) {
    return { id: text, site: undefined, cloudId: undefined };
  }
  const ref = parseConfluenceRef(text);
  if (ref.commentId !== undefined) {
    return { id: ref.commentId, site: ref.site, cloudId: ref.cloudId };
  }
  if (ref.kind === "comment") {
    return { id: ref.id, site: ref.site, cloudId: ref.cloudId };
  }
  throw new AtlError(`No comment id in ${input}`, {
    code: "invalid_comment_ref",
    category: "input",
    hint: "Pass a comment id or a page URL with ?focusedCommentId=<id>",
    next: [["atl", "comment", "list", text]],
  });
}

/**
 * Run a comment read for `kind`. A comment id or link does not say footer or inline, so without a
 * kind a footer 404 is retried as inline; the footer error is the one reported when both miss.
 */
async function readComment<T>(
  kind: CommentKind | undefined,
  run: (kind: CommentKind) => Promise<T>,
): Promise<T> {
  if (kind !== undefined) {
    return await run(kind);
  }
  try {
    return await run("footer");
  } catch (error) {
    if (!(error instanceof AtlError) || error.status !== 404) {
      throw error;
    }
    try {
      return await run("inline");
    } catch (second) {
      throw second instanceof AtlError && second.status === 404 ? error : second;
    }
  }
}

const CommentGetFlags = Type.Object({
  kind: COMMENT_LOOKUP_KIND_FLAG,
  version: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Read this earlier version of the comment (numbers: comment versions)",
    }),
  ),
  format: ADF_FORMAT_FLAG,
});

export const commentGet = defineCommand({
  name: "comment.get",
  mcpTools: ["getConfluenceComment"],
  summary: "Get one footer or inline comment (current or --version N)",
  args: [
    { name: "comment", description: "Comment id or URL with focusedCommentId", required: true },
  ],
  flags: CommentGetFlags,
  sideEffects: "none",
  examples: [
    "atl comment get 789",
    "atl comment get 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123?focusedCommentId=789'",
    "atl comment get 790 --kind inline",
    "atl comment get 789 --version 1",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const target = commentTarget(input.args.comment ?? "");
    const session = await openConfluence(ctx, target.site, target.cloudId);
    return await readComment(flags.kind, async (kind) => {
      let comment: ApiComment;
      try {
        comment = await session.http.request<ApiComment>({
          method: "GET",
          url: session.confluenceUrl(`${commentPath(kind)}/${encodeURIComponent(target.id)}`),
          query: { ...ADF_BODY, version: flags.version },
        });
      } catch (error) {
        throw missingVersion(error, flags.version, [
          "atl",
          "comment",
          "versions",
          target.id,
          ...(kind === "inline" ? ["--kind", "inline"] : []),
        ]);
      }
      if (ctx.full) {
        return comment;
      }
      const names = await displayNames(session, [comment.version?.authorId]);
      return compactComment(session, comment, kind, flags.format, names);
    });
  },
});

const CommentRepliesFlags = Type.Object({
  kind: COMMENT_LOOKUP_KIND_FLAG,
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
  examples: ["atl comment replies 789", "atl comment replies 790 --kind inline"],
  async run(ctx, input) {
    const target = commentTarget(input.args.comment ?? "");
    const session = await openConfluence(ctx, target.site, target.cloudId);
    return await readComment(input.flags.kind, async (kind) => {
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
    });
  },
});

const CommentVersionsFlags = Type.Object({ kind: COMMENT_LOOKUP_KIND_FLAG, ...PAGING_FLAGS });

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
    const session = await openConfluence(ctx, target.site, target.cloudId);
    return await readComment(input.flags.kind, async (kind) => {
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
    });
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
  mcpTools: ["searchConfluenceUsingCql", "searchConfluence"],
  summary: "Search Confluence with CQL; page and blog post hits omit url (see page get)",
  args: [
    {
      name: "query",
      description: "CQL query (unquoted words are joined)",
      required: true,
      variadic: true,
    },
  ],
  flags: CqlFlags,
  sideEffects: "none",
  examples: [
    "atl cql 'space = ENG AND type = page AND title ~ \"runbook\"'",
    "atl cql 'label = \"release\"' --all",
  ],
  async run(ctx, input) {
    const session = await openConfluence(ctx);
    const query = input.rest.join(" ");
    let paged: Paged<ApiSearchResult>;
    try {
      paged = await paginateConfluenceV1Search<ApiSearchResult>(
        pagePolicy(input.flags, CQL),
        ({ cursor, pageSize }) =>
          session.http.request<ConfluenceSearchPage<ApiSearchResult>>({
            method: "GET",
            url: session.confluenceUrl("/rest/api/search"),
            query: {
              cql: query,
              cqlcontext: input.flags.cqlContext,
              expand: input.flags.expand,
              limit: pageSize,
              ...(cursor === undefined ? {} : { cursor }),
            },
          }),
      );
    } catch (error) {
      if (
        error instanceof AtlError &&
        error.status === 400 &&
        /Unrecognised clause/i.test(error.message)
      ) {
        throw new AtlError(error.message, {
          code: error.code,
          category: error.category,
          status: error.status,
          hint: 'CQL values with non-ASCII or special characters must be quoted: label = "pénzügy"',
          cause: error,
        });
      }
      if (error instanceof AtlError && error.status === 400 && /\btitle\s*=/i.test(query)) {
        throw new AtlError(error.message, {
          code: error.code,
          category: error.category,
          status: error.status,
          hint: "CQL `title =` is rejected when the title contains quotes; find the page by exact title with `atl space pages <SPACE> --title <title>`, or use `title ~`",
        });
      }
      if (
        error instanceof AtlError &&
        error.status === 500 &&
        error.message.includes("NullPointerException")
      ) {
        // A text term that is only quote characters (`text ~ "\""`) makes the search index throw
        // on every attempt: the query is at fault, so it is not a transient failure.
        throw new AtlError(error.message, {
          code: "invalid_cql",
          category: "input",
          status: error.status,
          hint: "The server cannot evaluate this CQL; a `~` term made only of quote characters is the usual cause. Search for words instead.",
          cause: error,
        });
      }
      throw error;
    }
    return mapPaged(paged, ctx.full, (result) => {
      const type = result.content?.type;
      return {
        id: result.content?.id,
        type: type === "page" ? undefined : type,
        title: searchHitTitle(result),
        spaceKey: searchHitSpaceKey(result),
        pageId: searchHitContainerId(result),
        ancestors: result.content?.ancestors?.map((ancestor) => ancestor.title),
        excerpt: snippet(result.excerpt),
        lastModified: shortTs(result.lastModified),
        url: type === "page" || type === "blogpost" ? undefined : webUrl(session, result.url),
      };
    });
  },
});

export const confluenceCommands: readonly CommandSpec[] = [
  pageGet,
  pageAncestors,
  pageDiff,
  pagePermissionsList,
  pageRestriction,
  pageOperations,
  pageProperties,
  attachmentList,
  attachmentGet,
  spaceGet,
  spacePersonal,
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
