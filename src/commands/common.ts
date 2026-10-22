import { Type } from "../core/schema.ts";
import { adfToMarkdown, parseAdfBody, type AdfDoc } from "../adf/index.ts";
import type { PagePolicy } from "../core/paginate.ts";
import { withSource } from "../core/output.ts";

/** Spread into a command's `Type.Object({...})` for list/search commands. */
export const PAGING_FLAGS = {
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Total items to return" })),
  all: Type.Optional(Type.Boolean({ description: "Follow every page (hard cap 1000 items)" })),
  cursor: Type.Optional(Type.String({ description: "Resume from a previous nextCursor" })),
};

export interface PagingFlags {
  limit?: number | undefined;
  all?: boolean | undefined;
  cursor?: string | undefined;
}

export function pagePolicy(
  flags: PagingFlags,
  defaults: { defaultLimit: number; maxPageSize: number },
): PagePolicy {
  return { limit: flags.limit, all: flags.all, cursor: flags.cursor, ...defaults };
}

/** `--format` for ADF-backed bodies (Jira, Confluence comments). */
export const ADF_FORMAT_FLAG = Type.Optional(
  Type.Union([Type.Literal("md"), Type.Literal("adf")], {
    description: "Body format: markdown rendered locally (default) or raw ADF",
    default: "md",
  }),
);

export type AdfFormat = "md" | "adf";

/** Max JSON-encoded bytes of one markdown body line; stdout lines stay under `LINE_BUDGET` with the key and comma around it. */
export const BODY_LINE_BYTES = 600;

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

const FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
/** Lines that are never soft-wrapped: headings and table rows (also inside lists and quotes). */
const UNWRAPPABLE = /^[\s>]*(?:#{1,6}(?:\s|$)|\|)/;
/** A word that would turn into block syntax (list item, quote, heading, fence, rule, HTML) at the start of a line. */
const BLOCK_START = /^(?:#{1,6}$|[-+*]$|>|\||\d{1,9}[.)]$|`{3,}|~{3,}|=+$|-{2,}$|\*{3,}$|_{3,}$|<)/;

/** Split `text` into pieces of at most `BODY_LINE_BYTES` JSON bytes, cutting between code points. */
function hardSplit(text: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  let bytes = 2;
  for (const char of text) {
    const size = jsonBytes(char) - 2;
    if (bytes + size > BODY_LINE_BYTES && piece !== "") {
      pieces.push(piece);
      piece = "";
      bytes = 2;
    }
    piece += char;
    bytes += size;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * Soft-wrap one prose line at spaces. Interior runs of spaces collapse to the single space of the
 * break; the leading indent stays on the first piece and trailing spaces (a markdown hard break) on
 * the last. A break never puts a block marker (`-`, `1.`, `>`, `#`, fence, ...) at a piece's start:
 * the break moves back before the preceding word. A single word over the budget is hard-split.
 */
function softWrap(line: string): string[] {
  const indent = /^ */.exec(line)?.[0] ?? "";
  const trailing = /(?<=\S) +$/.exec(line)?.[0] ?? "";
  const words = line.slice(indent.length, line.length - trailing.length).split(/ +/);
  const pieces: string[] = [];
  let head = [indent + (words[0] ?? "")];
  for (const word of words.slice(1)) {
    if (jsonBytes(`${head.join(" ")} ${word}`) <= BODY_LINE_BYTES) {
      head.push(word);
      continue;
    }
    const carry = [word];
    while (BLOCK_START.test(carry[0] ?? "") && head.length > 1) {
      const moved = head.pop();
      if (moved !== undefined) {
        carry.unshift(moved);
      }
    }
    if (BLOCK_START.test(carry[0] ?? "")) {
      head.push(...carry);
    } else {
      pieces.push(head.join(" "));
      head = carry;
    }
  }
  pieces.push(head.join(" ") + trailing);
  return pieces.flatMap((piece) =>
    jsonBytes(piece) > BODY_LINE_BYTES ? hardSplit(piece) : [piece],
  );
}

/**
 * Markdown body as lines for compact output: harnesses cut each stdout line (see `LINE_BUDGET`),
 * and a long body is one JSON string, so the body is an array of its `\n`-separated lines. A prose
 * line over `BODY_LINE_BYTES` JSON bytes is soft-wrapped at word boundaries (a markdown soft break:
 * renders the same). Fenced code, table rows and headings are never wrapped; one still over the
 * budget is hard-split between code points without any marker, because a cut line loses its tail
 * for the reader and a split one does not. `withSource` keeps the original markdown for `--output`.
 * An empty body gives `[]`, which `prune` drops.
 */
export function bodyLines(markdown: string): string[] {
  if (markdown === "") {
    return [];
  }
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line);
    const run = marker?.[1] ?? "";
    let wrap = fence === undefined;
    if (fence === undefined) {
      if (marker !== null) {
        fence = { char: run.charAt(0), length: run.length };
        wrap = false;
      }
    } else if (
      marker !== null &&
      run.charAt(0) === fence.char &&
      run.length >= fence.length &&
      (marker[2] ?? "").trim() === ""
    ) {
      fence = undefined;
    }
    if (jsonBytes(line) <= BODY_LINE_BYTES) {
      out.push(line);
    } else if (wrap && !UNWRAPPABLE.test(line)) {
      out.push(...softWrap(line));
    } else {
      out.push(...hardSplit(line));
    }
  }
  return withSource(out, markdown);
}

/** Render an ADF body (object or Confluence JSON string) as markdown lines (see `bodyLines`) or a parsed ADF doc. */
export function renderAdf(
  value: string | AdfDoc,
  format: AdfFormat | undefined,
): string[] | AdfDoc {
  const doc = parseAdfBody(value);
  return format === "adf" ? doc : bodyLines(adfToMarkdown(doc));
}

/** ISO 8601 without sub-second precision: `2026-10-21T20:31:57.000Z` becomes `...:57Z`; offsets are kept. */
export function shortTs(value: string | null | undefined): string | undefined {
  return value?.replace(/(T\d\d:\d\d:\d\d)\.\d+/, "$1");
}
