import { Type } from "../core/schema.ts";
import { parseAdfBody, type AdfDoc, type AdfNode } from "../adf/index.ts";
import {
  adfHygiene,
  describeInventory,
  inventoryDelta,
  storageHygiene,
  storageInventory,
  type Inventory,
} from "../adf/storage-check.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, inputError, type NextCommand } from "../core/errors.ts";
import type { Session } from "../core/session.ts";
import {
  ADF_BODY,
  commentPath,
  commentTarget,
  commentUrl,
  contentTarget,
  commentGetArgv,
  COMMENT_KIND_FLAG,
  openConfluence,
  probeBase,
  resolveSpaceId,
  spaceSiteHint,
  TYPE_FLAG,
  displayNames,
  webUrl,
  type ApiComment,
  type ApiPage,
  type CommentKind,
  type ContentBase,
  type ContentTarget,
} from "./confluence.ts";
import { shortTs } from "./common.ts";
import { writeDiagnostic } from "../core/output.ts";
import {
  applyArgvFor,
  BODY_FLAGS,
  confluenceBody,
  isPlan,
  loadBody,
  planOrSend,
  requireBody,
  requireYes,
  YES_FLAG,
  type LoadedBody,
  type Plan,
  type PlannedRequest,
} from "./write.ts";

/**
 * Send (or plan) one write. A 409 from an update means the version moved since it was read: it is
 * surfaced as transient with a re-read `next`, never retried. A destructive write's plan `next`
 * carries `--yes`, since the plan itself was allowed without it. `notFoundHint` replaces the generic
 * 404 hint where a 404 does not mean a wrong id.
 */
