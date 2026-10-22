import { isRecord } from "./guards.ts";

/**
 * Output contract: stdout carries exactly one JSON value (width-bounded compact layout unless
 * pretty); stderr carries JSONL diagnostics. Never emits ANSI escapes, so NO_COLOR holds trivially.
 */

export type Writer = (text: string) => void;

export const writeStdout: Writer = (text) => {
  process.stdout.write(text);
};

export const writeStderr: Writer = (text) => {
  process.stderr.write(text);
};

/**
 * A reader that exits early (`atl ... | head -1`) closes stdout and the write fails with EPIPE.
 * The command had already succeeded by then (stdout is written last), so that is not an error;
 * any other stream error keeps its default fatal behavior.
 */
export function quietOnClosedStdout(stream: {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
}): void {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
  });
}

/** `--pretty` or env `ATL_PRETTY` set to `1`/`true`. */
export function isPretty(flag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag) {
    return true;
  }
  const value = env.ATL_PRETTY?.toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Max bytes per compact stdout line. Agent harnesses cut each stdout line (omp's bash tool at
 * 768 bytes), so larger results are broken across lines; the margin absorbs what a line cannot
 * avoid. A single string value longer than this (a raw `--full` body, `--format storage`) cannot
 * be split and is the only way a line exceeds it.
 */
export const LINE_BUDGET = 700;

/**
 * Zero-width, bidi-control, no-break/soft-hyphen, typographic-space, line-separator, C1 and tag
 * characters. Raw, they make two different strings print identically (`ACME-7731` with a hidden
 * U+200B no longer matches a grep) or reorder text, so JSON output spells them as `\uXXXX`.
 */
