import { isRecord } from "../core/guards.ts";
import { isAdfDocLike } from "./types.ts";
import type { AdfDoc, AdfMark, AdfNode } from "./types.ts";

/**
 * ADF -> GitHub-flavoured markdown.
 *
 * Output conventions that have no markdown equivalent (documented placeholders):
 * - panel:           blockquote whose first line starts with `**Info:**` (Note/Warning/Error/Success)
 * - expand:          `<details><summary>title</summary>` ... `</details>`
 * - decision item:   `- [decision] text`
 * - media:           `![alt or "file"](media:<id>)`, plus `?collection=<c>` when known; external media
 *                    keeps its URL (empty alt stays empty); a link mark wraps it as `[![alt](src)](href)`
 * - extension:       `<!-- macro:<key> name="value" ... -->` with the content-bearing `macroParams` (page, jqlQuery,
 *                    name, ...; ids, layout and style noise skipped, values cut at 160 characters); bodied
 *                    extensions add `<!-- /macro:<key> -->` after the body.
 *                    A Confluence `legacy-content` extension (a table or task list the page could not keep
 *                    in place) renders its nested content; without it, its storage markup as an `xml` fence
 * - status:          `[TEXT]`, date: `YYYY-MM-DD`, mention: `@Name` or `@<accountId>`
 * - unknown node:    its children, else `<!-- adf:<type> -->`
 * - underline, sub, sup: `<u>x</u>`, `<sub>x</sub>`, `<sup>x</sup>` (markdown reads them back as marks)
 * - table spans:     a merged cell (colspan/rowspan) repeats its text in every position it covers, so
 *                    each row lists its values under the right headers
 * Other marks without markdown syntax (textColor, ...) become plain text.
 * The result has no trailing newline.
 */

type InlineMode = "block" | "table" | "heading";

interface Ctx {
  inline: InlineMode;
}

const BLOCK_CTX: Ctx = { inline: "block" };
const TABLE_CTX: Ctx = { inline: "table" };
const HEADING_CTX: Ctx = { inline: "heading" };

const INLINE_TYPES: Record<string, true> = {
  text: true,
  hardBreak: true,
  mention: true,
  emoji: true,
  inlineCard: true,
  status: true,
  date: true,
  mediaInline: true,
  inlineExtension: true,
  placeholder: true,
};

const MARK_RANK: Record<string, number> = {
  link: 0,
  strike: 1,
  strong: 2,
  em: 3,
  underline: 4,
  subsup: 5,
};

const PANEL_LABELS: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  error: "Error",
  success: "Success",
};

function isInline(node: AdfNode): boolean {
  return Object.hasOwn(INLINE_TYPES, node.type);
}

/** Markdown ignores spaces and newlines at the edges of a block; a no-break space is content. */
const EDGE_BLANKS = /^[ \t\r\n]+|[ \t\r\n]+$/g;

export function adfToMarkdown(doc: AdfDoc): string {
  return renderBlocks(doc.content ?? [], BLOCK_CTX, false).replaceAll(EDGE_BLANKS, "");
}

// ---------------------------------------------------------------------------
// Inline model
// ---------------------------------------------------------------------------

interface TextItem {
  kind: "text";
  value: string;
  marks: AdfMark[];
}
interface RawItem {
  kind: "raw";
  value: string;
}
interface BreakItem {
  kind: "break";
}
type Item = TextItem | RawItem | BreakItem;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function markKey(mark: AdfMark): string {
  if (mark.type === "link") {
    return `link\u0000${str(mark.attrs?.href) ?? ""}\u0000${str(mark.attrs?.title) ?? ""}`;
  }
  if (mark.type === "subsup") {
    return `subsup\u0000${str(mark.attrs?.type) ?? ""}`;
  }
  return mark.type;
}

/** Keep only marks that have markdown syntax; drop duplicates and links without a usable href. */
function normalizeMarks(marks: AdfMark[]): AdfMark[] {
  const seen = new Set<string>();
  const result: AdfMark[] = [];
  for (const mark of marks) {
    if (!["strong", "em", "code", "strike", "link", "underline", "subsup"].includes(mark.type)) {
      continue;
    }
    if (mark.type === "link" && str(mark.attrs?.href) === undefined) {
      continue;
    }
    if (mark.type === "subsup" && mark.attrs?.type !== "sub" && mark.attrs?.type !== "sup") {
      continue;
    }
    const key = markKey(mark);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(mark);
  }
  return result;
}

