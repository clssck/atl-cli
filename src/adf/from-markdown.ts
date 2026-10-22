import { isRecord } from "../core/guards.ts";
import type { AdfDoc, AdfMark, AdfNode } from "./types.ts";

/**
 * Markdown (CommonMark + GFM, parsed natively by `Bun.markdown`) -> ADF.
 *
 * `Bun.markdown.react` yields a plain element tree (`{ type: "p" | "ul" | ..., props: { children } }`)
 * with entities already decoded; it is walked here without React.
 *
 * Choices worth knowing:
 * - Raw HTML (block or inline) is kept as literal text; `<br>` becomes a hardBreak and
 *   `<sub>`, `<sup>`, `<u>` become the subsup / underline marks.
 * - An image alone in its paragraph becomes `mediaSingle > media` (external URL, or
 *   `media:<id>[?collection=c]` -> file media; a link around it becomes a link mark on the media).
 *   An image sharing a paragraph with text stays inline so the paragraph is not split: a file image
 *   becomes `mediaInline`, an external one a link on its alt text. In headings and task items every
 *   image degrades to a link.
 * - Bare `http(s)://` URLs are linked, including ones with balanced parentheses.
 * - Links with an empty or whitespace destination are plain text.
 * - Soft line breaks become a space; `\` + newline or two trailing spaces become hardBreak.
 * - Tabs inside fenced code are preserved (the parser would expand them to spaces).
 * - The `code` mark is only combined with `link` (ADF forbids other marks on code).
 * - ADF forbids some children in containers, so they are moved or rewritten without loss of text:
 *   a table or task list inside a blockquote, and a table inside a list item, are placed after
 *   the item (the quote or list is split there); headings, rules and nested quotes inside
 *   blockquote/listItem become bold paragraphs / lifted. A taskItem holds inline content only:
 *   code fences, tables, quotes and plain nested lists inside one are placed after it (the task
 *   list is split there); nested task items become nested taskLists. A task list has no numbering,
 *   so `1. [ ] x` becomes an unordered task list.
 * - Table column alignment is parsed but not emitted: ADF table cells have no alignment attribute.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const source = markdown.replaceAll(/\r\n?/g, "\n");
  const protect = source.includes("\t") && !source.includes(TAB_SENTINEL);
  const root: unknown = Bun.markdown.react(
    protect ? protectFenceTabs(source) : source,
    {},
    OPTIONS,
  );
  const content = blocks(isElement(root) ? childrenOf(root) : []);
  if (protect) {
    restoreTabs(content);
  }
  return { type: "doc", version: 1, content };
}

const OPTIONS: Bun.markdown.ReactOptions = { autolinks: true };

/**
 * md4c expands tabs in code to spaces. Tabs inside fenced code are swapped for a Unicode
 * noncharacter before parsing and swapped back in the codeBlock text afterwards; a source that
 * already contains the sentinel keeps the parser's expansion.
 */
const TAB_SENTINEL = "\uFDD0";