const INVISIBLE =
  /[\u007F-\u00A0\u00AD\u061C\u180E\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** `JSON.stringify` with invisible characters escaped; parses back to the identical value. */
function encodeJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replaceAll(INVISIBLE, (match) =>
    match
      .split("")
      .map((unit) => `\\u${(unit.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

/**
 * Serialize a command result. `undefined` becomes `null` so stdout is always valid JSON.
 * Compact output is `JSON.stringify` when it fits `LINE_BUDGET`; otherwise see `layout`.
 * Invisible characters are escaped either way (`INVISIBLE`).
 */
export function formatJson(value: unknown, pretty: boolean): string {
  if (pretty) {
    return encodeJson(value ?? null, 2);
  }
  const flat = encodeJson(value ?? null);
  if (Buffer.byteLength(flat) <= LINE_BUDGET) {
    return flat;
  }
  // Re-parse so the layout sees exactly what JSON.stringify emits (toJSON, dropped undefined).
  const parsed: unknown = JSON.parse(flat);
  return layout(parsed, 0, 0);
}

/**
 * Width-bounded compact JSON with no indentation: a value that fits on the current line stays
 * inline; a larger array/object puts each element on its own line, the opening bracket attached
 * to the first and the closing one to the last, so the only overhead is one newline per element.
 * `lead` is what already sits on the line before the value, `trail` what will be appended after it
 * (a comma, or the closing brackets of every enclosing container the value ends), so the whole
 * line stays within `LINE_BUDGET`. Scalars never split (JSON strings cannot span lines).
 */
function layout(value: unknown, lead: number, trail: number): string {
  const flat = encodeJson(value);
  if (
    value === null ||
    typeof value !== "object" ||
    lead + Buffer.byteLength(flat) + trail <= LINE_BUDGET
  ) {
    return flat;
  }
  if (Array.isArray(value)) {
    const last = value.length - 1;
    const elements = value.map((item, index) =>
      layout(item, index === 0 ? lead + 1 : 0, index === last ? trail + 1 : 1),
    );
    return `[${elements.join(",\n")}]`;
  }
  const entries = Object.entries(value);
  const last = entries.length - 1;
  const members = entries.map(([key, item], index) => {
    const prefix = `${encodeJson(key)}:`;
    const keyBytes = Buffer.byteLength(prefix);
    return (
      prefix +
      layout(item, index === 0 ? lead + 1 + keyBytes : keyBytes, index === last ? trail + 1 : 1)
    );
  });
  return `{${members.join(",\n")}}`;
}

const RAW = new WeakSet<object>();
const MARKDOWN = new WeakMap<readonly string[], string>();

/**
 * Remember the exact markdown a display line array (soft-wrapped, possibly hard-split) came from, so
 * `--output` writes the original instead of re-joining display lines into broken tables or code.
 * `prune` and `project` keep string arrays by identity, so the link survives both.
 */
export function withSource(lines: string[], markdown: string): string[] {
  MARKDOWN.set(lines, markdown);
  return lines;
}

export function sourceMarkdown(lines: readonly string[]): string | undefined {
  return MARKDOWN.get(lines);
}

/** Mark a passthrough payload (raw API/MCP response, snapshot) so `prune` returns it untouched. */
export function keepRaw<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    RAW.add(value);
  }
  return value;
}

const KEEP_EMPTY = new WeakSet<object>();

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

function pruneNested(value: unknown): unknown {
  if (typeof value !== "object" || value === null || RAW.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    // String arrays (body lines, argv words in `next`) stay as-is, by identity: empty strings are
    // meaningful there, and `sourceMarkdown` looks the array up by reference.
    if (value.every((item) => typeof item === "string")) {
      return value;
    }
    const kept: unknown[] = [];
    for (const item of value) {
      const pruned = pruneNested(item);
      // A projected list item that matched no path stays as `{}`: dropping it would change the count.
      const placeholder = typeof item === "object" && item !== null && KEEP_EMPTY.has(item);
      if (typeof item === "string" || !isEmpty(pruned) || placeholder) {
        kept.push(pruned);
      }
    }
    return kept;
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = pruneNested(child);
    if (!isEmpty(pruned)) {
      out[key] = pruned;
    }
  }
  return out;
}

/**
 * Compact-output invariant: no `null`, `undefined`, `""`, `[]` or `{}` object values at any depth
 * (absence means "none"; `nextCursor` absent means no more pages). The one exception is the
 * top-level `items`, so an empty list still prints `{"items":[]}`. Array elements that are empty
 * are dropped, except strings and projected list items (`project` keeps the count). Payloads
 * marked with `keepRaw` are returned untouched.
 */
export function prune(value: unknown): unknown {
  if (!isRecord(value) || RAW.has(value)) {
    return pruneNested(value);
  }
  const pruned = pruneNested(value);
  if (Array.isArray(value.items) && isRecord(pruned) && pruned.items === undefined) {
    return { items: [], ...pruned };
  }
  return pruned;
}

/** Write one JSONL diagnostic line to stderr; empty fields are dropped like compact results. */
export function writeDiagnostic(
  diagnostic: Record<string, unknown>,
  write: Writer = writeStderr,
): void {
  write(`${encodeJson(pruneNested(diagnostic))}\n`);
}

/**
 * Pick one dotted path out of `source`, descending through arrays element-wise; a numeric segment
 * on an array picks that element and keeps its index as the key (`tiers.1.rps` gives
 * `{tiers: {"1": {rps}}}`). Anything picked out of a `keepRaw` payload stays raw, so nulls and
 * empties inside it survive `prune`. Undefined when the path matches nothing.
 */
function pickPath(source: unknown, segments: readonly string[], raw: boolean): unknown {
  const [head, ...rest] = segments;
  const inRaw = raw || (typeof source === "object" && source !== null && RAW.has(source));
  if (head === undefined) {
    return inRaw ? keepRaw(source) : source;
  }
  if (Array.isArray(source)) {
    if (/^\d+$/.test(head)) {
      const picked = pickPath(source[Number(head)], rest, inRaw);
      return picked === undefined ? undefined : keepRawIf(inRaw, { [head]: picked });
    }
    const picks = source.map((element: unknown) => pickPath(element, segments, inRaw));
    if (source.length > 0 && picks.every((picked) => picked === undefined)) {
      return undefined;
    }
    return keepRawIf(
      inRaw,
      picks.map((picked) => picked ?? null),
    );
  }
  if (!isRecord(source) || !Object.hasOwn(source, head)) {
    return undefined;
  }
  const picked = pickPath(source[head], rest, inRaw);
  return picked === undefined ? undefined : keepRawIf(inRaw, { [head]: picked });
}

function keepRawIf<T>(raw: boolean, value: T): T {
  return raw ? keepRaw(value) : value;
}

function mergeProjection(target: unknown, addition: unknown): unknown {
  const raw =
    (typeof target === "object" && target !== null && RAW.has(target)) ||
    (typeof addition === "object" && addition !== null && RAW.has(addition));
  if (isRecord(target) && isRecord(addition)) {
    const merged: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(addition)) {
      merged[key] = Object.hasOwn(merged, key) ? mergeProjection(merged[key], value) : value;
    }
    return keepRawIf(raw, merged);
  }
  if (Array.isArray(target) && Array.isArray(addition)) {
    return keepRawIf(
      raw,
      addition.map((value: unknown, index) =>
        index < target.length ? mergeProjection(target[index], value) : value,
      ),
    );
  }
  return addition === null && target !== undefined ? target : addition;
}

/**
 * Project one record; `matched` collects the indexes of paths that picked something. The result is
 * marked so `prune` keeps it in its list even when it is `{}`.
 */
function projectOne(
  value: unknown,
  paths: readonly (readonly string[])[],
  matched: Set<number>,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  let result: unknown = {};
  paths.forEach((segments, index) => {
    const picked = pickPath(value, segments, false);
    if (picked !== undefined) {
      matched.add(index);
      result = mergeProjection(result, picked);
    }
  });
  if (isRecord(result)) {
    KEEP_EMPTY.add(result);
  }
  return result;
}

/** Comma-separated flag value to trimmed, non-empty entries (`--fields a,b.c`, `--labels x,y`). */
export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Project a result to the given dotted paths. When the result has an `items` array the
 * projection applies per item and the envelope (e.g. `nextCursor`) is kept; a top-level array
 * is projected per element; any other object is projected directly. Items are never dropped: one
 * without a requested path becomes `{}`. An `items.` prefix is accepted as the per-item path
 * (unless the items themselves carry an `items` field). Missing paths are omitted from the result
 * and, when none of the examined records has them, reported once through `onUnmatched`.
 */
export function project(
  value: unknown,
  fields: readonly string[],
  onUnmatched?: (paths: string[]) => void,
): unknown {
  const paths = fields.map((field) => field.split("."));
  const items: unknown[] | undefined =
    isRecord(value) && Array.isArray(value.items) ? value.items : undefined;
  const itemPaths =
    items === undefined || items.some((item) => isRecord(item) && Object.hasOwn(item, "items"))
      ? paths
      : paths.map((segments) =>
          segments[0] === "items" && segments.length > 1 ? segments.slice(1) : segments,
        );
  const matched = new Set<number>();
  const each = (item: unknown): unknown => projectOne(item, itemPaths, matched);

  let projected: unknown;
  let examined: readonly unknown[];
  if (Array.isArray(value)) {
    projected = value.map(each);
    examined = value;
  } else if (isRecord(value) && items !== undefined) {
    const projectedItems = items.map(each);
    const itemMatched = matched.size > 0;
    examined = items;
    // The envelope (`nextCursor`, `ctx`) is kept whole, so a path naming one of its keys is not unmatched.
    let envelopeMatched = false;
    paths.forEach(([head], index) => {
      if (head !== undefined && head !== "items" && Object.hasOwn(value, head)) {
        matched.add(index);
        envelopeMatched = true;
      }
    });
    // Only envelope fields were asked for (`--fields totalSeconds`): `{}` placeholders would be noise.
    const { items: _items, ...envelope } = value;
    projected = envelopeMatched && !itemMatched ? envelope : { ...value, items: projectedItems };
  } else {
    projected = projectOne(value, paths, matched);
    examined = [value];
  }
  const missing = fields.filter((_, index) => !matched.has(index));
  if (onUnmatched !== undefined && missing.length > 0 && examined.some(isRecord)) {
    onUnmatched(missing);
  }
  return projected;
}