function sameMarks(a: AdfMark[], b: AdfMark[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const keys = new Set(a.map(markKey));
  return b.every((mark) => keys.has(markKey(mark)));
}

function pushText(out: Item[], value: string, marks: AdfMark[]): void {
  const last = out.at(-1);
  if (last?.kind === "text" && sameMarks(last.marks, marks)) {
    last.value += value;
    return;
  }
  out.push({ kind: "text", value, marks });
}

function cardUrl(node: AdfNode): string | undefined {
  const url = str(node.attrs?.url);
  if (url !== undefined) {
    return url;
  }
  const data = node.attrs?.data;
  return isRecord(data) ? str(data.url) : undefined;
}

function dateText(timestamp: unknown): string | undefined {
  const ms = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (Number.isFinite(ms)) {
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }
  return str(timestamp);
}

function cardMarkdown(url: string): string {
  return /[\s<>]/.test(url) ? `[${escapeText(url)}](${linkDestination(url)})` : `<${url}>`;
}

function mediaMarkdown(node: AdfNode): string {
  const attrs = node.attrs ?? {};
  const external = attrs.type === "external" ? str(attrs.url) : undefined;
  const id = str(attrs.id);
  let destination: string;
  if (external !== undefined) {
    destination = linkDestination(external);
  } else if (id !== undefined) {
    const collection = str(attrs.collection);
    destination = `media:${linkDestination(id)}`;
    if (collection !== undefined) {
      destination += `?collection=${encodeURIComponent(collection)}`;
    }
  } else {
    return `<!-- adf:${node.type} -->`;
  }
  const alt = (str(attrs.alt) ?? (external === undefined ? "file" : ""))
    .replaceAll(/\s+/g, " ")
    .replaceAll(/[\\[\]]/g, "\\$&");
  const image = `![${alt}](${destination})`;
  const href = str(node.marks?.find((mark) => mark.type === "link")?.attrs?.href);
  return href === undefined ? image : `[${image}](${linkDestination(href)})`;
}

function macroKey(node: AdfNode): string {
  const key = str(node.attrs?.extensionKey) ?? str(node.attrs?.extensionType) ?? "unknown";
  return key.replaceAll(/-{2,}/g, "-").replaceAll(/\s+/g, " ");
}

/** Macro parameters that carry no content: ids, schema/output plumbing, layout and style noise, anything secret-like. */
const MACRO_PARAM_SKIP =
  /^(?:macroid|__bodycontent|schemaversion|atlassian-macro-output-type)$|colou?r|style|width|height|border|align|icon|padding|margin|theme|layout|token|secret|passw(?:or)?d|api[-_]?key|credential|^auth(?!or)|[-_]auth(?!or)/i;
const MACRO_VALUE_MAX = 160;

/**
 * ` name="value" ...` for a macro's `parameters.macroParams` (the unnamed default parameter is `page` for
 * include macros, else `default`). Values are one line, quotes escaped, `--` collapsed so the comment cannot end early.
 */
function macroParams(node: AdfNode, key: string): string {
  const parameters = node.attrs?.parameters;
  const params = isRecord(parameters) ? parameters.macroParams : undefined;
  if (!isRecord(params)) {
    return "";
  }
  const parts: string[] = [];
  for (const [name, entry] of Object.entries(params)) {
    const raw = isRecord(entry) ? entry.value : undefined;
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      continue;
    }
    const fallback = key === "excerpt-include" || key === "include" ? "page" : "default";
    const label = (name === "" ? fallback : name).replaceAll(/[^\w.:-]+/g, "_");
    const flat = String(raw).replaceAll(/\s+/g, " ").trim();
    if (flat === "" || MACRO_PARAM_SKIP.test(label)) {
      continue;
    }
    const value = flat.length > MACRO_VALUE_MAX ? `${flat.slice(0, MACRO_VALUE_MAX)}…` : flat;
    parts.push(`${label}="${value.replaceAll('"', '\\"').replaceAll(/-{2,}/g, "-")}"`);
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function macroComment(node: AdfNode): string {
  const key = macroKey(node);
  return `<!-- macro:${key}${macroParams(node, key)} -->`;
}

function collectInline(nodes: AdfNode[], inherited: AdfMark[], out: Item[]): void {
  for (const node of nodes) {
    const marks = normalizeMarks([...inherited, ...(node.marks ?? [])]);
    switch (node.type) {
      case "text":
        if (node.text !== undefined && node.text.length > 0) {
          pushText(out, node.text, marks);
        }
        break;
      case "hardBreak":
        out.push({ kind: "break" });
        break;
      case "mention": {
        const text = str(node.attrs?.text)?.replace(/^@/, "");
        if (text !== undefined) {
          pushText(out, `@${text}`, marks);
        } else {
          out.push({ kind: "raw", value: `@<${str(node.attrs?.id) ?? "unknown"}>` });
        }
        break;
      }
      case "emoji": {
        const value = str(node.attrs?.shortName) ?? str(node.attrs?.text);
        if (value !== undefined) {
          pushText(out, value, marks);
        }
        break;
      }
      case "inlineCard": {
        const url = cardUrl(node);
        out.push({
          kind: "raw",
          value: url === undefined ? "<!-- adf:inlineCard -->" : cardMarkdown(url),
        });
        break;
      }
      case "status":
        out.push({
          kind: "raw",
          value: `[${escapeText((str(node.attrs?.text) ?? "").toUpperCase())}]`,
        });
        break;
      case "date":
        out.push({ kind: "raw", value: dateText(node.attrs?.timestamp) ?? "<!-- adf:date -->" });
        break;
      case "mediaInline":
        out.push({ kind: "raw", value: mediaMarkdown(node) });
        break;
      case "inlineExtension":
        out.push({ kind: "raw", value: macroComment(node) });
        break;
      case "placeholder":
        break;
      default:
        if (node.content !== undefined && node.content.length > 0) {
          collectInline(node.content, marks, out);
        } else {
          out.push({ kind: "raw", value: `<!-- adf:${node.type} -->` });
        }
    }
  }
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ALNUM = /[\p{L}\p{N}]/u;

/** Escape plain text so markdown re-parses it to the same characters. */
function escapeText(text: string, ctx: Ctx = BLOCK_CTX): string {
  const flat = text.replaceAll(/\r\n?|\n/g, " ").replaceAll(/[\\`*[\]<~]/g, "\\$&");
  let s = flat.replaceAll("_", (match, offset: number) => {
    const before = flat[offset - 1];
    const after = flat[offset + 1];
    const intraword =
      before !== undefined && after !== undefined && ALNUM.test(before) && ALNUM.test(after);
    return intraword ? match : "\\_";
  });
  s = s.replaceAll(/&(?=#?\w+;)/g, "\\&");
  s = s.replaceAll(/\b(https?|ftp):\/\//gi, "$1\\://");
  s = s.replaceAll(/\bwww\./gi, "www\\.");
  s = s.replaceAll(/([\w.+-])@(?=[\w-]+\.)/g, "$1\\@");
  if (ctx.inline === "table") {
    s = s.replaceAll("|", "\\|");
  }
  return s;
}

/** Escape syntax that only matters at the start of a line (headings, quotes, lists, rules). */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}(?=[ \t]|$)/, "\\$&")
        .replace(/^>/, "\\>")
        .replace(/^([-+])(?=[ \t]|$)/, "\\$1")
        .replace(/^([-=])(?=\1*[ \t]*$)/, "\\$1")
        .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2"),
    )
    .join("\n");
}

function linkDestination(url: string): string {
  return url.replaceAll(/[\\()<>]/g, "\\$&").replaceAll(/\s/g, (ch) => encodeURIComponent(ch));
}

function codeSpan(value: string, ctx: Ctx): string {
  let text = value.replaceAll(/\r\n?|\n/g, " ");
  if (ctx.inline === "table") {
    text = text.replaceAll("|", "\\|");
  }
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(longest + 1);
  const pad =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "");
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function groupMarks(item: Item): AdfMark[] {
  return item.kind === "text" ? item.marks.filter((mark) => mark.type !== "code") : [];
}

function hasMark(item: Item, key: string): boolean {
  return item.kind === "text" && item.marks.some((mark) => markKey(mark) === key);
}

function withoutMark(item: Item, key: string): Item {
  if (item.kind !== "text") {
    return item;
  }
  return { ...item, marks: item.marks.filter((mark) => markKey(mark) !== key) };
}

/** The characters next to a marked stretch, and whether `_` is the em delimiter to try first. */
interface Around {
  before: string;
  after: string;
  underscore: boolean;
}

/** CommonMark treats ASCII punctuation and Unicode punctuation and symbols alike. */
const PUNCTUATION = /^[\p{P}\p{S}]$/u;

function isSpace(char: string): boolean {
  return char === "" || /^\s$/u.test(char);
}

function isPunct(char: string): boolean {
  return PUNCTUATION.test(char);
}

function firstChar(text: string): string {
  return Array.from(text.slice(0, 2))[0] ?? "";
}

function lastChar(text: string): string {
  return Array.from(text.slice(-2)).at(-1) ?? "";
}

/** Can a delimiter run between `before` and `after` open (left-flanking) or close (right-flanking)? */
function flanking(before: string, after: string): { left: boolean; right: boolean } {
  return {
    left: !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before)),
    right: !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after)),
  };
}

/**
 * Would `delimiter` around `core` re-parse as the mark? `_` may not work inside a word, and `~~`
 * (md4c) needs a non-alphanumeric character on both outer sides. When it would not, the caller
 * writes an HTML tag, which the reader understands anywhere.
 */
function canDelimit(
  delimiter: "*" | "_" | "~",
  before: string,
  core: string,
  after: string,
): boolean {
  const open = flanking(before, firstChar(core));
  const close = flanking(lastChar(core), after);
  if (!open.left || !close.right) {
    return false;
  }
  if (delimiter === "_") {
    return (!open.right || isPunct(before)) && (!close.left || isPunct(after));
  }
  return delimiter === "*" || (!ALNUM.test(before) && !ALNUM.test(after));
}

function delimited(
  lead: string,
  delimiter: string,
  tag: string,
  valid: boolean,
  core: string,
  trail: string,
): string {
  return valid
    ? `${lead}${delimiter}${core}${delimiter}${trail}`
    : `${lead}<${tag}>${core}</${tag}>${trail}`;
}

function wrapMark(
  mark: AdfMark,
  inner: string,
  plainText: string | undefined,
  around: Around,
): string {
  const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? [];
  if (core === "") {
    return inner;
  }
  const before = lead === "" ? around.before : lastChar(lead);
  const after = trail === "" ? around.after : firstChar(trail);
  switch (mark.type) {
    case "strong":
      return delimited(lead, "**", "strong", canDelimit("*", before, core, after), core, trail);
    case "strike":
      return delimited(lead, "~~", "del", canDelimit("~", before, core, after), core, trail);
    case "em": {
      const delimiter = around.underscore ? "_" : "*";
      return delimited(
        lead,
        delimiter,
        "em",
        canDelimit(delimiter, before, core, after),
        core,
        trail,
      );
    }
    case "link": {
      const href = str(mark.attrs?.href) ?? "";
      if (plainText === href && /^[a-z][a-z0-9+.-]*:[^\s<>]+$/i.test(href)) {
        return `${lead}<${href}>${trail}`;
      }
      const title = str(mark.attrs?.title);
      const titlePart = title === undefined ? "" : ` "${title.replaceAll(/["\\]/g, "\\$&")}"`;
      return `${lead}[${core}](${linkDestination(href)}${titlePart})${trail}`;
    }
    case "underline":
      return `${lead}<u>${core}</u>${trail}`;
    case "subsup": {
      const tag = mark.attrs?.type === "sub" ? "sub" : "sup";
      return `${lead}<${tag}>${core}</${tag}>${trail}`;
    }
    default:
      return inner;
  }
}