/** Opener: container prefix (indent, quote markers, list markers), then the fence. */
const FENCE_OPEN = /^([ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*)(`{3,}|~{3,})(.*)$/;

function protectFenceTabs(source: string): string {
  let fence: { prefix: number; char: string; length: number } | undefined;
  return source
    .split("\n")
    .map((line) => {
      if (fence === undefined) {
        const open = FENCE_OPEN.exec(line);
        const [, prefix = "", ticks = "", info = ""] = open ?? [];
        if (open !== null && !(ticks.startsWith("`") && info.includes("`"))) {
          fence = { prefix: prefix.length, char: ticks.charAt(0), length: ticks.length };
        }
        return line;
      }
      const rest = line.slice(fence.prefix).trim();
      if (rest.length >= fence.length && rest === fence.char.repeat(rest.length)) {
        fence = undefined;
        return line;
      }
      return line.slice(0, fence.prefix) + line.slice(fence.prefix).replaceAll("\t", TAB_SENTINEL);
    })
    .join("\n");
}

function restoreTabs(nodes: AdfNode[]): void {
  for (const node of nodes) {
    if (node.type === "codeBlock") {
      for (const child of node.content ?? []) {
        if (child.text !== undefined) {
          child.text = child.text.replaceAll(TAB_SENTINEL, "\t");
        }
      }
    } else {
      restoreTabs(node.content ?? []);
    }
  }
}

type ImageMode = "media" | "link";

// ---------------------------------------------------------------------------
// Element tree
// ---------------------------------------------------------------------------

interface MdElement {
  type: unknown;
  props: Record<string, unknown>;
}

type MdChild = string | MdElement;

function isElement(value: unknown): value is MdElement {
  return isRecord(value) && "type" in value && isRecord(value.props);
}

function collect(value: unknown, out: MdChild[]): MdChild[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, out);
    }
  } else if (isElement(value)) {
    out.push(value);
  }
  return out;
}

function childrenOf(element: MdElement): MdChild[] {
  return collect(element.props.children, []);
}

const ATTR_ESCAPE = /\\([!-/:-@[-`{-~])|&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi;
const ATTR_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** `Bun.markdown` leaves backslash escapes and entities undecoded in link/image attributes. */
function unescapeAttr(value: string): string {
  return value.replaceAll(
    ATTR_ESCAPE,
    (match, escaped?: string, hex?: string, dec?: string, named?: string) => {
      if (escaped !== undefined) {
        return escaped;
      }
      if (named !== undefined) {
        return ATTR_ENTITY[named.toLowerCase()] ?? match;
      }
      const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "\uFFFD"
        : String.fromCodePoint(code);
    },
  );
}

/** Tag name (`"p"`, `"ul"`, ...); fragments and components yield `""`. */
function tagOf(element: MdElement): string {
  return typeof element.type === "string" ? element.type : "";
}

function stringProp(element: MdElement, name: string): string | undefined {
  const value = element.props[name];
  return typeof value === "string" ? value : undefined;
}

function plainText(children: MdChild[]): string {
  let text = "";
  for (const child of children) {
    text += typeof child === "string" ? child : plainText(childrenOf(child));
  }
  return text;
}

const BLOCK_TAGS: Record<string, true> = {
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  p: true,
  pre: true,
  blockquote: true,
  ul: true,
  ol: true,
  li: true,
  hr: true,
  table: true,
  thead: true,
  tbody: true,
  tr: true,
  th: true,
  td: true,
  html: true,
};

function isBlock(child: MdChild): child is MdElement {
  return typeof child !== "string" && Object.hasOwn(BLOCK_TAGS, tagOf(child));
}

/** Tight list items hold inline content directly; group it into runs between block children. */
function eachBlock(children: MdChild[], visit: (block: MdElement | MdChild[]) => void): void {
  let run: MdChild[] = [];
  for (const child of children) {
    if (isBlock(child)) {
      if (run.length > 0) {
        visit(run);
        run = [];
      }
      visit(child);
    } else {
      run.push(child);
    }
  }
  if (run.length > 0) {
    visit(run);
  }
}

// ---------------------------------------------------------------------------
// ADF builders
// ---------------------------------------------------------------------------

function make(type: string, attrs?: Record<string, unknown>, content?: AdfNode[]): AdfNode {
  const node: AdfNode = { type };
  if (attrs !== undefined) {
    node.attrs = attrs;
  }
  if (content !== undefined) {
    node.content = content;
  }
  return node;
}

function emptyParagraph(): AdfNode {
  return make("paragraph", undefined, []);
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  const node: AdfNode = { type: "text", text };
  const finalMarks = marks.some((mark) => mark.type === "code")
    ? marks.filter((mark) => mark.type === "code" || mark.type === "link")
    : marks;
  if (finalMarks.length > 0) {
    node.marks = finalMarks;
  }
  return node;
}

function addMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  return [...marks.filter((existing) => existing.type !== mark.type), mark];
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function mergeText(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (
      node.type === "text" &&
      last?.type === "text" &&
      JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      last.text = (last.text ?? "") + (node.text ?? "");
    } else {
      out.push(node);
    }
  }
  return out;
}

