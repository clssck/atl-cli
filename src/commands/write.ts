import { Type } from "../core/schema.ts";
import { markdownToAdf, parseAdfBody, type AdfDoc } from "../adf/index.ts";
import type { CommandContext } from "../core/cli.ts";
import { isRecord } from "../core/guards.ts";
import { AtlError, type NextCommand } from "../core/errors.ts";
import { buildUrl, type HttpClient, type HttpMethod, type Query } from "../core/http.ts";

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

export function isPlan(value: unknown): value is Plan {
  return isRecord(value) && value.type === "plan";
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

/** `--yes` for commands whose writes need explicit confirmation (raw passthroughs, destructive ops). */
export const YES_FLAG = Type.Optional(
  Type.Boolean({ description: "Confirm the change; preview first with --plan" }),
);

/**
 * Gate a write that needs `--yes`: under `--plan` the caller plans instead, so this only throws when
 * neither `--plan` nor `--yes` was given. `subject` names what would change (e.g. "DELETE issue
 * ABC-1"); `planArgv` overrides the suggested preview command when `ctx.argv` is not the invocation.
 */
export function requireYes(
  ctx: Pick<CommandContext, "plan" | "argv">,
  yes: boolean | undefined,
  subject: string,
  planArgv: NextCommand = ["atl", ...ctx.argv, "--plan"],
): void {
  if (ctx.plan || yes === true) {
    return;
  }
  throw new AtlError(`${subject} changes data and needs confirmation`, {
    code: "confirmation_required",
    category: "input",
    hint: "Preview with --plan, then re-run with --yes.",
    next: [planArgv],
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

/** Test seam: the reader behind `--file -` / `--comment-file -` (bytes are decoded as UTF-8). */
export const bodyDeps: { readStdin?: (() => Promise<string | Uint8Array>) | undefined } = {};

/** Offset of the first byte that starts no well-formed UTF-8 sequence. */
function invalidUtf8Offset(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    let extra = 0;
    let low = 0x80;
    let high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      extra = 1;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      extra = 2;
      low = lead === 0xe0 ? 0xa0 : low;
      high = lead === 0xed ? 0x9f : high;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      extra = 3;
      low = lead === 0xf0 ? 0x90 : low;
      high = lead === 0xf4 ? 0x8f : high;
    } else if (lead >= 0x80) {
      return index;
    }
    for (let offset = 1; offset <= extra; offset += 1) {
      const byte = bytes[index + offset];
      if (byte === undefined || byte < low || byte > high) {
        return index;
      }
      low = 0x80;
      high = 0xbf;
    }
    index += extra + 1;
  }
  return -1;
}

/**
 * Strict decoding: UTF-8 (a BOM is dropped) or UTF-16 with a BOM. Invalid bytes are an input
 * error rather than silent U+FFFD, which would corrupt legacy-encoded files (Windows-1250 `ő`).
 */
function decodeBody(bytes: Uint8Array, label: string): string {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : undefined;
  try {
    return new TextDecoder(utf16 ?? "utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    const offset = utf16 === undefined ? invalidUtf8Offset(bytes) : -1;
    const where =
      offset === -1
        ? ""
        : `: byte 0x${(bytes[offset] ?? 0).toString(16).toUpperCase().padStart(2, "0")} at offset ${offset}`;
    throw new AtlError(
      `${label} is not valid ${utf16 === undefined ? "UTF-8" : "UTF-16"}${where}`,
      {
        code: "body_not_utf8",
        category: "input",
        hint: "Re-save the file as UTF-8, for example: iconv -f WINDOWS-1250 -t UTF-8 in.md > out.md",
        cause,
      },
    );
  }
}

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
  const raw =
    inline ??
    (await (
      path === undefined
        ? (bodyDeps.readStdin ?? (() => Bun.stdin.bytes()))()
        : Bun.file(path).bytes()
    ).catch((cause: unknown) => {
      throw new AtlError(`Cannot read ${label}`, {
        code: "body_file_unreadable",
        category: "input",
        cause,
      });
    }));
  const text = typeof raw === "string" ? raw : decodeBody(raw, label);
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

/**
 * The argv that applies a plan: the current one without plan flags, plus `--yes` for destructive
 * commands (the plan itself needs no confirmation, the apply step does).
 */
export function applyArgvFor(ctx: Pick<CommandContext, "argv">, needsYes: boolean): NextCommand {
  const argv = applyArgv(ctx.argv);
  return needsYes && !argv.includes("--yes") ? [...argv, "--yes"] : argv;
}
