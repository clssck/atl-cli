/**
 * Offline structural checks for Confluence storage XHTML: an inventory of what a body contains
 * (macros, mentions, links, headings, ...) so a rewrite can be compared with the page it replaces,
 * and a hygiene scan for content that should not be saved by accident. Regex-level on purpose:
 * storage is XHTML with `ac:`/`ri:` namespaces and the inventory only needs tag names and attribute
 * values. Volatile ids (`ac:macro-id`, `ac:local-id`, `ri:version-at-save`) are never captured.
 */
import { decodeEntities } from "./entities.ts";
import type { AdfDoc, AdfNode } from "./types.ts";

export type InventoryCategory =
  | "macros"
  | "mentions"
  | "attachments"
  | "pageLinks"
  | "links"
  | "dates"
  | "tasks"
  | "headings"
  | "layouts"
  | "adfNodes";

/** Item name to occurrence count, per category; categories with no items are absent. */
export type Inventory = Partial<Record<InventoryCategory, Record<string, number>>>;

export interface InventoryDelta {
  removed: Inventory;
  added: Inventory;
}

const CATEGORIES: readonly InventoryCategory[] = [
  "macros",
  "mentions",
  "attachments",
  "pageLinks",
  "links",
  "dates",
  "tasks",
  "headings",
  "layouts",
  "adfNodes",
];

const TASK_TEXT_MAX = 60;
const LIST_MAX = 10;

