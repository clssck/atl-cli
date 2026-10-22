import { Type } from "../core/schema.ts";
import { markdownToAdf, parseAdfBody, type AdfDoc } from "../adf/index.ts";
import type { CommandContext } from "../core/cli.ts";
import { AtlError, type NextCommand } from "../core/errors.ts";
import type { HttpClient, HttpMethod, Query } from "../core/http.ts";
import { buildUrl } from "../core/http.ts";

const PREVIEW_CHARS = 500;

export interface PlannedRequest {
  method: HttpMethod;
  url: string;
  query?: Query;
  body?: unknown;
}

export interface Plan {
  type: "plan";
  method: HttpMethod;
  url: string;
  body?: { sha256: string; bytes: number; preview: string };
  next: NextCommand[];
}

/** Describe a write without sending it. `next` is the argv that applies it. */
export function planOf(request: PlannedRequest, next: readonly NextCommand[]): Plan {
  const bodyText = request.body === undefined ? undefined : JSON.stringify(request.body);
  return {
    type: "plan",
    method: request.method,
    url: buildUrl(request.url, "", request.query),
    ...(bodyText === undefined
      ? {}
      : {
          body: {
            sha256: new Bun.CryptoHasher("sha256").update(bodyText).digest("hex"),
            bytes: Buffer.byteLength(bodyText),
            preview: bodyText.slice(0, PREVIEW_CHARS),
          },
        }),
    next: [...next],
  };
}

/**
 * Named write commands: with `--plan` return the plan, otherwise send once (writes never retry).
 * `next` is the exact argv to apply the plan: the current argv without `--plan`/`--dry-run`.
 */