async function sendWrite<T>(
  ctx: CommandContext,
  session: Session,
  request: PlannedRequest,
  options: { reread?: NextCommand; destructive?: boolean; notFoundHint?: string } = {},
): Promise<T | Plan> {
  const next = applyArgvFor(ctx, options.destructive === true);
  try {
    return await planOrSend<T>(ctx, session.http, request, [next]);
  } catch (error) {
    if (options.notFoundHint !== undefined && error instanceof AtlError && error.status === 404) {
      throw new AtlError(error.message, {
        code: error.code,
        category: error.category,
        status: 404,
        hint: options.notFoundHint,
        next: error.next,
        cause: error,
      });
    }
    if (options.reread !== undefined && error instanceof AtlError && error.status === 409) {
      throw new AtlError(error.message, {
        code: "version_conflict",
        category: "transient",
        status: 409,
        hint: "The content changed since it was read: re-read it and retry with the current version.",
        next: [options.reread],
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Confluence answers 404 (not 403) when the caller may not change restrictions, and the page
 * restriction endpoints are absent on some plans, so the id is rarely the problem.
 */
const RESTRICTION_NOT_FOUND_HINT =
  "Not found for this account: the id is usually fine. The caller needs permission to change restrictions on the content (see `atl page operations <id>`), the token needs the restriction scope, and the site plan must support page restrictions.";

function currentVersion(current: { version?: { number?: number } }, what: string): number {
  const number = current.version?.number;
  if (number === undefined) {
    throw new AtlError(`${what} came back without a version number`, {
      code: "unexpected_response",
      category: "api",
    });
  }
  return number;
}

/** A blog post has no hierarchy: `flag` (a parent or destination page) is only valid for pages. */
function requirePagesForParent(base: ContentBase, flag: string, value: string | undefined): void {
  if (base === "blogposts" && value !== undefined) {
    throw inputError(
      "unsupported_for_blogpost",
      `${flag} only applies to pages; blog posts have no hierarchy`,
    );
  }
}

/** The current ADF body, re-sent verbatim when an update does not replace it. */
function currentAdfBody(
  body: { atlas_doc_format?: { value?: string } } | undefined,
  what: string,
): { representation: string; value: string } {
  const value = body?.atlas_doc_format?.value;
  if (value === undefined) {
    throw new AtlError(`${what} has no readable body to re-send`, {
      code: "unexpected_response",
      category: "api",
      hint: "Pass --body or --file to supply the body explicitly.",
    });
  }
  return { representation: "atlas_doc_format", value };
}

function compactPage(session: Session, page: ApiPage, base: ContentBase): Record<string, unknown> {
  const blog = base === "blogposts";
  return {
    id: page.id,
    type: blog ? "blogpost" : undefined,
    title: page.title,
    spaceId: page.spaceId,
    parentId: page.parentId,
    status: page.status === "current" ? undefined : page.status,
    version: page.version?.number,
    url: webUrl(session, page._links?.webui),
    next: [["atl", "page", "get", page.id, ...(blog ? ["--type", "blogpost"] : [])]],
  };
}

/**
 * `parentId` is the comment a reply was addressed to: the create response names the thread's
 * top-level comment for a reply to a reply, while `comment get` reports the true parent.
 */
function compactWrittenComment(
  session: Session,
  comment: ApiComment,
  kind: CommentKind,
  parentId?: string,
): Record<string, unknown> {
  return {
    id: comment.id,
    type: `${kind}-comment`,
    pageId: comment.pageId ?? comment.blogPostId,
    parentCommentId: parentId ?? comment.parentCommentId,
    status: comment.status === "current" ? undefined : comment.status,
    version: comment.version?.number,
    resolutionStatus: kind === "inline" ? comment.resolutionStatus : undefined,
    url: commentUrl(session, comment),
    next: [commentGetArgv(comment.id, kind)],
  };
}

/** Ids of the inline-comment anchors (`annotation` marks) in an ADF tree. */
function annotationIds(nodes: readonly AdfNode[] | undefined, found: Set<string>): Set<string> {
  for (const node of nodes ?? []) {
    for (const mark of node.marks ?? []) {
      const id = mark.attrs?.id;
      if (mark.type === "annotation" && typeof id === "string") {
        found.add(id);
      }
    }
    annotationIds(node.content, found);
  }
  return found;
}

/**
 * Inline-comment anchors in the current body that a replacement body lacks. Markdown cannot carry
 * annotation marks, so a markdown rewrite loses every anchor; ADF and storage bodies keep the ones
 * they include (storage names them `ac:inline-comment-marker ac:ref`).
 */
function droppedAnchors(
  current: { atlas_doc_format?: { value?: string } } | undefined,
  replacement: LoadedBody,
): string[] {
  const value = current?.atlas_doc_format?.value;
  if (value === undefined) {
    return [];
  }
  const kept =
    replacement.kind === "adf"
      ? annotationIds(replacement.doc.content, new Set())
      : new Set(
          Array.from(
            replacement.value.matchAll(/<ac:inline-comment-marker\b[^>]*\bac:ref="([^"]+)"/g),
            (match) => match[1],
          ),
        );
  return [...annotationIds(parseAdfBody(value).content, new Set())].filter((id) => !kept.has(id));
}

const MACRO_NODES: Record<string, true> = {
  extension: true,
  bodiedExtension: true,
  inlineExtension: true,
};

/** Macro keys with their count in an ADF tree; `legacy-content` is a kept table or task list, not a macro. */
function macroCounts(
  nodes: readonly AdfNode[] | undefined,
  found: Map<string, number>,
): Map<string, number> {
  for (const node of nodes ?? []) {
    const key = node.attrs?.extensionKey;
    if (MACRO_NODES[node.type] === true && typeof key === "string" && key !== "legacy-content") {
      found.set(key, (found.get(key) ?? 0) + 1);
    }
    macroCounts(node.content, found);
  }
  return found;
}

/**
 * Macros in the current body that a replacement body lacks (one entry per missing occurrence). Markdown
 * cannot carry macros (its `<!-- macro:... -->` comments are dropped on read); ADF and storage bodies keep the
 * ones they include (storage names them `ac:structured-macro ac:name`).
 */
function droppedMacros(
  current: { atlas_doc_format?: { value?: string } } | undefined,
  replacement: LoadedBody,
): string[] {
  const value = current?.atlas_doc_format?.value;
  if (value === undefined) {
    return [];
  }
  const kept =
    replacement.kind === "adf"
      ? macroCounts(replacement.doc.content, new Map())
      : new Map<string, number>();
  if (replacement.kind === "storage") {
    for (const match of replacement.value.matchAll(
      /<ac:structured-macro\b[^>]*\bac:name="([^"]+)"/g,
    )) {
      const key = match[1] ?? "";
      kept.set(key, (kept.get(key) ?? 0) + 1);
    }
  }
  const missing: string[] = [];
  for (const [key, count] of macroCounts(parseAdfBody(value).content, new Map())) {
    for (let index = kept.get(key) ?? 0; index < count; index++) {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Refuse (or, under --plan, warn about) content that is rarely intended: script/style elements and
 * `data:`/`file:` URLs. Markdown bodies are skipped: raw HTML in markdown stays literal text.
 */
function enforceHygiene(
  ctx: CommandContext,
  body: LoadedBody | undefined,
  force: boolean | undefined,
  verb: "create" | "update",
): void {
  if (body === undefined || (body.kind === "adf" && body.markdown === true)) {
    return;
  }
  const findings = body.kind === "storage" ? storageHygiene(body.value) : adfHygiene(body.doc);
  if (findings.length === 0) {
    return;
  }
  const list = findings.join(", ");
  const message = `The new body contains ${list}`;
  if (force !== true && !ctx.plan) {
    throw inputError(
      "body_hygiene",
      message,
      `Remove ${list} from the body, or pass --force to save anyway.`,
    );
  }
  writeDiagnostic({
    type: "warning",
    code: "body_hygiene",
    message,
    ...(ctx.plan ? { hint: `Running this ${verb} needs --force` } : {}),
  });
}

const CONTAINER_TYPE_FLAG = Type.Optional(
  Type.Union([Type.Literal("page"), Type.Literal("blogpost")], {
    description: "Create or update a page (default) or a blog post",
  }),
);

const STATUS_FLAG = Type.Optional(
  Type.Union([Type.Literal("current"), Type.Literal("draft")], {
    description: "current (published) or draft (unpublished)",
  }),
);

// ---------------------------------------------------------------------------
// page.create
// ---------------------------------------------------------------------------

const PageCreateFlags = Type.Object({
  space: Type.String({ description: "Space key, id, or space URL" }),
  title: Type.String({ description: "Page or blog post title" }),
  ...BODY_FLAGS,
  parent: Type.Optional(
    Type.String({
      description:
        "Parent page, folder, or other container: id, URL, tiny link, or ARI (pages only)",
    }),
  ),
  status: STATUS_FLAG,
  private: Type.Optional(Type.Boolean({ description: "Restrict the new content to yourself" })),
  subtype: Type.Optional(Type.Literal("live", { description: "Create a live doc (pages only)" })),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Save anyway when the body fails the hygiene check (script, style, data:/file: URLs)",
    }),
  ),
  type: CONTAINER_TYPE_FLAG,
});

export const pageCreate = defineCommand({
  name: "page.create",
  summary: "Create a page or blog post from --body text or a --file (or stdin)",
  mcpTools: ["createConfluencePage", "createConfluenceContent"],
  args: [],
  flags: PageCreateFlags,
  sideEffects: "write",
  examples: [
    "atl page create --space ENG --title 'Runbook' --file runbook.md",
    "atl page create --space ENG --title 'Note' --body 'Short inline body'",
    "atl page create --space ENG --title 'Child' --parent 123456 --file - --plan",
    "atl page create --space ENG --title 'Release 1.2' --type blogpost --file notes.md",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const base: ContentBase = flags.type === "blogpost" ? "blogposts" : "pages";
    if (base === "blogposts" && (flags.parent !== undefined || flags.subtype !== undefined)) {
      throw inputError(
        "unsupported_for_blogpost",
        "--parent and --subtype only apply to pages; blog posts have no hierarchy",
      );
    }
    const parent = flags.parent === undefined ? undefined : contentTarget(flags.parent, "page");
    const body = await requireBody(flags, { allowStorage: true });
    enforceHygiene(ctx, body, flags.force, "create");
    const session = await openConfluence(ctx, parent?.site ?? spaceSiteHint(flags.space));
    const spaceId = await resolveSpaceId(session, flags.space);
    const created = await sendWrite<ApiPage>(ctx, session, {
      method: "POST",
      url: session.confluenceUrl(`/api/v2/${base}`),
      ...(flags.private === true ? { query: { private: true } } : {}),
      body: {
        spaceId,
        status: flags.status,
        title: flags.title,
        parentId: parent?.id,
        subtype: flags.subtype,
        body: confluenceBody(body),
      },
    });
    return isPlan(created) ? created : compactPage(session, created, base);
  },
});

// ---------------------------------------------------------------------------
// page.update
// ---------------------------------------------------------------------------

const PageUpdateFlags = Type.Object({
  ...BODY_FLAGS,
  title: Type.Optional(Type.String({ description: "New title" })),
  status: STATUS_FLAG,
  parent: Type.Optional(
    Type.String({
      description: "Move under this parent: page id, URL, tiny link, or ARI (pages only)",
    }),
  ),
  space: Type.Optional(
    Type.String({ description: "Space key, id, or URL; the API rejects moves to another space" }),
  ),
  message: Type.Optional(Type.String({ description: "Version message" })),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Save anyway when the body drops inline-comment anchors or macros, or fails the hygiene check (script, style, data:/file: URLs)",
    }),
  ),
  expectVersion: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Fail with version_conflict unless the page is still at this version (the one the edited body was read at)",
    }),
  ),
  type: CONTAINER_TYPE_FLAG,
});