function imageNode(href: string, alt: string, link: AdfMark | undefined): AdfNode {
  let media: AdfNode;
  if (href.startsWith("media:")) {
    const [id = "", query = ""] = href.slice("media:".length).split("?", 2);
    const collection = new URLSearchParams(query).get("collection") ?? "";
    const attrs: Record<string, unknown> = { type: "file", id, collection };
    if (alt !== "" && alt !== "file") {
      attrs.alt = alt;
    }
    media = make("media", attrs);
  } else {
    const attrs: Record<string, unknown> = { type: "external", url: href };
    if (alt !== "") {
      attrs.alt = alt;
    }
    media = make("media", attrs);
  }
  if (link !== undefined) {
    media.marks = [link];
  }
  return make("mediaSingle", { layout: "center" }, [media]);
}

/** A block image that shares its paragraph with text, in inline form. */
function inlineImage(single: AdfNode): AdfNode {
  const media = single.content?.[0];
  const attrs = media?.attrs ?? {};
  const link = media?.marks?.find((mark) => mark.type === "link");
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  if (attrs.type === "file") {
    return make("mediaInline", { type: "file", id: attrs.id, collection: attrs.collection });
  }
  const url = typeof attrs.url === "string" ? attrs.url : "";
  return textNode(alt === "" ? url : alt, [link ?? { type: "link", attrs: { href: url } }]);
}

/** GFM extended autolinks arrive without a scheme (`www.x.y`, `me@x.y`); give them one. */
function autolinkHref(href: string, children: MdChild[]): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || plainText(children) !== href) {
    return href;
  }
  if (/^www\./i.test(href)) {
    return `http://${href}`;
  }
  return href.includes("@") ? `mailto:${href}` : href;
}

const BR_HTML = /^<br\s*\/?>$/i;

const MARK_TAG = /^<(\/?)(sub|sup|u)>$/i;
const TAG_MARKS: Record<string, AdfMark> = {
  sub: { type: "subsup", attrs: { type: "sub" } },
  sup: { type: "subsup", attrs: { type: "sup" } },
  u: { type: "underline" },
};

/** Start of a URL the parser left as text: after a non-word character, with a host character next. */
const URL_START = /(?<![\p{L}\p{N}_])https?:\/\/(?=[\p{L}\p{N}-])/iu;

/** GFM: trailing punctuation is not part of the URL, and a `)` only if its `(` is inside it. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last !== undefined && /[?!.,:;*~'"_]/.test(last)) {
      url = url.slice(0, -1);
    } else if (last === ")" && url.split(")").length > url.split("(").length) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

/**
 * `Bun.markdown` does not link URLs that contain parentheses, and an underscore before `(` splits
 * the text around an emphasis delimiter. An unescaped `scheme://` left in text is such a URL (an
 * escaped `https\://` is split by the parser and never matches): link it here, gathering the
 * text pieces that follow until whitespace.
 */
function linkBareUrls(children: MdChild[]): MdChild[] {
  const out: MdChild[] = [];
  for (let index = 0; index < children.length;) {
    const child = children[index];
    index += 1;
    if (typeof child !== "string") {
      if (child !== undefined) {
        out.push(child);
      }
      continue;
    }
    let text = child;
    for (let start = text.search(URL_START); start !== -1; start = text.search(URL_START)) {
      let rest = text.slice(start);
      for (
        let next = children[index];
        typeof next === "string" && !/[\s<]/.test(rest);
        next = children[index]
      ) {
        rest += next;
        index += 1;
      }
      const url = trimUrl(rest.slice(0, rest.search(/[\s<]|$/)));
      if (start > 0) {
        out.push(text.slice(0, start));
      }
      out.push({ type: "a", props: { href: url, bare: true, children: [url] } });
      text = rest.slice(url.length);
    }
    if (text !== "") {
      out.push(text);
    }
  }
  return out;
}