/** The first character an item is rendered with: what follows a marked stretch before it. */
function leadChar(item: Item): string {
  if (item.kind === "raw") {
    return firstChar(item.value);
  }
  if (item.kind === "break") {
    return "\\";
  }
  if (item.marks.some((mark) => mark.type === "code")) {
    return "`";
  }
  const first = firstChar(item.value);
  return groupMarks(item).length > 0 && !isSpace(first) ? "*" : first;
}

/**
 * Render a break-free run. Adjacent items sharing a mark are wrapped once; the mark covering the
 * longest stretch is outermost so `**a_b_**` style nesting stays minimal. `before` and `after` are
 * the characters next to the run, used to avoid `***` ambiguity between strong and em and to check
 * that a delimiter can open and close there.
 */
function renderRun(items: Item[], ctx: Ctx, before: string, after: string): string {
  let out = "";
  let index = 0;
  while (index < items.length) {
    const first = items[index];
    if (first === undefined) {
      break;
    }
    const marks = groupMarks(first);
    const prev = lastChar(out) || before;
    const [firstMark] = marks;
    if (firstMark === undefined) {
      if (first.kind === "text") {
        const code = first.marks.some((mark) => mark.type === "code");
        out += code ? codeSpan(first.value, ctx) : escapeText(first.value, ctx);
      } else if (first.kind === "raw") {
        out += first.value;
      }
      index += 1;
      continue;
    }
    let best = firstMark;
    let bestLength = 0;
    for (const mark of marks) {
      const key = markKey(mark);
      let length = 0;
      for (
        let probe = items[index];
        probe !== undefined && hasMark(probe, key);
        probe = items[index + length]
      ) {
        length += 1;
      }
      const better =
        length > bestLength ||
        (length === bestLength && (MARK_RANK[mark.type] ?? 9) < (MARK_RANK[best.type] ?? 9));
      if (better) {
        best = mark;
        bestLength = length;
      }
    }
    const key = markKey(best);
    const slice = items.slice(index, index + bestLength).map((item) => withoutMark(item, key));
    const innerBefore =
      best.type === "strong" ? "*" : best.type === "strike" ? "~" : best.type === "link" ? "[" : "";
    const inner = renderRun(slice, ctx, innerBefore, "*");
    const next = items[index + bestLength];
    const starBefore = prev === "*" && !out.endsWith("\\*");
    const plain = slice.every((item) => item.kind === "text" && item.marks.length === 0)
      ? slice.map((item) => (item.kind === "text" ? item.value : "")).join("")
      : undefined;
    out += wrapMark(best, inner, plain, {
      before: prev,
      after: next === undefined ? after : leadChar(next),
      underscore: starBefore || (next !== undefined && hasMark(next, "strong")),
    });
    index += bestLength;
  }
  return out;
}