/** An opening tag of interest; attribute values may contain `>`. */
const OPEN_TAG =
  /<(ac:structured-macro|ri:user|ri:attachment|ri:page|ri:url|a|time|ac:layout-section|ac:adf-node)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const HEADING = /<h([1-6])(?=[\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>([\s\S]*?)<\/h\1>/g;
const TASK = /<ac:task>([\s\S]*?)<\/ac:task>/g;
const TASK_BODY = /<ac:task-body>([\s\S]*?)<\/ac:task-body>/;
const CDATA = /<!\[CDATA\[[\s\S]*?\]\]>/g;

/** Value of attribute `name` in a tag's attribute text, entity-decoded. */
function attr(attrs: string, name: string): string | undefined {
  const found = new RegExp(`(?<![\\w:.-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  const value = found?.[1] ?? found?.[2];
  return value === undefined ? undefined : decodeEntities(value);
}

/** Visible text of an XHTML fragment: tags dropped, entities decoded, whitespace collapsed. */
function plainText(fragment: string): string {
  return decodeEntities(fragment.replaceAll(/<[^>]*>/g, ""))
    .replaceAll(/\s+/g, " ")
    .trim();
}

function tally(
  counts: Map<InventoryCategory, Map<string, number>>,
  category: InventoryCategory,
  item: string | undefined,
): void {
  if (item === undefined || item === "") {
    return;
  }
  const items = counts.get(category) ?? new Map<string, number>();
  items.set(item, (items.get(item) ?? 0) + 1);
  counts.set(category, items);
}

/** What a storage body contains, as counts per category. */
export function storageInventory(xhtml: string): Inventory {
  const counts = new Map<InventoryCategory, Map<string, number>>();
  for (const match of xhtml.matchAll(OPEN_TAG)) {
    const tag = match[1];
    const attrs = match[2] ?? "";
    if (tag === "ac:structured-macro") {
      tally(counts, "macros", attr(attrs, "ac:name"));
    } else if (tag === "ri:user") {
      tally(counts, "mentions", attr(attrs, "ri:account-id"));
    } else if (tag === "ri:attachment") {
      tally(counts, "attachments", attr(attrs, "ri:filename"));
    } else if (tag === "ri:page") {
      const title = attr(attrs, "ri:content-title");
      const space = attr(attrs, "ri:space-key");
      tally(
        counts,
        "pageLinks",
        title === undefined || space === undefined ? title : `${space}:${title}`,
      );
    } else if (tag === "a") {
      tally(counts, "links", attr(attrs, "href"));
    } else if (tag === "ri:url") {
      tally(counts, "links", attr(attrs, "ri:value"));
    } else if (tag === "time") {
      tally(counts, "dates", attr(attrs, "datetime"));
    } else if (tag === "ac:layout-section") {
      tally(counts, "layouts", attr(attrs, "ac:type") ?? "section");
    } else {
      tally(counts, "adfNodes", attr(attrs, "type"));
    }
  }
  for (const match of xhtml.matchAll(HEADING)) {
    tally(counts, "headings", `h${match[1]} ${plainText(match[2] ?? "")}`.trim());
  }
  for (const match of xhtml.matchAll(TASK)) {
    const text = plainText(TASK_BODY.exec(match[1] ?? "")?.[1] ?? "");
    tally(counts, "tasks", text === "" ? "task" : text.slice(0, TASK_TEXT_MAX));
  }
  const inventory: Inventory = {};
  for (const category of CATEGORIES) {
    const items = counts.get(category);
    if (items !== undefined) {
      inventory[category] = Object.fromEntries(items);
    }
  }
  return inventory;
}

/** Items (with counts) in `before` beyond what `after` has, and the reverse; empty categories are absent. */
export function inventoryDelta(before: Inventory, after: Inventory): InventoryDelta {
  const removed: Inventory = {};
  const added: Inventory = {};
  for (const category of CATEGORIES) {
    const old = before[category] ?? {};
    const next = after[category] ?? {};
    const gone: Record<string, number> = {};
    const fresh: Record<string, number> = {};
    for (const item of new Set([...Object.keys(old), ...Object.keys(next)])) {
      const change = (old[item] ?? 0) - (next[item] ?? 0);
      if (change > 0) {
        gone[item] = change;
      } else if (change < 0) {
        fresh[item] = -change;
      }
    }
    if (Object.keys(gone).length > 0) {
      removed[category] = gone;
    }
    if (Object.keys(fresh).length > 0) {
      added[category] = fresh;
    }
  }
  return { removed, added };
}

/** One line per inventory for a warning: `macros: toc, jira x2; headings: h2 Intro`, long lists cut. */
export function describeInventory(inventory: Inventory): string {
  return CATEGORIES.flatMap((category) => {
    const items = Object.entries(inventory[category] ?? {});
    if (items.length === 0) {
      return [];
    }
    const shown = items
      .slice(0, LIST_MAX)
      .map(([item, count]) => (count > 1 ? `${item} x${count}` : item));
    const more = items.length > LIST_MAX ? [`+${items.length - LIST_MAX} more`] : [];
    return [`${category}: ${[...shown, ...more].join(", ")}`];
  }).join("; ");
}

/** `data:` or `file:` when a URL value starts with that scheme (browsers ignore leading and embedded control characters). */
function unsafeScheme(value: string): "data:" | "file:" | undefined {
  const flat = decodeEntities(value)
    .replaceAll(/[\p{Cc}\s]/gu, "")
    .toLowerCase();
  return flat.startsWith("data:") ? "data:" : flat.startsWith("file:") ? "file:" : undefined;
}

const URL_ATTR = /(?<![\w:.-])(href|src|ri:value)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Findings in a storage body: script or style elements, and `data:`/`file:` values in href, src and ri:url. CDATA is plain text. */
export function storageHygiene(xhtml: string): string[] {
  const markup = xhtml.replaceAll(CDATA, "");
  const found = new Set<string>();
  if (/<\s*script(?=[\s/>])/i.test(markup)) {
    found.add("<script>");
  }
  if (/<\s*style(?=[\s/>])/i.test(markup)) {
    found.add("<style>");
  }
  for (const match of markup.matchAll(URL_ATTR)) {
    const scheme = unsafeScheme(match[2] ?? match[3] ?? "");
    if (scheme !== undefined) {
      const name = (match[1] ?? "").toLowerCase();
      found.add(`${scheme} URL in ${name === "ri:value" ? "ri:url" : name}`);
    }
  }
  return [...found];
}

const URL_NODES: Readonly<Record<string, true>> = {
  media: true,
  inlineCard: true,
  embedCard: true,
};

function adfUrlFindings(nodes: readonly AdfNode[] | undefined, found: Set<string>): Set<string> {
  for (const node of nodes ?? []) {
    const url = node.attrs?.url;
    if (URL_NODES[node.type] === true && typeof url === "string") {
      const scheme = unsafeScheme(url);
      if (scheme !== undefined) {
        found.add(`${scheme} URL in ${node.type} url`);
      }
    }
    for (const mark of node.marks ?? []) {
      const href = mark.attrs?.href;
      if (mark.type === "link" && typeof href === "string") {
        const scheme = unsafeScheme(href);
        if (scheme !== undefined) {
          found.add(`${scheme} URL in link href`);
        }
      }
    }
    adfUrlFindings(node.content, found);
  }
  return found;
}

/** Findings in an ADF body: `data:`/`file:` URLs in link marks and media, inlineCard and embedCard nodes. */
export function adfHygiene(doc: AdfDoc): string[] {
  return [...adfUrlFindings(doc.content, new Set())];
}