function inline(children: MdChild[], marks: AdfMark[], images: ImageMode): AdfNode[] {
  const out: AdfNode[] = [];
  let current = marks;
  const text = (value: string, withMarks: AdfMark[] = current): void => {
    if (value.length > 0) {
      out.push(textNode(value, withMarks));
    }
  };
  const linked = marks.some((mark) => mark.type === "link");
  for (const child of linked ? children : linkBareUrls(children)) {
    if (typeof child === "string") {
      const tag = MARK_TAG.exec(child);
      const tagMark = tag === null ? undefined : TAG_MARKS[(tag[2] ?? "").toLowerCase()];
      if (BR_HTML.test(child)) {
        out.push({ type: "hardBreak" });
      } else if (tag !== null && tagMark !== undefined) {
        current =
          tag[1] === "/"
            ? current.filter(
                (mark) => mark.type !== tagMark.type || mark.attrs?.type !== tagMark.attrs?.type,
              )
            : addMark(current, tagMark);
      } else {
        text(child.replaceAll(/[ \t]*\n[ \t]*/g, " "));
      }
      continue;
    }
    const nested = childrenOf(child);
    switch (tagOf(child)) {
      case "strong":
        out.push(...inline(nested, addMark(current, { type: "strong" }), images));
        break;
      case "em":
        out.push(...inline(nested, addMark(current, { type: "em" }), images));
        break;
      case "del":
        out.push(...inline(nested, addMark(current, { type: "strike" }), images));
        break;
      case "code":
        text(plainText(nested).replaceAll("\n", " "), addMark(current, { type: "code" }));
        break;
      case "a": {
        const raw = stringProp(child, "href") ?? "";
        const href = autolinkHref(child.props.bare === true ? raw : unescapeAttr(raw), nested);
        if (href === "" || /\s/.test(href)) {
          out.push(...inline(nested, current, images));
          break;
        }
        const attrs: Record<string, unknown> = { href };
        const title = unescapeAttr(stringProp(child, "title") ?? "");
        if (title !== "") {
          attrs.title = title;
        }
        const withLink = addMark(current, { type: "link", attrs });
        const content = inline(nested, withLink, images);
        if (content.length > 0) {
          out.push(...content);
        } else {
          text(href, withLink);
        }
        break;
      }
      case "img": {
        const src = unescapeAttr(stringProp(child, "src") ?? "");
        const alt = stringProp(child, "alt") ?? "";
        const link = current.find((mark) => mark.type === "link");
        if (images === "media") {
          out.push(imageNode(src, alt, link));
        } else if (src.startsWith("media:")) {
          text(alt === "" ? "file" : alt);
        } else {
          const withLink =
            link === undefined ? addMark(current, { type: "link", attrs: { href: src } }) : current;
          text(alt === "" ? src : alt, withLink);
        }
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      default:
        out.push(...inline(nested, current, images));
    }
  }
  return mergeText(out);
}

function trimBreaks(nodes: AdfNode[]): AdfNode[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && nodes[start]?.type === "hardBreak") {
    start += 1;
  }
  while (end > start && nodes[end - 1]?.type === "hardBreak") {
    end -= 1;
  }
  return nodes.slice(start, end);
}

function isBlank(nodes: AdfNode[]): boolean {
  return nodes.every((node) => node.type === "text" && (node.text ?? "").trim() === "");
}

/**
 * Inline nodes -> paragraph(s). An image alone in its paragraph is hoisted out as a block
 * (mediaSingle); one that shares the paragraph with text stays inline so the paragraph is not split.
 */
function toParagraphs(nodes: AdfNode[]): AdfNode[] {
  const hasImage = nodes.some((node) => node.type === "mediaSingle");
  if (
    hasImage &&
    !nodes.every(
      (node) => node.type === "mediaSingle" || node.type === "hardBreak" || isBlank([node]),
    )
  ) {
    const content = trimBreaks(
      nodes.map((node) => (node.type === "mediaSingle" ? inlineImage(node) : node)),
    );
    return [make("paragraph", undefined, content)];
  }
  const out: AdfNode[] = [];
  let run: AdfNode[] = [];
  const flush = (): void => {
    const trimmed = trimBreaks(run);
    if (trimmed.length > 0 && !isBlank(trimmed)) {
      out.push(make("paragraph", undefined, trimmed));
    }
    run = [];
  };
  for (const node of nodes) {
    if (node.type === "mediaSingle") {
      flush();
      out.push(node);
    } else {
      run.push(node);
    }
  }
  flush();
  return out;
}