function renderInline(nodes: AdfNode[], ctx: Ctx): string {
  const items: Item[] = [];
  collectInline(nodes, [], items);
  while (items[0]?.kind === "break") {
    items.shift();
  }
  while (items.at(-1)?.kind === "break") {
    items.pop();
  }
  const breakText = ctx.inline === "table" ? "<br>" : ctx.inline === "heading" ? " " : "\\\n";
  let out = "";
  let run: Item[] = [];
  const flush = (after: string): void => {
    if (run.length > 0) {
      out += renderRun(run, ctx, lastChar(out), after);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "break") {
      flush(firstChar(breakText));
      out += breakText;
    } else {
      run.push(item);
    }
  }
  flush("");
  return out.replaceAll(EDGE_BLANKS, "");
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function listKind(node: AdfNode): "bullet" | "task" | "ordered" | undefined {
  switch (node.type) {
    case "bulletList":
    case "decisionList":
      return "bullet";
    case "taskList":
      return "task";
    case "orderedList":
      return "ordered";
    default:
      return undefined;
  }
}

function orderedStart(node: AdfNode): number {
  const order = Number(node.attrs?.order);
  return Number.isInteger(order) && order >= 0 ? order : 1;
}

/**
 * Render sibling blocks. Runs of inline nodes are wrapped into paragraphs. `tight` joins a list
 * to the preceding block with a single newline (used inside list items). Adjacent lists of the
 * same kind alternate their marker so markdown does not merge them.
 */
function renderBlocks(nodes: AdfNode[], ctx: Ctx, tight: boolean): string {
  let result = "";
  let previousKind: "bullet" | "task" | "ordered" | undefined;
  let previousAlt = false;
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node === undefined) {
      break;
    }
    let rendered: string;
    let kind: "bullet" | "task" | "ordered" | undefined;
    let alt = false;
    let joiner = "\n\n";
    if (isInline(node)) {
      let end = index;
      for (let next = nodes[end]; next !== undefined && isInline(next); next = nodes[end]) {
        end += 1;
      }
      rendered = renderParagraph(nodes.slice(index, end), ctx);
      index = end;
    } else {
      kind = listKind(node);
      if (kind !== undefined) {
        alt = previousKind === kind && !previousAlt;
        if (tight && (kind !== "ordered" || orderedStart(node) === 1)) {
          joiner = "\n";
        }
      }
      rendered = renderBlock(node, ctx, alt);
      index += 1;
    }
    if (rendered.trim() === "") {
      continue;
    }
    result += result === "" ? rendered : joiner + rendered;
    previousKind = kind;
    previousAlt = alt;
  }
  return result;
}

