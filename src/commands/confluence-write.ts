import { Type } from "../core/schema.ts";
import { parseAdfBody, type AdfDoc, type AdfNode } from "../adf/index.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError, type NextCommand } from "../core/errors.ts";
import { isRecord } from "../core/guards.ts";
import type { Session } from "../core/session.ts";
import {
  ADF_BODY,
  commentPath,
  commentTarget,
  commentUrl,
  contentTarget,
  INLINE_FLAG,
  openConfluence,
  resolveSpaceId,
  spaceSiteHint,
  webUrl,
  type ApiComment,
  type ApiPage,
  type CommentKind,
  type ContentBase,
} from "./confluence.ts";
import {
  applyArgv,
  BODY_FLAGS,
  confluenceBody,
  loadBody,
  planOrSend,
  requireBody,
  type Plan,
  type PlannedRequest,
} from "./write.ts";

function isPlan(value: unknown): value is Plan {
  return isRecord(value) && value.type === "plan";
}

function inputError(message: string, code: string, hint?: string): AtlError {
  return new AtlError(message, {
    code,
    category: "input",
    ...(hint === undefined ? {} : { hint }),
  });
}

/**
 * Send (or plan) one write. A 409 from an update means the version moved since it was read: it is
 * surfaced as transient with a re-read `next`, never retried.
 */
async function sendWrite<T>(
  ctx: CommandContext,
  session: Session,
  request: PlannedRequest,
  reread?: NextCommand,
): Promise<T | Plan> {
  try {
    return await planOrSend<T>(ctx, session.http, request, [applyArgv(ctx.argv)]);
  } catch (error) {
    if (reread !== undefined && error instanceof AtlError && error.status === 409) {
      throw new AtlError(error.message, {
        code: "version_conflict",
        category: "transient",
        status: 409,
        hint: "The content changed since it was read: re-read it and retry with the current version.",
        next: [reread],
        cause: error,
      });
    }
    throw error;
  }
}

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

function compactWrittenComment(
  session: Session,
  comment: ApiComment,
  kind: CommentKind,
): Record<string, unknown> {
  return {
    id: comment.id,
    type: `${kind}-comment`,
    pageId: comment.pageId ?? comment.blogPostId,
    parentCommentId: comment.parentCommentId,
    status: comment.status === "current" ? undefined : comment.status,
    version: comment.version?.number,
    resolutionStatus: kind === "inline" ? comment.resolutionStatus : undefined,
    url: commentUrl(session, comment),
    next: [["atl", "comment", "get", comment.id, ...(kind === "inline" ? ["--inline"] : [])]],
  };
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
  type: CONTAINER_TYPE_FLAG,
});

export const pageCreate = defineCommand({
  name: "page.create",
  summary: "Create a page or blog post from --body text or a --file (or stdin)",
  mcpTools: ["createConfluencePage"],
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
        "--parent and --subtype only apply to pages; blog posts have no hierarchy",
        "unsupported_for_blogpost",
      );
    }
    const parent = flags.parent === undefined ? undefined : contentTarget(flags.parent, "page");
    const body = await requireBody(flags, { allowStorage: true });
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
  type: CONTAINER_TYPE_FLAG,
});

export const pageUpdate = defineCommand({
  name: "page.update",
  summary: "Update a page or blog post: replace the body, rename, move, or publish",
  mcpTools: ["updateConfluencePage"],
  args: [{ name: "page", description: "Page id, URL, tiny link, or ARI", required: true }],
  flags: PageUpdateFlags,
  sideEffects: "write",
  examples: [
    "atl page update 123456 --file runbook.md --message 'Fix rollback steps'",
    "atl page update 123456 --body 'Moved to the new runbook' --message 'Redirect'",
    "atl page update 123456 --parent 777 --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const target = contentTarget(input.args.page ?? "", flags.type);
    if (target.base === "blogposts" && flags.parent !== undefined) {
      throw inputError(
        "--parent only applies to pages; blog posts have no hierarchy",
        "unsupported_for_blogpost",
      );
    }
    if (
      flags.file === undefined &&
      flags.body === undefined &&
      flags.title === undefined &&
      flags.status === undefined &&
      flags.parent === undefined &&
      flags.space === undefined
    ) {
      throw inputError(
        "Nothing to update",
        "nothing_to_update",
        "Pass --body, --file, --title, --status, --parent or --space",
      );
    }
    const parent = flags.parent === undefined ? undefined : contentTarget(flags.parent, "page");
    const loaded = await loadBody(flags, { allowStorage: true });
    const session = await openConfluence(
      ctx,
      target.site ??
        parent?.site ??
        (flags.space === undefined ? undefined : spaceSiteHint(flags.space)),
    );
    const spaceId =
      flags.space === undefined ? undefined : await resolveSpaceId(session, flags.space);
    const url = session.confluenceUrl(`/api/v2/${target.base}/${encodeURIComponent(target.id)}`);
    const current = await session.http.request<ApiPage>({
      method: "GET",
      url,
      ...(loaded === undefined ? { query: ADF_BODY } : {}),
    });
    const title = flags.title ?? current.title;
    if (title === undefined) {
      throw new AtlError(`Page ${target.id} came back without a title`, {
        code: "unexpected_response",
        category: "api",
      });
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
      [
        "atl",
        "page",
        "get",
        target.id,
        ...(target.base === "blogposts" ? ["--type", "blogpost"] : []),
      ],
    );
    return isPlan(updated) ? updated : compactPage(session, updated, target.base);
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
      `The page text does not contain ${JSON.stringify(selection)}`,
      "selection_not_found",
      "--select must match the page text exactly, within one paragraph or block",
    );
  }
  if (match > count) {
    throw inputError(
      `--match ${match} is out of range: ${JSON.stringify(selection)} appears ${count} time${count === 1 ? "" : "s"}`,
      "match_out_of_range",
      `Use --match 1 to ${count}`,
    );
  }
  return { count, index: match - 1 };
}