function paragraphsOf(children: MdChild[]): AdfNode[] {
  return toParagraphs(inline(children, [], "media"));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function boldParagraph(content: AdfNode[]): AdfNode {
  const bold = content.map((node) =>
    node.type === "text" && !(node.marks ?? []).some((mark) => mark.type === "code")
      ? textNode(node.text ?? "", addMark(node.marks ?? [], { type: "strong" }))
      : node,
  );
  return make("paragraph", undefined, bold);
}

/** Rewrite children that ADF does not allow inside blockquote / listItem. */
function restrictChildren(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    if (node.type === "heading") {
      out.push(boldParagraph(node.content ?? []));
    } else if (node.type === "rule") {
      out.push(make("paragraph", undefined, [textNode("---", [])]));
    } else if (node.type === "blockquote") {
      out.push(...restrictChildren(node.content ?? []));
    } else {
      out.push(node);
    }
  }
  return out;
}

/** The quote, split where a forbidden child sits so the child follows the text before it. */
function quoteNodes(children: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  let kept: AdfNode[] = [];
  for (const node of restrictChildren(children)) {
    if (node.type === "table" || node.type === "taskList") {
      if (kept.length > 0) {
        out.push(make("blockquote", undefined, kept));
        kept = [];
      }
      out.push(node);
    } else {
      kept.push(node);
    }
  }
  if (kept.length > 0 || out.length === 0) {
    out.push(make("blockquote", undefined, kept.length > 0 ? kept : [emptyParagraph()]));
  }
  return out;
}

function codeBlock(element: MdElement): AdfNode {
  const language = stringProp(element, "language");
  const attrs = language === undefined || language === "" ? undefined : { language };
  // Drop the last line's terminator, then one blank line left before the closing fence.
  const code = plainText(childrenOf(element)).replace(/\n$/, "").replace(/\n$/, "");
  const content = code.length > 0 ? [{ type: "text", text: code }] : undefined;
  return make("codeBlock", attrs, content);
}

function rawHtml(raw: string): AdfNode | undefined {
  const lines = raw.replace(/\s+$/, "").split("\n");
  const nodes: AdfNode[] = [];
  for (const line of lines) {
    if (nodes.length > 0) {
      nodes.push({ type: "hardBreak" });
    }
    if (line.length > 0) {
      nodes.push(textNode(line, []));
    }
  }
  return nodes.length === 0 ? undefined : make("paragraph", undefined, nodes);
}

function newId(): string {
  return crypto.randomUUID();
}

function listItemsOf(list: MdElement): MdElement[] {
  return childrenOf(list).filter(
    (child): child is MdElement => typeof child !== "string" && tagOf(child) === "li",
  );
}

/**
 * A taskItem holds inline content only: lists that are not task lists and every other block
 * (code, table, quote, ...) are placed after the item, splitting the taskList there.
 */
function taskListOf(items: MdElement[]): AdfNode[] {
  const out: AdfNode[] = [];
  let content: AdfNode[] = [];
  for (const item of items) {
    let body: AdfNode[] = [];
    const nested: AdfNode[] = [];
    const hoisted: AdfNode[] = [];
    const append = (nodes: AdfNode[]): void => {
      if (nodes.length > 0) {
        if (body.length > 0) {
          body.push({ type: "hardBreak" });
        }
        body.push(...nodes);
      }
    };
    eachBlock(childrenOf(item), (block) => {
      if (Array.isArray(block)) {
        append(trimBreaks(inline(block, [], "link")));
        return;
      }
      const tag = tagOf(block);
      if (tag === "p") {
        append(trimBreaks(inline(childrenOf(block), [], "link")));
      } else if (tag === "ul" || tag === "ol") {
        for (const list of listNodes(block)) {
          (list.type === "taskList" ? nested : hoisted).push(list);
        }
      } else {
        hoisted.push(...blocks([block]));
      }
    });
    const first = body[0];
    if (first?.type === "text" && first.text !== undefined) {
      body = [{ ...first, text: first.text.replace(/^\s+/, "") }, ...body.slice(1)].filter(
        (node) => node.type !== "text" || (node.text ?? "") !== "",
      );
    }
    const attrs = { localId: newId(), state: item.props.checked === true ? "DONE" : "TODO" };
    content.push(make("taskItem", attrs, body.length > 0 ? body : undefined), ...nested);
    if (hoisted.length > 0) {
      out.push(make("taskList", { localId: newId() }, content), ...hoisted);
      content = [];
    }
  }
  if (content.length > 0) {
    out.push(make("taskList", { localId: newId() }, content));
  }
  return out;
}