function renderParagraph(content: AdfNode[], ctx: Ctx): string {
  const text = renderInline(content, ctx);
  return ctx.inline === "block" ? escapeLineStarts(text) : text;
}

function textOf(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map((node) => node.text ?? textOf(node.content)).join("");
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => {
      const prefix = index === 0 ? first : rest;
      return line === "" ? prefix.trimEnd() : prefix + line;
    })
    .join("\n");
}

/** A fenced code block; the fence is longer than any backtick run inside the code. */
function fenced(code: string, language: string | undefined): string {
  let longest = 0;
  for (const run of code.match(/`{3,}/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  const info = language !== undefined && /^[^\s`]+$/.test(language) ? language : "";
  return `${fence}${info}\n${code}\n${fence}`;
}

/**
 * Confluence stores a table or task list it cannot place (inside a quote or list item) as an
 * `extension` with `parameters.nestedContent` (ADF) and `parameters.cxhtml` (storage markup).
 */
function legacyContent(node: AdfNode, ctx: Ctx): string | undefined {
  const parameters = node.attrs?.parameters;
  if (node.attrs?.extensionKey !== "legacy-content" || !isRecord(parameters)) {
    return undefined;
  }
  const nested = parameters.nestedContent;
  const body = isAdfDocLike(nested) ? renderBlocks(nested.content ?? [], ctx, false) : "";
  const storage = str(parameters.cxhtml);
  if (body !== "") {
    return body;
  }
  return storage === undefined ? undefined : fenced(storage, "xml");
}

function renderBlock(node: AdfNode, ctx: Ctx, alt: boolean): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return renderParagraph(children, ctx);
    case "heading": {
      const level = Math.min(6, Math.max(1, Math.trunc(Number(node.attrs?.level)) || 1));
      const text = renderInline(children, HEADING_CTX).replace(/#+$/, (run) => `\\${run}`);
      return text === "" ? "#".repeat(level) : `${"#".repeat(level)} ${text}`;
    }
    case "codeBlock":
      return fenced(textOf(children).replace(/\n$/, ""), str(node.attrs?.language));
    case "blockquote":
      return prefixLines(renderBlocks(children, ctx, false), "> ", "> ");
    case "rule":
      return "---";
    case "panel": {
      const type = str(node.attrs?.panelType) ?? "info";
      const label = PANEL_LABELS[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
      const body = renderBlocks(children, ctx, false);
      const first = children[0];
      const text =
        first !== undefined && (first.type === "paragraph" || isInline(first))
          ? `**${label}:** ${body}`
          : `**${label}:**\n\n${body}`;
      return prefixLines(text.trimEnd(), "> ", "> ");
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "decisionList":
      return renderList(node, ctx, alt);
    case "listItem":
    case "taskItem":
    case "decisionItem":
      return renderBlocks(children, ctx, true);
    case "table":
      return renderTable(node);
    case "expand":
    case "nestedExpand": {
      const head = `<details><summary>${escapeHtml(str(node.attrs?.title) ?? "")}</summary>`;
      const body = renderBlocks(children, ctx, false);
      return body === "" ? `${head}\n\n</details>` : `${head}\n\n${body}\n\n</details>`;
    }
    case "mediaSingle":
    case "mediaGroup": {
      const parts: string[] = [];
      for (const child of children) {
        if (child.type === "media") {
          parts.push(mediaMarkdown(child));
        } else if (child.type === "caption") {
          parts.push(renderInline(child.content ?? [], ctx));
        } else {
          parts.push(renderBlock(child, ctx, false));
        }
      }
      return parts.filter((part) => part !== "").join("\n\n");
    }
    case "media":
      return mediaMarkdown(node);
    case "blockCard":
    case "embedCard": {
      const url = cardUrl(node);
      return url === undefined ? `<!-- adf:${node.type} -->` : cardMarkdown(url);
    }
    case "extension":
      return legacyContent(node, ctx) ?? macroComment(node);
    case "bodiedExtension": {
      const key = macroKey(node);
      const body = renderBlocks(children, ctx, false);
      const opener = macroComment(node);
      return body === ""
        ? `${opener}\n\n<!-- /macro:${key} -->`
        : `${opener}\n\n${body}\n\n<!-- /macro:${key} -->`;
    }
    default:
      return children.length > 0 ? renderBlocks(children, ctx, false) : `<!-- adf:${node.type} -->`;
  }
}

function renderList(node: AdfNode, ctx: Ctx, alt: boolean): string {
  const ordered = node.type === "orderedList";
  const start = orderedStart(node);
  const lines: string[] = [];
  let counter = 0;
  for (const child of node.content ?? []) {
    if (listKind(child) !== undefined) {
      lines.push(prefixLines(renderList(child, ctx, false), "  ", "  "));
      continue;
    }
    let marker = ordered ? `${start + counter}${alt ? ")" : "."} ` : alt ? "* " : "- ";
    counter += 1;
    const indent = " ".repeat(marker.length);
    if (child.type === "taskItem") {
      marker += child.attrs?.state === "DONE" ? "[x] " : "[ ] ";
    } else if (child.type === "decisionItem") {
      marker += "[decision] ";
    }
    lines.push(prefixLines(renderBlocks(child.content ?? [], ctx, true), marker, indent));
  }
  return lines.join("\n");
}

function wrapInlineRuns(nodes: AdfNode[]): AdfNode[] {
  const result: AdfNode[] = [];
  let run: AdfNode[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      result.push({ type: "paragraph", content: run });
    }
    run = [];
  };
  for (const node of nodes) {
    if (isInline(node)) {
      run.push(node);
    } else {
      flush();
      result.push(node);
    }
  }
  flush();
  return result;
}

function cellText(cell: AdfNode): string {
  const parts: string[] = [];
  for (const child of wrapInlineRuns(cell.content ?? [])) {
    let text: string;
    if (child.type === "paragraph" || child.type === "heading") {
      text = renderInline(child.content ?? [], TABLE_CTX);
    } else if (child.type === "codeBlock") {
      text = codeSpan(textOf(child.content), TABLE_CTX);
    } else {
      text = renderBlock(child, TABLE_CTX, false);
    }
    text = text.replaceAll(/\s*\n\s*/g, "<br>").trim();
    if (text !== "") {
      parts.push(text);
    }
  }
  return parts.join("<br>");
}

const MAX_SPAN = 100;

function spanOf(cell: AdfNode, name: "colspan" | "rowspan"): number {
  const value = Math.trunc(Number(cell.attrs?.[name]));
  return value > 1 ? Math.min(value, MAX_SPAN) : 1;
}

function renderTable(node: AdfNode): string {
  // Columns covered by a rowspan cell from an earlier row, with the rows still to fill.
  const carry = new Map<number, { text: string; left: number }>();
  const rows = (node.content ?? []).map((row) => {
    const line: string[] = [];
    for (const [column, entry] of carry) {
      line[column] = entry.text;
      entry.left -= 1;
      if (entry.left === 0) {
        carry.delete(column);
      }
    }
    let column = 0;
    for (const cell of row.content ?? []) {
      while (line[column] !== undefined) {
        column += 1;
      }
      const text = cellText(cell);
      const rowspan = spanOf(cell, "rowspan");
      for (let covered = spanOf(cell, "colspan"); covered > 0; covered -= 1) {
        line[column] = text;
        if (rowspan > 1) {
          carry.set(column, { text, left: rowspan - 1 });
        }
        column += 1;
      }
    }
    return Array.from(line, (text) => text ?? "");
  });
  if (rows.length === 0) {
    return "";
  }
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: string[]): string => {
    const padded = Array.from({ length: columns }, (_, index) => {
      const cell = cells[index];
      return cell === undefined || cell === "" ? " " : cell;
    });
    return `| ${padded.join(" | ")} |`;
  };
  const separator = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), separator, ...body.map(line)].join("\n");
}