const CommentAddFlags = Type.Object({
  ...BODY_FLAGS,
  replyTo: Type.Optional(
    Type.String({ description: "Comment id (or URL with focusedCommentId) to reply to" }),
  ),
  inline: INLINE_FLAG,
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
  mcpTools: ["createConfluenceFooterComment", "createConfluenceInlineComment"],
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
    "atl comment add 123456 --inline --select 'rollback window' --match 2 --file note.md --plan",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const kind: CommentKind = flags.inline === true ? "inline" : "footer";
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
          "A reply takes only --reply-to; <target>, --select, --match and --target-type do not apply",
          "invalid_flag_combination",
          "Drop the target: the parent comment already pins the page",
        );
      }
    } else {
      if (targetArg === undefined || targetArg.trim() === "") {
        throw inputError(
          "Missing <target>: the page, blog post, attachment, or custom content to comment on",
          "missing_target",
          "Pass a target, or --reply-to <commentId> to reply",
        );
      }
      if (kind === "inline") {
        if (flags.select === undefined) {
          throw inputError(
            "An inline comment needs --select <exact page text>",
            "missing_flag",
            "Add --select, or drop --inline for a footer comment",
          );
        }
        if (targetType === "attachment" || targetType === "custom-content") {
          throw inputError(
            `Inline comments attach to pages and blog posts, not ${targetType}`,
            "invalid_flag_combination",
          );
        }
      } else if (flags.select !== undefined || flags.match !== undefined) {
        throw inputError(
          "--select and --match only apply to inline comments",
          "invalid_flag_combination",
          "Add --inline",
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

    let anchor: Record<string, unknown> = {};
    if (reply !== undefined) {
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

    const created = await sendWrite<ApiComment>(ctx, session, {
      method: "POST",
      url: session.confluenceUrl(commentPath(kind)),
      body: { ...anchor, body: confluenceBody(body) },
    });
    return isPlan(created) ? created : compactWrittenComment(session, created, kind);
  },
});

// ---------------------------------------------------------------------------
// comment.update
// ---------------------------------------------------------------------------

const CommentUpdateFlags = Type.Object({
  ...BODY_FLAGS,
  inline: INLINE_FLAG,
  resolve: Type.Optional(Type.Boolean({ description: "Resolve the inline comment" })),
  reopen: Type.Optional(Type.Boolean({ description: "Reopen a resolved inline comment" })),
});

export const commentUpdate = defineCommand({
  name: "comment.update",
  summary: "Edit a comment's body, or resolve or reopen an inline comment",
  args: [
    { name: "comment", description: "Comment id or URL with focusedCommentId", required: true },
  ],
  flags: CommentUpdateFlags,
  sideEffects: "write",
  examples: [
    'atl comment update 789 --body "Fixed the typo"',
    "atl comment update 789 --file fixed.md",
    "atl comment update 790 --inline --file fixed.md --plan",
    "atl comment update 790 --inline --resolve",
  ],
  async run(ctx, input) {
    const { flags } = input;
    const kind: CommentKind = flags.inline === true ? "inline" : "footer";
    if (flags.resolve === true && flags.reopen === true) {
      throw inputError("--resolve and --reopen are mutually exclusive", "invalid_flag_combination");
    }
    const resolution = flags.resolve === true ? true : flags.reopen === true ? false : undefined;
    if (resolution !== undefined && kind !== "inline") {
      throw inputError(
        "--resolve and --reopen only apply to inline comments",
        "invalid_flag_combination",
        "Add --inline",
      );
    }
    if (flags.file === undefined && flags.body === undefined && resolution === undefined) {
      throw inputError(
        "Nothing to update",
        "nothing_to_update",
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
      ["atl", "comment", "get", target.id, ...(kind === "inline" ? ["--inline"] : [])],
    );
    return isPlan(updated) ? updated : compactWrittenComment(session, updated, kind);
  },
});

export const confluenceWriteCommands: readonly CommandSpec[] = [
  pageCreate,
  pageUpdate,
  commentAdd,
  commentUpdate,
];