/**
 * Lists. A table inside an item cannot stay in a listItem, so the list is split after that item
 * and the table follows it (ordered numbering continues in the second part).
 */
function listNodes(list: MdElement): AdfNode[] {
  const runs: { task: boolean; items: MdElement[] }[] = [];
  for (const item of listItemsOf(list)) {
    const task = typeof item.props.checked === "boolean";
    const last = runs.at(-1);
    if (last !== undefined && last.task === task) {
      last.items.push(item);
    } else {
      runs.push({ task, items: [item] });
    }
  }
  const ordered = tagOf(list) === "ol";
  const start = list.props.start;
  const out: AdfNode[] = [];
  let order = typeof start === "number" ? start : 1;
  for (const run of runs) {
    if (run.task) {
      out.push(...taskListOf(run.items));
      order += run.items.length;
      continue;
    }
    let items: AdfNode[] = [];
    const flush = (): void => {
      if (items.length > 0) {
        out.push(
          ordered
            ? make("orderedList", order === 1 ? undefined : { order }, items)
            : make("bulletList", undefined, items),
        );
        order += items.length;
        items = [];
      }
    };
    for (const item of run.items) {
      const children = restrictChildren(blocks(childrenOf(item)));
      const kept = children.filter((node) => node.type !== "table");
      items.push(make("listItem", undefined, kept.length > 0 ? kept : [emptyParagraph()]));
      if (kept.length < children.length) {
        flush();
        out.push(...children.filter((node) => node.type === "table"));
      }
    }
    flush();
  }
  return out;
}

function tableNode(table: MdElement): AdfNode {
  const rows: AdfNode[] = [];
  const visit = (element: MdElement): void => {
    for (const child of childrenOf(element)) {
      if (typeof child === "string") {
        continue;
      }
      const tag = tagOf(child);
      if (tag === "thead" || tag === "tbody") {
        visit(child);
      } else if (tag === "tr") {
        const cells = childrenOf(child).filter(
          (cell): cell is MdElement => typeof cell !== "string",
        );
        rows.push(
          make(
            "tableRow",
            undefined,
            cells.map((cell) => {
              const paragraphs = paragraphsOf(childrenOf(cell));
              return make(
                tagOf(cell) === "th" ? "tableHeader" : "tableCell",
                undefined,
                paragraphs.length > 0 ? paragraphs : [emptyParagraph()],
              );
            }),
          ),
        );
      }
    }
  };
  visit(table);
  return make("table", undefined, rows);
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

function blocks(children: MdChild[]): AdfNode[] {
  const out: AdfNode[] = [];
  eachBlock(children, (block) => {
    if (Array.isArray(block)) {
      out.push(...paragraphsOf(block));
      return;
    }
    const tag = tagOf(block);
    const level = HEADING_LEVEL[tag];
    if (level !== undefined) {
      out.push(make("heading", { level }, trimBreaks(inline(childrenOf(block), [], "link"))));
      return;
    }
    switch (tag) {
      case "p":
        out.push(...paragraphsOf(childrenOf(block)));
        break;
      case "pre":
        out.push(codeBlock(block));
        break;
      case "blockquote":
        out.push(...quoteNodes(blocks(childrenOf(block))));
        break;
      case "ul":
      case "ol":
        out.push(...listNodes(block));
        break;
      case "hr":
        out.push(make("rule"));
        break;
      case "table":
        out.push(tableNode(block));
        break;
      default: {
        const paragraph = rawHtml(plainText(childrenOf(block)));
        if (paragraph !== undefined) {
          out.push(paragraph);
        }
      }
    }
  });
  return out;
}
