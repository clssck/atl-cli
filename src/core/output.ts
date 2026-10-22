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
 * 768 bytes), so larger results are broken across lines; the margin absorbs the closing brackets
 * attached to a line's end.
 */
export const LINE_BUDGET = 700;

/**
 * Serialize a command result. `undefined` becomes `null` so stdout is always valid JSON.
 * Compact output is `JSON.stringify` when it fits `LINE_BUDGET`; otherwise see `layout`.
 */
export function formatJson(value: unknown, pretty: boolean): string {
  if (pretty) {
    return JSON.stringify(value ?? null, null, 2);
  }
  const flat = JSON.stringify(value ?? null);
  if (Buffer.byteLength(flat) <= LINE_BUDGET) {
    return flat;
  }
  // Re-parse so the layout sees exactly what JSON.stringify emits (toJSON, dropped undefined).
  const parsed: unknown = JSON.parse(flat);
  return layout(parsed, 0);
}

/**
 * Width-bounded compact JSON with no indentation: a value that fits on the current line (after
 * `lead` bytes already on it) stays inline; a larger array/object puts each element on its own
 * line, the opening bracket attached to the first and the closing one to the last, so the only
 * overhead is one newline per element. Scalars never split (JSON strings cannot span lines).
 */
function layout(value: unknown, lead: number): string {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== "object" || lead + Buffer.byteLength(flat) < LINE_BUDGET) {
    return flat;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => layout(item, index === 0 ? lead + 1 : 0)).join(",\n")}]`;
  }
  const members = Object.entries(value).map(([key, item], index) => {
    const prefix = `${JSON.stringify(key)}:`;
    const keyBytes = Buffer.byteLength(prefix);
    return prefix + layout(item, index === 0 ? lead + 1 + keyBytes : keyBytes);
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
    return value.map(pruneNested).filter((item) => typeof item === "string" || !isEmpty(item));
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
 * are dropped, except strings. Payloads marked with `keepRaw` are returned untouched.
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
  write(`${JSON.stringify(pruneNested(diagnostic))}\n`);
}

/** Pick one dotted path out of `source`, descending through arrays element-wise. */
function pickPath(source: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return source;
  }
  if (Array.isArray(source)) {
    return source.map((element) => pickPath(element, segments) ?? null);
  }
  if (!isRecord(source) || !Object.hasOwn(source, head)) {
    return undefined;
  }
  const picked = pickPath(source[head], rest);
  return picked === undefined ? undefined : { [head]: picked };
}

function mergeProjection(target: unknown, addition: unknown): unknown {
  if (isRecord(target) && isRecord(addition)) {
    const merged: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(addition)) {
      merged[key] = Object.hasOwn(merged, key) ? mergeProjection(merged[key], value) : value;
    }
    return merged;
  }
  if (Array.isArray(target) && Array.isArray(addition)) {
    return addition.map((value: unknown, index) =>
      index < target.length ? mergeProjection(target[index], value) : value,
    );
  }
  return addition === null && target !== undefined ? target : addition;
}

function projectOne(value: unknown, paths: readonly (readonly string[])[]): unknown {
  if (!isRecord(value)) {
    return value;
  }
  let result: unknown = {};
  for (const segments of paths) {
    const picked = pickPath(value, segments);
    if (picked !== undefined) {
      result = mergeProjection(result, picked);
    }
  }
  return result;
}

/** Split a `--fields a,b.c` value into trimmed, non-empty paths. */
export function parseFieldList(raw: string): string[] {
  return raw
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

/**
 * Project a result to the given dotted paths. When the result has an `items` array the
 * projection applies per item and the envelope (e.g. `nextCursor`) is kept; a top-level array
 * is projected per element; any other object is projected directly. Missing paths are omitted.
 */
export function project(value: unknown, fields: readonly string[]): unknown {
  const paths = fields.map((field) => field.split("."));
  if (Array.isArray(value)) {
    return value.map((item: unknown) => projectOne(item, paths));
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return { ...value, items: value.items.map((item: unknown) => projectOne(item, paths)) };
  }
  return projectOne(value, paths);
}
