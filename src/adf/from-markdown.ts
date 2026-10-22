import { isRecord } from "../core/guards.ts";
import { adfToMarkdown } from "./to-markdown.ts";
import type { AdfDoc, AdfMark, AdfNode } from "./types.ts";

/**
 * Markdown (CommonMark + GFM, parsed natively by `Bun.markdown`) -> ADF.
 *
 * `Bun.markdown.react` yields a plain element tree (`{ type: "p" | "ul" | ..., props: { children } }`)
 * with entities already decoded; it is walked here without React.
 *
 * Choices worth knowing:
 * - Raw HTML (block or inline) is kept as literal text; `<br>` becomes a hardBreak.
 * - Images become `mediaSingle > media` (external URL, or `media:<id>[?collection=c]` -> file media);
 *   an image in the middle of a paragraph splits it, and inside headings/task items it degrades to a link.
 * - Soft line breaks become a space; `\` + newline or two trailing spaces become hardBreak.
 * - The `code` mark is only combined with `link` (ADF forbids other marks on code).
 * - Task items that nest lists produce nested taskLists; blockquote/listItem children that ADF forbids
 *   (headings, rules, nested quotes) are rewritten to bold paragraphs / lifted.
 * - Table column alignment is parsed but not emitted: ADF table cells have no alignment attribute.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const root: unknown = Bun.markdown.react(markdown.replaceAll(/\r\n?/g, "\n"), {}, OPTIONS);
  return { type: "doc", version: 1, content: blocks(isElement(root) ? childrenOf(root) : []) };
}

const OPTIONS: Bun.markdown.ReactOptions = { autolinks: true };

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

function imageNode(href: string, alt: string): AdfNode {
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
  return make("mediaSingle", { layout: "center" }, [media]);
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

function inline(children: MdChild[], marks: AdfMark[], images: ImageMode): AdfNode[] {
  const out: AdfNode[] = [];
  const text = (value: string, withMarks: AdfMark[] = marks): void => {
    if (value.length > 0) {
      out.push(textNode(value, withMarks));
    }
  };
  for (const child of children) {
    if (typeof child === "string") {
      if (BR_HTML.test(child)) {
        out.push({ type: "hardBreak" });
      } else {
        text(child.replaceAll(/[ \t]*\n[ \t]*/g, " "));
      }
      continue;
    }
    const nested = childrenOf(child);
    switch (tagOf(child)) {
      case "strong":
        out.push(...inline(nested, addMark(marks, { type: "strong" }), images));
        break;
      case "em":
        out.push(...inline(nested, addMark(marks, { type: "em" }), images));
        break;
      case "del":
        out.push(...inline(nested, addMark(marks, { type: "strike" }), images));
        break;
      case "code":
        text(plainText(nested).replaceAll("\n", " "), addMark(marks, { type: "code" }));
        break;
      case "a": {
        const href = autolinkHref(unescapeAttr(stringProp(child, "href") ?? ""), nested);
        const attrs: Record<string, unknown> = { href };
        const title = unescapeAttr(stringProp(child, "title") ?? "");
        if (title !== "") {
          attrs.title = title;
        }
        const linked = addMark(marks, { type: "link", attrs });
        const content = inline(nested, linked, images);
        if (content.length > 0) {
          out.push(...content);
        } else {
          text(href, linked);
        }
        break;
      }
      case "img": {
        const src = unescapeAttr(stringProp(child, "src") ?? "");
        const alt = stringProp(child, "alt") ?? "";
        if (images === "media") {
          out.push(imageNode(src, alt));
        } else if (src.startsWith("media:")) {
          text(alt === "" ? "file" : alt);
        } else {
          const link: AdfMark = { type: "link", attrs: { href: src } };
          text(alt === "" ? src : alt, addMark(marks, link));
        }
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      default:
        out.push(...inline(nested, marks, images));
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

/** Inline nodes -> paragraph(s); media nodes are hoisted out as blocks, splitting the paragraph. */
function toParagraphs(nodes: AdfNode[]): AdfNode[] {
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
  return out.length > 0 ? out : [emptyParagraph()];
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

function taskListOf(items: MdElement[]): AdfNode {
  const content: AdfNode[] = [];
  for (const item of items) {
    let body: AdfNode[] = [];
    const nested: AdfNode[] = [];
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
        nested.push(taskListOf(listItemsOf(block)));
      } else {
        // taskItem holds inline content only: keep any other block as its markdown text.
        const markdown = adfToMarkdown({ type: "doc", version: 1, content: blocks([block]) });
        append(markdown === "" ? [] : [textNode(markdown, [])]);
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
  }
  return make("taskList", { localId: newId() }, content);
}

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
      out.push(taskListOf(run.items));
      order += run.items.length;
      continue;
    }
    const items = run.items.map((item) =>
      make("listItem", undefined, restrictChildren(blocks(childrenOf(item)))),
    );
    if (ordered) {
      out.push(make("orderedList", order === 1 ? undefined : { order }, items));
      order += run.items.length;
    } else {
      out.push(make("bulletList", undefined, items));
    }
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
        out.push(make("blockquote", undefined, restrictChildren(blocks(childrenOf(block)))));
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