export async function planOrSend<T>(
  ctx: Pick<CommandContext, "plan">,
  http: HttpClient,
  request: PlannedRequest,
  next: readonly NextCommand[],
): Promise<T | Plan> {
  if (ctx.plan) {
    return planOf(request, next);
  }
  return http.request<T>({
    method: request.method,
    url: request.url,
    ...(request.query === undefined ? {} : { query: request.query }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
}

const BODY_FORMAT_FLAG = Type.Optional(
  Type.Union([Type.Literal("md"), Type.Literal("adf"), Type.Literal("storage")], {
    description:
      "Body format (default md; for a --file path: adf for .json, storage for .xhtml/.html/.xml)",
  }),
);

/**
 * `--body` | `--file` + `--body-format` for commands that take a document body. Both are optional
 * in the schema; `loadBody`/`requireBody` enforce at most / exactly one.
 */
export const BODY_FLAGS = {
  body: Type.Optional(
    Type.String({
      description: "Inline body text (markdown unless --body-format); excludes --file",
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        "Body file, or - for stdin: markdown (default), ADF JSON, or storage XHTML; excludes --body",
    }),
  ),
  bodyFormat: BODY_FORMAT_FLAG,
};

/** `--comment` | `--comment-file` + `--body-format` for writes that attach an optional Jira comment. */
export const COMMENT_FLAGS = {
  comment: Type.Optional(
    Type.String({
      description: "Inline comment text (markdown unless --body-format); excludes --comment-file",
    }),
  ),
  commentFile: Type.Optional(
    Type.String({
      description:
        "Comment file, or - for stdin: markdown (default) or ADF JSON; excludes --comment",
    }),
  ),
  bodyFormat: BODY_FORMAT_FLAG,
};

export type BodyFormat = "md" | "adf" | "storage";

export type LoadedBody = { kind: "adf"; doc: AdfDoc } | { kind: "storage"; value: string };

export interface BodySource {
  body?: string | undefined;
  file?: string | undefined;
  bodyFormat?: BodyFormat | undefined;
}

export interface CommentSource {
  comment?: string | undefined;
  commentFile?: string | undefined;
  bodyFormat?: BodyFormat | undefined;
}

/** Test seam: the reader behind `--file -` / `--comment-file -`. */
export const bodyDeps: { readStdin?: (() => Promise<string>) | undefined } = {};

interface FlagNames {
  inline: string;
  file: string;
}

const BODY_NAMES: FlagNames = { inline: "--body", file: "--file" };
const COMMENT_NAMES: FlagNames = { inline: "--comment", file: "--comment-file" };

/**
 * Read the inline text, the file, or stdin (`-`) and convert it locally; undefined when neither
 * flag is given. Markdown becomes ADF; storage is passed through and only allowed when
 * `allowStorage` (Confluence). Extension inference applies only to real file paths.
 */
async function readBody(
  inline: string | undefined,
  file: string | undefined,
  bodyFormat: BodyFormat | undefined,
  allowStorage: boolean,
  names: FlagNames,
): Promise<LoadedBody | undefined> {
  if (inline !== undefined && file !== undefined) {
    throw new AtlError(`${names.inline} and ${names.file} are mutually exclusive`, {
      code: "body_conflict",
      category: "input",
      hint: `Pass the text with ${names.inline}, or a path (or - for stdin) with ${names.file}.`,
    });
  }
  if (inline === undefined && file === undefined) {
    return undefined;
  }
  const path = file === undefined || file === "-" ? undefined : file;
  const format: BodyFormat =
    bodyFormat ??
    (path === undefined
      ? "md"
      : /\.json$/i.test(path)
        ? "adf"
        : /\.(x?html|xml)$/i.test(path)
          ? "storage"
          : "md");
  if (format === "storage" && !allowStorage) {
    throw new AtlError("Storage format is Confluence-only; Jira bodies are ADF", {
      code: "unsupported_body_format",
      category: "input",
      hint: "Use markdown or --body-format adf.",
    });
  }
  const label = file === undefined ? names.inline : `${names.file} ${file}`;
  const text =
    inline ??
    (await (
      path === undefined
        ? (bodyDeps.readStdin ?? (() => Bun.stdin.text()))()
        : Bun.file(path).text()
    ).catch((cause: unknown) => {
      throw new AtlError(`Cannot read ${label}`, {
        code: "body_file_unreadable",
        category: "input",
        cause,
      });
    }));
  if (format === "storage") {
    return { kind: "storage", value: text };
  }
  if (format === "md") {
    return { kind: "adf", doc: markdownToAdf(text) };
  }
  try {
    return { kind: "adf", doc: parseAdfBody(text) };
  } catch (cause) {
    throw new AtlError(`${label} is not a valid ADF document`, {
      code: "invalid_body",
      category: "input",
      cause,
    });
  }
}

/** The `--body`/`--file` body, or undefined when neither is given (optional-body updates). */
export function loadBody(
  source: BodySource,
  options: { allowStorage: boolean },
): Promise<LoadedBody | undefined> {
  return readBody(source.body, source.file, source.bodyFormat, options.allowStorage, BODY_NAMES);
}

/** Like `loadBody`, for commands whose body is mandatory: neither flag is `body_required`. */
export async function requireBody(
  source: BodySource,
  options: { allowStorage: boolean },
): Promise<LoadedBody> {
  const body = await loadBody(source, options);
  if (body === undefined) {
    throw new AtlError("A body is required: pass --body or --file", {
      code: "body_required",
      category: "input",
      hint: 'Short text: --body "Deployed to staging". Longer: --file note.md, or --file - to read stdin.',
    });
  }
  return body;
}

/** The optional Jira comment from `--comment`/`--comment-file`, as ADF. */
export async function loadComment(source: CommentSource): Promise<AdfDoc | undefined> {
  const body = await readBody(
    source.comment,
    source.commentFile,
    source.bodyFormat,
    false,
    COMMENT_NAMES,
  );
  return body === undefined ? undefined : jiraBody(body);
}

/** Confluence v2 `body` field for a loaded body. */
export function confluenceBody(body: LoadedBody): { representation: string; value: string } {
  return body.kind === "storage"
    ? { representation: "storage", value: body.value }
    : { representation: "atlas_doc_format", value: JSON.stringify(body.doc) };
}

/** Jira v3 rich-text field value; storage is rejected by `loadBody` for Jira. */
export function jiraBody(body: LoadedBody): AdfDoc {
  if (body.kind !== "adf") {
    throw new AtlError("Jira bodies must be ADF", {
      code: "unsupported_body_format",
      category: "input",
    });
  }
  return body.doc;
}

/** Rebuild the current invocation's argv without plan flags, for `next` hints. */
export function applyArgv(argv: readonly string[]): NextCommand {
  return ["atl", ...argv.filter((arg) => arg !== "--plan" && arg !== "--dry-run")];
}
