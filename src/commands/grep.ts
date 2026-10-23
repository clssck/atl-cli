import { inputError } from "../core/errors.ts";
import { bodyLines } from "./common.ts";

/** Case-insensitive line matcher for `--grep`; a leading `(?i)` is accepted, a bad pattern is an input error. */
export function grepPattern(source: string): RegExp {
  try {
    return new RegExp(source.startsWith("(?i)") ? source.slice(4) : source, "i");
  } catch (error) {
    throw inputError(
      "invalid_regex",
      `--grep is not a valid regular expression: ${error instanceof Error ? error.message : source}`,
      "Patterns use JavaScript regex syntax and already match case-insensitively; only a leading (?i) is accepted, other inline flags are not supported. Escape literal ( ) [ ] { } . * + ? | ^ $ with a backslash",
    );
  }
}

/**
 * Matching rows with `context` rows on each side, overlapping or adjacent ranges merged. A range
 * is `{from, to, hits, text}` (1-based, inclusive); `to` and `hits` are dropped for a single row,
 * which is then the hit. `text` is wrapped like a body (`bodyLines`) so no line exceeds the budget.
 */
export function grepRanges(
  rows: readonly string[],
  matcher: RegExp,
  context: number,
  markdown: boolean,
): object[] {
  const ranges: { from: number; to: number; hits: number[] }[] = [];
  const size = Math.max(GREP_RANGE_LINES, 2 * context + 1);
  rows.forEach((row, index) => {
    if (!grepHit(row, matcher, markdown)) {
      return;
    }
    const line = index + 1;
    const end = Math.min(rows.length, line + context);
    const last = ranges.at(-1);
    if (last !== undefined && line - context <= last.to + 1 && end - last.from + 1 <= size) {
      last.to = end;
      last.hits.push(line);
    } else {
      ranges.push({ from: Math.max(1, line - context), to: end, hits: [line] });
    }
  });
  return ranges.map(({ from, to, hits }) => {
    const hitLines = new Set(hits);
    const shown = rows
      .slice(from - 1, to)
      .flatMap((row, offset) => grepRow(row, hitLines.has(from + offset), matcher));
    return {
      from,
      to: to === from ? undefined : to,
      hits: to === from ? undefined : hits,
      text: bodyLines(shown.join("\n")),
    };
  });
}

/** `--grep` prints at most this many ranges; `moreMatches` counts the rest. */
export const GREP_RANGE_CAP = 20;
/** A range of several merged hits is split once it would pass this many lines (a hit's own context is never cut). */
const GREP_RANGE_LINES = 20;
/** A line longer than this is shown as excerpts around its hits (or cut, when it is context). */
const GREP_LONG_LINE = 300;
const GREP_EXCERPT_RADIUS = 100;
const GREP_EXCERPTS_PER_LINE = 3;
/** Markdown escapes punctuation with a backslash; a pattern may match the text without them. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** Does the pattern match the row, or (markdown) the row with its backslash escapes removed? */
function grepHit(row: string, matcher: RegExp, markdown: boolean): boolean {
  return (
    matcher.test(row) ||
    (markdown && row.includes("\\") && matcher.test(row.replaceAll(MARKDOWN_ESCAPE, "$1")))
  );
}

/** A row as shown in a range: whole when short, else excerpts around the hits or its first characters. */
function grepRow(row: string, hit: boolean, matcher: RegExp): string[] {
  if (row.length <= GREP_LONG_LINE) {
    return [row];
  }
  const windows: { start: number; end: number }[] = [];
  let more = 0;
  if (hit) {
    for (const found of row.matchAll(new RegExp(matcher.source, "gi"))) {
      const start = Math.max(0, found.index - GREP_EXCERPT_RADIUS);
      const end = Math.min(
        row.length,
        found.index + Math.min(found[0].length, GREP_EXCERPT_RADIUS) + GREP_EXCERPT_RADIUS,
      );
      const last = windows.at(-1);
      if (last !== undefined && start <= last.end) {
        last.end = Math.max(last.end, end);
      } else if (windows.length < GREP_EXCERPTS_PER_LINE) {
        windows.push({ start, end });
      } else {
        more++;
      }
    }
  }
  if (windows.length === 0) {
    return [`${row.slice(0, GREP_LONG_LINE)}…`];
  }
  const shown = windows.map(
    ({ start, end }) =>
      `${start > 0 ? "…" : ""}${row.slice(start, end)}${end < row.length ? "…" : ""}`,
  );
  return more === 0 ? shown : [...shown, `… ${more} more matches in this line`];
}