export const pageUpdate = defineCommand({
  name: "page.update",
  summary: "Update a page or blog post: replace the body, rename, move, or publish",
  mcpTools: ["updateConfluencePage", "updateConfluenceContent"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageUpdateFlags,
  sideEffects: "write",
  examples: [
    "atl page update 123456 --file runbook.md --message 'Fix rollback steps'",
    "atl page update 123456 --body 'Moved to the new runbook' --message 'Redirect'",
    "atl page update 123456 --file edited.storage.html --expect-version 7",
    "atl page update 123456 --parent 777 --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const requested = contentTarget(input.args.page ?? "", flags.type);
    requirePagesForParent(requested.base, "--parent", flags.parent);
    if (
      flags.file === undefined &&
      flags.body === undefined &&
      flags.title === undefined &&
      flags.status === undefined &&
      flags.parent === undefined &&
      flags.space === undefined
    ) {
      throw inputError(
        "nothing_to_update",
        "Nothing to update",
        "Pass --body, --file, --title, --status, --parent or --space",
      );
    }
    const parent = flags.parent === undefined ? undefined : contentTarget(flags.parent, "page");
    const loaded = await loadBody(flags, { allowStorage: true });
    enforceHygiene(ctx, loaded, flags.force, "update");
    const session = await openConfluence(
      ctx,
      requested.site ??
        parent?.site ??
        (flags.space === undefined ? undefined : spaceSiteHint(flags.space)),
    );
    const spaceId =
      flags.space === undefined ? undefined : await resolveSpaceId(session, flags.space);
    const { target, value: current } = await probeBase(requested, (probed) =>
      session.http.request<ApiPage>({
        method: "GET",
        url: session.confluenceUrl(`/api/v2/${probed.base}/${encodeURIComponent(probed.id)}`),
        query: ADF_BODY,
      }),
    );
    requirePagesForParent(target.base, "--parent", flags.parent);
    const reread = [
      "atl",
      "page",
      "get",
      target.id,
      ...(target.base === "blogposts" ? ["--type", "blogpost"] : []),
    ];
    // Compared against the version the GET reports, drafts included: a draft save resets the
    // stored number to 1, so on drafts this only catches edits that changed that number.
    if (flags.expectVersion !== undefined) {
      const actual = currentVersion(current, `Page ${target.id}`);
      if (actual !== flags.expectVersion) {
        throw new AtlError(
          `Page ${target.id} is at version ${actual}, expected ${flags.expectVersion}: it changed since it was read`,
          {
            code: "version_conflict",
            category: "transient",
            hint: "Re-read the page, re-apply the edit to the current body, and retry with --expect-version set to the new version.",
            next: [[...reread, "--format", "storage"]],
          },
        );
      }
    }
    const url = session.confluenceUrl(`/api/v2/${target.base}/${encodeURIComponent(target.id)}`);
    const title = flags.title ?? current.title;
    if (title === undefined) {
      throw new AtlError(`Page ${target.id} came back without a title`, {
        code: "unexpected_response",
        category: "api",
      });
    }
    const dropped = loaded === undefined ? [] : droppedAnchors(current.body, loaded);
    if (dropped.length > 0) {
      const message = `The new body drops ${dropped.length} inline-comment anchor(s): ${dropped.join(", ")}; their comments stay but lose their text selection`;
      if (flags.force !== true && !ctx.plan) {
        throw inputError(
          "inline_comment_anchors_dropped",
          message,
          "Pass --force to save anyway, or edit the ADF (page get --format adf) so the annotation marks are kept; markdown cannot carry them.",
        );
      }
      writeDiagnostic({
        type: "warning",
        code: "inline_comment_anchors_dropped",
        message,
        ...(ctx.plan ? { hint: "Running this update needs --force" } : {}),
      });
    }
    const droppedMacroKeys = loaded === undefined ? [] : droppedMacros(current.body, loaded);
    if (droppedMacroKeys.length > 0) {
      const message = `The new body drops ${droppedMacroKeys.length} macro(s): ${droppedMacroKeys.join(", ")}; markdown cannot carry macros`;
      if (flags.force !== true && !ctx.plan) {
        throw inputError(
          "macros_dropped",
          message,
          "Pass --force to save anyway, or edit the ADF (page get --format adf) or storage (--format storage) so the macros are kept.",
        );
      }
      writeDiagnostic({
        type: "warning",
        code: "macros_dropped",
        message,
        ...(ctx.plan ? { hint: "Running this update needs --force" } : {}),
      });
    }
    let check:
      | { bytes: { current: number; new: number }; removed: Inventory; added: Inventory }
      | undefined;
    if (loaded?.kind === "storage") {
      const stored = await session.http.request<ApiPage>({
        method: "GET",
        url,
        query: { "body-format": "storage" },
      });
      const currentStorage = stored.body?.storage?.value ?? "";
      const { removed, added } = inventoryDelta(
        storageInventory(currentStorage),
        storageInventory(loaded.value),
      );
      if (Object.keys(removed).length > 0) {
        writeDiagnostic({
          type: "warning",
          code: "content_removed",
          message: `The new body removes ${describeInventory(removed)}`,
        });
      }
      check = {
        bytes: { current: Buffer.byteLength(currentStorage), new: Buffer.byteLength(loaded.value) },
        removed,
        added,
      };
    }
    // Omitted --status keeps the current one. v2 wants version 1 when saving a draft and when
    // publishing a never-published draft (its first current version); otherwise current + 1.
    const status = flags.status ?? (current.status === "draft" ? "draft" : "current");
    const number =
      status === "draft" || current.status === "draft"
        ? 1
        : currentVersion(current, `Page ${target.id}`) + 1;
    const updated = await sendWrite<ApiPage>(
      ctx,
      session,
      {
        method: "PUT",
        url,
        body: {
          id: target.id,
          status,
          title,
          spaceId,
          parentId: parent?.id,
          body:
            loaded === undefined
              ? currentAdfBody(current.body, `Page ${target.id}`)
              : confluenceBody(loaded),
          version: {
            number,
            ...(flags.message === undefined ? {} : { message: flags.message }),
          },
        },
      },
      { reread },
    );
    if (isPlan(updated)) {
      return {
        ...updated,
        ...(dropped.length > 0 ? { droppedInlineComments: dropped } : {}),
        ...(droppedMacroKeys.length > 0 ? { droppedMacros: droppedMacroKeys } : {}),
        ...(check === undefined ? {} : { check }),
      };
    }
    return {
      ...compactPage(session, updated, target.base),
      droppedInlineComments: dropped.length > 0 ? dropped : undefined,
      droppedMacros: droppedMacroKeys.length > 0 ? droppedMacroKeys : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// comment.add
// ---------------------------------------------------------------------------

const INLINE_NODES: Record<string, true> = {
  text: true,
  hardBreak: true,
  mention: true,
  emoji: true,
  status: true,
  date: true,
  inlineCard: true,
  mediaInline: true,
};

/** Page text as the inline-comment anchor matcher sees it: one line per block, inline nodes joined. */
export function adfPlainText(doc: AdfDoc): string {
  let text = "";
  const walk = (node: AdfNode): void => {
    if (node.type === "text") {
      text += node.text ?? "";
    } else if (node.type === "hardBreak") {
      text += "\n";
    } else if (INLINE_NODES[node.type] === true) {
      const label = node.attrs?.text;
      if (typeof label === "string") {
        text += label;
      }
    } else {
      for (const child of node.content ?? []) {
        walk(child);
      }
      text += "\n";
    }
  };
  for (const node of doc.content) {
    walk(node);
  }
  return text;
}

/** Non-overlapping occurrences of `selection` in `text`, validated against the 1-based `match`. */
export function locateSelection(
  text: string,
  selection: string,
  match: number,
): { count: number; index: number } {
  if (selection === "") {
    throw inputError(
      "empty_selection",
      "--select is empty",
      "Pass the exact page text to anchor the comment to",
    );
  }
  let count = 0;
  for (
    let from = text.indexOf(selection);
    from !== -1;
    from = text.indexOf(selection, from + selection.length)
  ) {
    count += 1;
  }
  if (count === 0) {
    throw inputError(
      "selection_not_found",
      `The page text does not contain ${JSON.stringify(selection)}`,
      "--select must match the page text exactly, within one paragraph or block",
    );
  }
  if (match > count) {
    throw inputError(
      "match_out_of_range",
      `--match ${match} is out of range: ${JSON.stringify(selection)} appears ${count} time${count === 1 ? "" : "s"}`,
      `Use --match 1 to ${count}`,
    );
  }
  return { count, index: match - 1 };
}

const COMMENT_ADD_KIND_FLAG = Type.Optional(
  Type.Union([Type.Literal("footer"), Type.Literal("inline")], {
    description: "Comment kind (default footer); a reply takes its parent's kind",
  }),
);

/**
 * The kind a reply must have: its parent's. Posting to the other endpoint creates a comment that
 * no list shows under the thread, so the parent is looked up (the requested kind first, then the
 * other) and a --kind that contradicts it is an input error.
 */
async function replyKind(
  session: Session,
  parentId: string,
  requested: CommentKind | undefined,
): Promise<CommentKind> {
  const order: CommentKind[] = requested === "inline" ? ["inline", "footer"] : ["footer", "inline"];
  for (const candidate of order) {
    try {
      await session.http.request<ApiComment>({
        method: "GET",
        url: session.confluenceUrl(`${commentPath(candidate)}/${encodeURIComponent(parentId)}`),
      });
    } catch (error) {
      if (error instanceof AtlError && error.status === 404) {
        continue;
      }
      throw error;
    }
    if (requested !== undefined && candidate !== requested) {
      throw inputError(
        "comment_kind_mismatch",
        `Comment ${parentId} is of kind ${candidate}, not ${requested}`,
        `Drop --kind (a reply takes its parent's kind) or pass --kind ${candidate}`,
      );
    }
    return candidate;
  }
  throw new AtlError(`Comment ${parentId} was not found as a footer or inline comment`, {
    code: "comment_not_found",
    category: "api",
    hint: "Check the comment id, or that --site points at the right site.",
  });
}

const CommentAddFlags = Type.Object({
  ...BODY_FLAGS,
  replyTo: Type.Optional(
    Type.String({ description: "Comment id (or URL with focusedCommentId) to reply to" }),
  ),
  kind: COMMENT_ADD_KIND_FLAG,
  select: Type.Optional(
    Type.String({ description: "Exact page text to anchor a top-level inline comment to" }),
  ),
  match: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Which occurrence of --select to anchor to, 1-based (default 1)",
    }),
  ),
  targetType: Type.Optional(
    Type.Union(
      [
        Type.Literal("page"),
        Type.Literal("blogpost"),
        Type.Literal("attachment"),
        Type.Literal("custom-content"),
      ],
      {
        description:
          "What <target> is (default page); attachment and custom-content are footer only",
      },
    ),
  ),
});

export const commentAdd = defineCommand({
  name: "comment.add",
  summary: "Add a footer or inline comment, or reply to a comment",
  mcpTools: [
    "createConfluenceFooterComment",
    "createConfluenceInlineComment",
    "createConfluenceComment",
  ],
  args: [
    {
      name: "target",
      description:
        "Page or blog post (id, URL, tiny link, ARI), or an attachment / custom content id with --target-type; omitted for replies",
    },
  ],
  flags: CommentAddFlags,
  sideEffects: "write",
  examples: [
    'atl comment add 123456 --body "Deployed to staging"',
    "atl comment add --reply-to 789 --file reply.md",
    "atl comment add 123456 --kind inline --select 'rollback window' --match 2 --file note.md --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const kind: CommentKind = flags.kind ?? "footer";
    const targetArg = input.args.target;
    const targetType = flags.targetType ?? "page";

    if (flags.replyTo !== undefined) {
      if (
        targetArg !== undefined ||
        flags.select !== undefined ||
        flags.match !== undefined ||
        flags.targetType !== undefined
      ) {
        throw inputError(
          "invalid_flag_combination",
          "A reply takes only --reply-to; <target>, --select, --match and --target-type do not apply",
          "Drop the target: the parent comment already pins the page",
        );
      }
    } else {
      if (targetArg === undefined || targetArg.trim() === "") {
        throw inputError(
          "missing_target",
          "Missing <target>: the page, blog post, attachment, or custom content to comment on",
          "Pass a target, or --reply-to <commentId> to reply",
        );
      }
      if (kind === "inline") {
        if (flags.select === undefined) {
          throw inputError(
            "missing_flag",
            "An inline comment needs --select <exact page text>",
            "Add --select, or drop --kind inline for a footer comment",
          );
        }
        if (targetType === "attachment" || targetType === "custom-content") {
          throw inputError(
            "invalid_flag_combination",
            `Inline comments attach to pages and blog posts, not ${targetType}`,
          );
        }
      } else if (flags.select !== undefined || flags.match !== undefined) {
        throw inputError(
          "invalid_flag_combination",
          "--select and --match only apply to inline comments",
          "Add --kind inline",
        );
      }
    }

    const body = await requireBody(flags, { allowStorage: true });
    const reply = flags.replyTo === undefined ? undefined : commentTarget(flags.replyTo);
    const page =
      targetArg !== undefined && (targetType === "page" || targetType === "blogpost")
        ? contentTarget(targetArg, targetType)
        : undefined;
    const session = await openConfluence(ctx, reply?.site ?? page?.site);

    let postKind = kind;
    let anchor: Record<string, unknown> = {};
    if (reply !== undefined) {
      postKind = await replyKind(session, reply.id, flags.kind);
      anchor = { parentCommentId: reply.id };
    } else if (page !== undefined) {
      anchor = { [page.base === "blogposts" ? "blogPostId" : "pageId"]: page.id };
      if (flags.select !== undefined) {
        const current = await session.http.request<ApiPage>({
          method: "GET",
          url: session.confluenceUrl(`/api/v2/${page.base}/${encodeURIComponent(page.id)}`),
          query: ADF_BODY,
        });
        const adf = current.body?.atlas_doc_format?.value;
        if (adf === undefined) {
          throw new AtlError(`${page.id} has no readable body to anchor to`, {
            code: "unexpected_response",
            category: "api",
          });
        }
        const found = locateSelection(
          adfPlainText(parseAdfBody(adf)),
          flags.select,
          flags.match ?? 1,
        );
        anchor = {
          ...anchor,
          inlineCommentProperties: {
            textSelection: flags.select,
            textSelectionMatchCount: found.count,
            textSelectionMatchIndex: found.index,
          },
        };
      }
    } else if (targetArg !== undefined) {
      anchor = {
        [targetType === "attachment" ? "attachmentId" : "customContentId"]: targetArg.trim(),
      };
    }

    const created = await sendWrite<ApiComment>(
      ctx,
      session,
      {
        method: "POST",
        url: session.confluenceUrl(commentPath(postKind)),
        body: { ...anchor, body: confluenceBody(body) },
      },
      page?.base === "pages" && flags.targetType === undefined
        ? { notFoundHint: `If ${page.id} is a blog post, pass --target-type blogpost.` }
        : {},
    );
    return isPlan(created) ? created : compactWrittenComment(session, created, postKind, reply?.id);
  },
});

// ---------------------------------------------------------------------------
// comment.update
// ---------------------------------------------------------------------------

const CommentUpdateFlags = Type.Object({
  ...BODY_FLAGS,
  kind: COMMENT_KIND_FLAG,
  resolve: Type.Optional(Type.Boolean({ description: "Resolve the inline comment" })),
  reopen: Type.Optional(Type.Boolean({ description: "Reopen a resolved inline comment" })),
});

export const commentUpdate = defineCommand({
  name: "comment.update",
  mcpTools: ["updateConfluenceComment", "updateConfluenceCommentResolution"],
  summary: "Edit a comment's body, or resolve or reopen an inline comment",
  args: [
    { name: "comment", description: "Comment id or URL with focusedCommentId", required: true },
  ],
  flags: CommentUpdateFlags,
  sideEffects: "write",
  examples: [
    'atl comment update 789 --body "Fixed the typo"',
    "atl comment update 789 --file fixed.md",
    "atl comment update 790 --kind inline --file fixed.md --plan",
    "atl comment update 790 --kind inline --resolve",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const kind: CommentKind = flags.kind ?? "footer";
    if (flags.resolve === true && flags.reopen === true) {
      throw inputError("invalid_flag_combination", "--resolve and --reopen are mutually exclusive");
    }
    const resolution = flags.resolve === true ? true : flags.reopen === true ? false : undefined;
    if (resolution !== undefined && kind !== "inline") {
      throw inputError(
        "invalid_flag_combination",
        "--resolve and --reopen only apply to inline comments",
        "Add --kind inline",
      );
    }
    if (flags.file === undefined && flags.body === undefined && resolution === undefined) {
      throw inputError(
        "nothing_to_update",
        "Nothing to update",
        "Pass --body, --file, --resolve or --reopen",
      );
    }
    const target = commentTarget(input.args.comment ?? "");
    const loaded = await loadBody(flags, { allowStorage: true });
    const session = await openConfluence(ctx, target.site);
    const url = session.confluenceUrl(`${commentPath(kind)}/${encodeURIComponent(target.id)}`);
    const current = await session.http.request<ApiComment>({
      method: "GET",
      url,
      query: ADF_BODY,
    });
    const updated = await sendWrite<ApiComment>(
      ctx,
      session,
      {
        method: "PUT",
        url,
        body: {
          version: { number: currentVersion(current, `Comment ${target.id}`) + 1 },
          body:
            loaded === undefined
              ? currentAdfBody(current.body, `Comment ${target.id}`)
              : confluenceBody(loaded),
          ...(resolution === undefined ? {} : { resolved: resolution }),
        },
      },
      {
        reread: commentGetArgv(target.id, kind),
      },
    );
    return isPlan(updated) ? updated : compactWrittenComment(session, updated, kind);
  },
});

// ---------------------------------------------------------------------------
// page.move
// ---------------------------------------------------------------------------

/** A page reference; blog posts have no hierarchy, so move/copy parents must be pages. */
function pageRef(
  input: string,
  what: string,
): { base: ContentBase; id: string; site: string | undefined } {
  const ref = contentTarget(input, "page");
  if (ref.base === "blogposts") {
    throw inputError(
      "unsupported_for_blogpost",
      `${what} must be a page; blog posts have no hierarchy`,
    );
  }
  return ref;
}

/**
 * Where a page ended up: its parent `{id, title}` and its 0-based `index` among the parent's
 * children (omitted past the first 250). A folder or space-root parent has no page title or child
 * listing to read.
 */
async function placement(session: Session, pageId: string): Promise<Record<string, unknown>> {
  const page = await session.http.request<ApiPage & { parentType?: string }>({
    method: "GET",
    url: session.confluenceUrl(`/api/v2/pages/${encodeURIComponent(pageId)}`),
  });
  if (page.parentId === undefined) {
    return {};
  }
  if (page.parentType !== undefined && page.parentType !== "page") {
    return { parent: { id: page.parentId, type: page.parentType } };
  }
  const parentUrl = session.confluenceUrl(`/api/v2/pages/${encodeURIComponent(page.parentId)}`);
  const [parent, siblings] = await Promise.all([
    session.http.request<ApiPage>({ method: "GET", url: parentUrl }),
    session.http.request<{ results?: { id: string }[] }>({
      method: "GET",
      url: `${parentUrl}/direct-children`,
      query: { limit: 250 },
    }),
  ]);
  const index = siblings.results?.findIndex((child) => child.id === pageId) ?? -1;
  return {
    parent: { id: page.parentId, title: parent.title },
    index: index < 0 ? undefined : index,
  };
}

const PageMoveFlags = Type.Object({
  to: Type.String({ description: "Target page: id, URL, tiny link, or ARI" }),
  position: Type.Optional(
    Type.Union([Type.Literal("append"), Type.Literal("before"), Type.Literal("after")], {
      description:
        "append: become the last child of the target (default); before/after: become its sibling",
    }),
  ),
});

export const pageMove = defineCommand({
  name: "page.move",
  summary: "Move a page under a target page, or before/after it as a sibling",
  mcpTools: ["moveConfluenceContent"],
  args: [{ name: "page", description: "Page to move: id, URL, tiny link, or ARI", required: true }],
  flags: PageMoveFlags,
  sideEffects: "write",
  examples: [
    "atl page move 123456 --to 777",
    "atl page move 123456 --to 777 --position after",
    "atl page move 123456 --to 777 --position before --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const source = pageRef(input.args.page ?? "", "The page to move");
    const target = pageRef(flags.to, "--to");
    const position = flags.position ?? "append";
    const session = await openConfluence(ctx, source.site ?? target.site);
    const moved = await sendWrite<unknown>(ctx, session, {
      method: "PUT",
      url: session.confluenceUrl(
        `/rest/api/content/${encodeURIComponent(source.id)}/move/${position}/${encodeURIComponent(target.id)}`,
      ),
    });
    if (isPlan(moved) || ctx.full) {
      return moved;
    }
    return {
      id: source.id,
      position,
      target: target.id,
      ...(await placement(session, source.id)),
      next: [["atl", "page", "get", source.id]],
    };
  },
});

// ---------------------------------------------------------------------------
// page.copy
// ---------------------------------------------------------------------------

const PageCopyFlags = Type.Object({
  title: Type.Optional(
    Type.String({ description: "Title of the copy (default: Copy of <original title>)" }),
  ),
  toParent: Type.Optional(
    Type.String({
      description:
        "Parent for the copy: page id, URL, tiny link, or ARI (default: the original's parent; pages only)",
    }),
  ),
  toSpace: Type.Optional(
    Type.String({
      description:
        "Destination space key, id, or URL (default: the --to-parent's space, else the original's)",
    }),
  ),
  type: TYPE_FLAG,
});

export const pageCopy = defineCommand({
  name: "page.copy",
  summary: "Copy a page or blog post body to a new page, optionally under another parent or space",
  mcpTools: ["copyConfluenceContent"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageCopyFlags,
  sideEffects: "write",
  examples: [
    "atl page copy 123456 --title 'Runbook (draft)'",
    "atl page copy 123456 --to-parent 777 --title 'Runbook v2'",
    "atl page copy 123456 --to-space OPS --title 'Runbook' --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const requested = contentTarget(input.args.page ?? "", flags.type);
    requirePagesForParent(requested.base, "--to-parent", flags.toParent);
    const parent =
      flags.toParent === undefined ? undefined : pageRef(flags.toParent, "--to-parent");
    const session = await openConfluence(
      ctx,
      requested.site ??
        parent?.site ??
        (flags.toSpace === undefined ? undefined : spaceSiteHint(flags.toSpace)),
    );
    const { target: source, value: original } = await probeBase(requested, (probed) =>
      session.http.request<ApiPage>({
        method: "GET",
        url: session.confluenceUrl(`/api/v2/${probed.base}/${encodeURIComponent(probed.id)}`),
        query: ADF_BODY,
      }),
    );
    requirePagesForParent(source.base, "--to-parent", flags.toParent);
    const title =
      flags.title ?? (original.title === undefined ? undefined : `Copy of ${original.title}`);
    const value = original.body?.atlas_doc_format?.value;
    if (title === undefined || value === undefined) {
      throw new AtlError(`${source.id} came back without a title or readable body to copy`, {
        code: "unexpected_response",
        category: "api",
        hint: "Pass --title; a page without a readable body cannot be copied.",
      });
    }
    // Without --to-space the copy lands in the parent's space; without either, beside the original.
    let spaceId: string | undefined;
    let parentId: string | undefined;
    if (flags.toSpace !== undefined) {
      spaceId = await resolveSpaceId(session, flags.toSpace);
      parentId = parent?.id;
    } else if (parent !== undefined) {
      const parentPage = await session.http.request<ApiPage>({
        method: "GET",
        url: session.confluenceUrl(`/api/v2/pages/${encodeURIComponent(parent.id)}`),
      });
      spaceId = parentPage.spaceId;
      parentId = parent.id;
    } else {
      spaceId = original.spaceId;
      parentId = source.base === "blogposts" ? undefined : original.parentId;
    }
    if (spaceId === undefined) {
      throw new AtlError("Could not determine the destination space", {
        code: "unexpected_response",
        category: "api",
        hint: "Pass --to-space.",
      });
    }
    const created = await sendWrite<ApiPage>(ctx, session, {
      method: "POST",
      url: session.confluenceUrl(`/api/v2/${source.base}`),
      body: {
        spaceId,
        status: "current",
        title,
        parentId,
        body: { representation: "atlas_doc_format", value },
      },
    });
    if (isPlan(created) || ctx.full) {
      return created;
    }
    return {
      ...compactPage(session, created, source.base),
      copiedFrom: source.id,
      ...(source.base === "blogposts" ? {} : await placement(session, created.id)),
    };
  },
});

// ---------------------------------------------------------------------------
// page.restore
// ---------------------------------------------------------------------------

const PageRestoreFlags = Type.Object({
  version: Type.Integer({
    minimum: 1,
    description: "Version number to restore (see page versions)",
  }),
  message: Type.Optional(Type.String({ description: "Version message for the new version" })),
  restoreTitle: Type.Optional(
    Type.Boolean({ description: "Also restore the title of that version (default: keep current)" }),
  ),
  type: TYPE_FLAG,
});

export const pageRestore = defineCommand({
  name: "page.restore",
  summary: "Restore an earlier version of a page or blog post as a new latest version",
  mcpTools: ["restoreConfluenceContentVersion"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageRestoreFlags,
  sideEffects: "write",
  examples: [
    "atl page restore 123456 --version 3",
    "atl page restore 123456 --version 3 --message 'Undo bad edit' --restore-title",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const requested = contentTarget(input.args.page ?? "", flags.type);
    const session = await openConfluence(ctx, requested.site);
    const { target, value: current } = await probeBase(requested, (probed) =>
      session.http.request<ApiPage>({
        method: "GET",
        url: session.confluenceUrl(`/api/v2/${probed.base}/${encodeURIComponent(probed.id)}`),
      }),
    );
    const url = session.confluenceUrl(`/api/v2/${target.base}/${encodeURIComponent(target.id)}`);
    const old = await session.http.request<ApiPage>({
      method: "GET",
      url,
      query: { ...ADF_BODY, version: flags.version },
    });
    const value = old.body?.atlas_doc_format?.value;
    const title = flags.restoreTitle === true ? old.title : current.title;
    if (value === undefined || title === undefined) {
      throw new AtlError(`Version ${flags.version} of ${target.id} has no readable body or title`, {
        code: "unexpected_response",
        category: "api",
      });
    }
    const restored = await sendWrite<ApiPage>(
      ctx,
      session,
      {
        method: "PUT",
        url,
        body: {
          id: target.id,
          status: "current",
          title,
          body: { representation: "atlas_doc_format", value },
          version: {
            number: currentVersion(current, `Page ${target.id}`) + 1,
            message: flags.message ?? `Restored version ${flags.version}`,
          },
        },
      },
      {
        reread: [
          "atl",
          "page",
          "get",
          target.id,
          ...(target.base === "blogposts" ? ["--type", "blogpost"] : []),
        ],
      },
    );
    if (isPlan(restored) || ctx.full) {
      return restored;
    }
    return { ...compactPage(session, restored, target.base), restoredFrom: flags.version };
  },
});

// ---------------------------------------------------------------------------
// page.permissions.add | set | remove, page.restrict
// ---------------------------------------------------------------------------

interface ApiPermission {
  operation?: string;
  principal?: { principalType?: string; principalId?: string };
}

interface ApiPermissionList {
  results?: ApiPermission[];
  _links?: { next?: string };
}

interface ApiRestrictionState {
  state?: string;
  createdAt?: string;
  createdBy?: string;
}

const SELF_LOCKOUT_FLAG = Type.Optional(
  Type.Boolean({ description: "Allow a change that removes your own edit access" }),
);

const GRANT_FLAGS = {
  viewUser: Type.Optional(
    Type.Array(Type.String(), { description: "Account id that may view; repeatable" }),
  ),
  editUser: Type.Optional(
    Type.Array(Type.String(), { description: "Account id that may view and edit; repeatable" }),
  ),
  viewGroup: Type.Optional(
    Type.Array(Type.String(), { description: "Group id that may view; repeatable" }),
  ),
  editGroup: Type.Optional(
    Type.Array(Type.String(), { description: "Group id that may view and edit; repeatable" }),
  ),
  allowSelfLockout: SELF_LOCKOUT_FLAG,
  type: TYPE_FLAG,
};

interface GrantFlags {
  viewUser?: readonly string[] | undefined;
  editUser?: readonly string[] | undefined;
  viewGroup?: readonly string[] | undefined;
  editGroup?: readonly string[] | undefined;
  allowSelfLockout?: boolean | undefined;
  type?: "page" | "blogpost" | undefined;
  yes?: boolean | undefined;
}

function principalsOf(
  principalType: string,
  ids: readonly string[] | undefined,
): { principalType: string; principalId: string }[] {
  return (ids ?? []).map((principalId) => ({ principalType, principalId }));
}

/** The v2 permissions body: grants grouped by operation (`read` = view, `update` = view and edit). */
function grantsBody(flags: GrantFlags): {
  permissions: {
    operation: string;
    principals: { principalType: string; principalId: string }[];
  }[];
} {
  const permissions = [
    {
      operation: "read",
      principals: [
        ...principalsOf("user", flags.viewUser),
        ...principalsOf("group", flags.viewGroup),
      ],
    },
    {
      operation: "update",
      principals: [
        ...principalsOf("user", flags.editUser),
        ...principalsOf("group", flags.editGroup),
      ],
    },
  ].filter((grant) => grant.principals.length > 0);
  if (permissions.length === 0) {
    throw inputError(
      "no_principals",
      "No principals given",
      "Pass --view-user, --edit-user, --view-group or --edit-group (repeatable).",
    );
  }
  return { permissions };
}

function lockoutQuery(allow: boolean | undefined): { query?: { "allow-self-lockout": true } } {
  return allow === true ? { query: { "allow-self-lockout": true } } : {};
}

/**
 * The collection for a write that reads nothing first. A reference that does not say page or blog
 * post costs one GET to find the collection that answers (see `probeBase`); an explicit one costs none.
 */
async function writeTarget(session: Session, requested: ContentTarget): Promise<ContentTarget> {
  if (!requested.probe) {
    return requested;
  }
  const { target } = await probeBase(requested, (probed) =>
    session.http.request({
      method: "GET",
      url: session.confluenceUrl(`/api/v2/${probed.base}/${encodeURIComponent(probed.id)}`),
    }),
  );
  return target;
}

function permissionsNext(target: { base: ContentBase; id: string }): readonly string[] {
  return [
    "atl",
    "page",
    "permissions",
    "list",
    target.id,
    ...(target.base === "blogposts" ? ["--type", "blogpost"] : []),
  ];
}

/** Grants as `{operation, type, id, name}`; user names come from one bulk lookup. */
async function compactPermissions(
  session: Session,
  target: { base: ContentBase; id: string },
  list: ApiPermissionList,
): Promise<Record<string, unknown>> {
  const results = list.results ?? [];
  const names = await displayNames(
    session,
    results.map((grant) =>
      grant.principal?.principalType === "user" ? grant.principal.principalId : undefined,
    ),
  );
  return {
    id: target.id,
    permissions: results.map((grant) => {
      const id = grant.principal?.principalId;
      const name = id === undefined ? undefined : names.get(id);
      return {
        operation: grant.operation,
        type: grant.principal?.principalType,
        id,
        name: name === id ? undefined : name,
      };
    }),
    more: list._links?.next === undefined ? undefined : true,
    next: [permissionsNext(target)],
  };
}

async function writeGrants(
  ctx: CommandContext,
  pageArg: string,
  flags: GrantFlags,
  method: "POST" | "PUT",
): Promise<unknown> {
  const requested = contentTarget(pageArg, flags.type);
  const body = grantsBody(flags);
  const replace = method === "PUT";
  if (replace) {
    requireYes(ctx, flags.yes, `Replacing all permissions on ${requested.id}`);
  }
  const session = await openConfluence(ctx, requested.site);
  const target = await writeTarget(session, requested);
  const written = await sendWrite<ApiPermissionList>(
    ctx,
    session,
    {
      method,
      url: session.confluenceUrl(
        `/api/v2/${target.base}/${encodeURIComponent(target.id)}/permissions`,
      ),
      ...lockoutQuery(flags.allowSelfLockout),
      body,
    },
    { destructive: replace, notFoundHint: RESTRICTION_NOT_FOUND_HINT },
  );
  return isPlan(written) || ctx.full ? written : compactPermissions(session, target, written);
}

export const pagePermissionsAdd = defineCommand({
  name: "page.permissions.add",
  summary:
    "Grant view or edit permission to users and groups, keeping other grants (a principal holds one level)",
  mcpTools: ["addConfluenceContentPermissions"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: Type.Object(GRANT_FLAGS),
  sideEffects: "write",
  examples: [
    "atl page permissions add 123456 --edit-user 5b10ac8d82e05b22cc7d4ef5",
    "atl page permissions add 123456 --view-user 5b10a... --view-group 9f2c... --plan",
  ],
  run: (ctx, input) => writeGrants(ctx, input.args.page ?? "", input.flags, "POST"),
});

export const pagePermissionsSet = defineCommand({
  name: "page.permissions.set",
  summary: "Replace ALL direct permissions on a page with the given grants (needs --yes)",
  mcpTools: ["replaceConfluenceContentPermissions"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: Type.Object({ ...GRANT_FLAGS, yes: YES_FLAG }),
  sideEffects: "write",
  examples: [
    "atl page permissions set 123456 --edit-user 5b10ac8d82e05b22cc7d4ef5 --plan",
    "atl page permissions set 123456 --edit-user 5b10a... --view-group 9f2c... --yes",
  ],
  run: (ctx, input) => writeGrants(ctx, input.args.page ?? "", input.flags, "PUT"),
});

const PermissionsRemoveFlags = Type.Object({
  user: Type.Optional(Type.String({ description: "Account id whose grant is removed" })),
  group: Type.Optional(Type.String({ description: "Group id whose grant is removed" })),
  operation: Type.Optional(
    Type.Union([Type.Literal("read"), Type.Literal("update")], {
      description: "Only remove the grant when it has this level (read = view, update = edit)",
    }),
  ),
  all: Type.Optional(Type.Boolean({ description: "Remove every direct permission on the page" })),
  allowSelfLockout: SELF_LOCKOUT_FLAG,
  yes: YES_FLAG,
  type: TYPE_FLAG,
});

export const pagePermissionsRemove = defineCommand({
  name: "page.permissions.remove",
  summary:
    "Remove one user's or group's direct permission, or all of them with --all (needs --yes)",
  mcpTools: ["removeConfluenceContentPermissions"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PermissionsRemoveFlags,
  sideEffects: "write",
  examples: [
    "atl page permissions remove 123456 --user 5b10ac8d82e05b22cc7d4ef5 --yes",
    "atl page permissions remove 123456 --group 9f2c... --operation update --plan",
    "atl page permissions remove 123456 --all --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const principal =
      flags.user !== undefined
        ? { "principal-type": "user", "principal-id": flags.user }
        : flags.group !== undefined
          ? { "principal-type": "group", "principal-id": flags.group }
          : undefined;
    if (flags.user !== undefined && flags.group !== undefined) {
      throw inputError("conflicting_flags", "Pass --user or --group, not both");
    }
    if ((principal === undefined) === (flags.all !== true)) {
      throw inputError(
        principal === undefined ? "nothing_to_remove" : "conflicting_flags",
        principal === undefined
          ? "Nothing to remove"
          : "--all cannot be combined with --user/--group",
        principal === undefined ? "Pass --user, --group, or --all." : undefined,
      );
    }
    if (flags.operation !== undefined && principal === undefined) {
      throw inputError("operation_needs_principal", "--operation needs --user or --group");
    }
    const requested = contentTarget(input.args.page ?? "", flags.type);
    requireYes(
      ctx,
      flags.yes,
      principal === undefined
        ? `Removing all permissions from ${requested.id}`
        : `Removing ${flags.user ?? flags.group ?? ""}'s permission from ${requested.id}`,
    );
    const session = await openConfluence(ctx, requested.site);
    const target = await writeTarget(session, requested);
    const removed = await sendWrite<unknown>(
      ctx,
      session,
      {
        method: "DELETE",
        url: session.confluenceUrl(
          `/api/v2/${target.base}/${encodeURIComponent(target.id)}/permissions`,
        ),
        query: {
          ...principal,
          ...(flags.operation === undefined ? {} : { operation: flags.operation }),
          ...(flags.allowSelfLockout === true ? { "allow-self-lockout": true } : {}),
        },
      },
      { destructive: true, notFoundHint: RESTRICTION_NOT_FOUND_HINT },
    );
    if (isPlan(removed)) {
      return removed;
    }
    return {
      id: target.id,
      removed:
        principal === undefined
          ? "all"
          : `${principal["principal-type"]}:${principal["principal-id"]}`,
      operation: flags.operation,
      next: [permissionsNext(target)],
    };
  },
});

const RESTRICTION_STATES = ["open", "edit-restricted", "view-restricted"] as const;

const PageRestrictFlags = Type.Object({
  state: Type.Union(
    RESTRICTION_STATES.map((state) => Type.Literal(state)),
    {
      description:
        "open: no direct restrictions; edit-restricted: only granted principals edit; view-restricted: only granted principals view and edit",
    },
  ),
  allowSelfLockout: SELF_LOCKOUT_FLAG,
  yes: YES_FLAG,
  type: TYPE_FLAG,
});

export const pageRestrict = defineCommand({
  name: "page.restrict",
  summary:
    "Set a page's direct restriction state: open, edit-restricted, or view-restricted (needs --yes)",
  mcpTools: ["setConfluenceContentRestrictionState"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageRestrictFlags,
  sideEffects: "write",
  examples: [
    "atl page restrict 123456 --state edit-restricted --plan",
    "atl page restrict 123456 --state open --yes",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const requested = contentTarget(input.args.page ?? "", flags.type);
    requireYes(ctx, flags.yes, `Setting ${requested.id} to ${flags.state}`);
    const session = await openConfluence(ctx, requested.site);
    const target = await writeTarget(session, requested);
    const set = await sendWrite<ApiRestrictionState>(
      ctx,
      session,
      {
        method: "PUT",
        url: session.confluenceUrl(
          `/api/v2/${target.base}/${encodeURIComponent(target.id)}/restriction-state`,
        ),
        ...lockoutQuery(flags.allowSelfLockout),
        body: { state: flags.state.toUpperCase().replaceAll("-", "_") },
      },
      { destructive: true, notFoundHint: RESTRICTION_NOT_FOUND_HINT },
    );
    if (isPlan(set) || ctx.full) {
      return set;
    }
    const by =
      set.createdBy === undefined
        ? undefined
        : (await displayNames(session, [set.createdBy])).get(set.createdBy);
    return {
      id: target.id,
      state: set.state?.toLowerCase().replaceAll("_", "-"),
      by,
      at: shortTs(set.createdAt),
    };
  },
});

// ---------------------------------------------------------------------------
// page.property.set | delete
// ---------------------------------------------------------------------------

interface ApiContentProperty {
  id: string;
  key?: string;
  value?: unknown;
  version?: { number?: number };
}

/** The property with this exact key on the content, if any. */
async function findProperty(
  session: Session,
  target: { base: ContentBase; id: string },
  key: string,
): Promise<ApiContentProperty | undefined> {
  const found = await session.http.request<{ results?: ApiContentProperty[] }>({
    method: "GET",
    url: session.confluenceUrl(
      `/api/v2/${target.base}/${encodeURIComponent(target.id)}/properties`,
    ),
    query: { key },
  });
  return found.results?.find((property) => property.key === key);
}

async function propertyValue(flags: {
  value?: string | undefined;
  valueFile?: string | undefined;
}): Promise<unknown> {
  const { value, valueFile } = flags;
  if ((value === undefined) === (valueFile === undefined)) {
    throw inputError(
      "value_required",
      "Pass exactly one of --value or --value-file",
      "The value is any JSON: --value '{\"tier\":3}', --value 42, --value '\"text\"'",
    );
  }
  const flag = valueFile === undefined ? "--value" : "--value-file";
  const text =
    valueFile === undefined
      ? (value ?? "")
      : await Bun.file(valueFile)
          .text()
          .catch((cause: unknown) => {
            throw new AtlError(`Cannot read --value-file ${valueFile}`, {
              code: "input_file_unreadable",
              category: "input",
              cause,
            });
          });
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AtlError(`${flag} is not valid JSON`, {
      code: "invalid_json",
      category: "input",
      hint: "Quote strings as JSON: --value '\"text\"'",
      cause,
    });
  }
}

const PagePropertySetFlags = Type.Object({
  value: Type.Optional(Type.String({ description: "The property value as JSON" })),
  valueFile: Type.Optional(Type.String({ description: "File holding the property value as JSON" })),
  type: TYPE_FLAG,
});

export const pagePropertySet = defineCommand({
  name: "page.property.set",
  summary:
    "Create a content property on a page or blog post, or replace its value (version bump); the value is JSON",
  args: [
    { name: "page", description: "Page id, URL, tiny link, or ARI", required: true },
    { name: "key", description: "Property key", required: true },
  ],
  flags: PagePropertySetFlags,
  sideEffects: "write",
  examples: [
    "atl page property set 123456 nm-owner --value '{\"tier\":3}'",
    "atl page property set 123456 editor --value-file editor.json --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const key = input.args.key ?? "";
    const requested = contentTarget(input.args.page ?? "", flags.type);
    const value = await propertyValue(flags);
    const session = await openConfluence(ctx, requested.site);
    const { target, value: existing } = await probeBase(requested, (probed) =>
      findProperty(session, probed, key),
    );
    const collection = session.confluenceUrl(
      `/api/v2/${target.base}/${encodeURIComponent(target.id)}/properties`,
    );
    const reread = [
      "atl",
      "page",
      "properties",
      target.id,
      "--key",
      key,
      ...(target.base === "blogposts" ? ["--type", "blogpost"] : []),
    ];
    const written = await sendWrite<ApiContentProperty>(
      ctx,
      session,
      existing === undefined
        ? { method: "POST", url: collection, body: { key, value } }
        : {
            method: "PUT",
            url: `${collection}/${encodeURIComponent(existing.id)}`,
            body: {
              key,
              value,
              version: { number: currentVersion(existing, `Property ${key}`) + 1 },
            },
          },
      { reread },
    );
    if (isPlan(written) || ctx.full) {
      return written;
    }
    return {
      id: written.id,
      key: written.key,
      value: written.value,
      version: written.version?.number,
      action: existing === undefined ? "created" : "updated",
      next: [reread],
    };
  },
});

export const pagePropertyDelete = defineCommand({
  name: "page.property.delete",
  summary: "Delete a content property of a page or blog post by key (needs --yes)",
  args: [
    { name: "page", description: "Page id, URL, tiny link, or ARI", required: true },
    { name: "key", description: "Property key", required: true },
  ],
  flags: Type.Object({ yes: YES_FLAG, type: TYPE_FLAG }),
  sideEffects: "write",
  examples: [
    "atl page property delete 123456 nm-owner --plan",
    "atl page property delete 123456 nm-owner --yes",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const key = input.args.key ?? "";
    const requested = contentTarget(input.args.page ?? "", flags.type);
    requireYes(ctx, flags.yes, `Deleting property ${key} of ${requested.id}`);
    const session = await openConfluence(ctx, requested.site);
    const { target, value: existing } = await probeBase(requested, (probed) =>
      findProperty(session, probed, key),
    );
    if (existing === undefined) {
      throw new AtlError(`Page ${target.id} has no property ${JSON.stringify(key)}`, {
        code: "property_not_found",
        category: "api",
        hint: "List the keys with `atl page properties <page>`.",
        next: [["atl", "page", "properties", target.id]],
      });
    }
    const removed = await sendWrite<unknown>(
      ctx,
      session,
      {
        method: "DELETE",
        url: session.confluenceUrl(
          `/api/v2/${target.base}/${encodeURIComponent(target.id)}/properties/${encodeURIComponent(existing.id)}`,
        ),
      },
      { destructive: true },
    );
    return isPlan(removed) ? removed : { id: target.id, deleted: key, propertyId: existing.id };
  },
});

export const confluenceWriteCommands: readonly CommandSpec[] = [
  pageCreate,
  pageUpdate,
  pageMove,
  pageCopy,
  pageRestore,
  pagePermissionsAdd,
  pagePermissionsSet,
  pagePermissionsRemove,
  pageRestrict,
  pagePropertySet,
  pagePropertyDelete,
  commentAdd,
  commentUpdate,
];
