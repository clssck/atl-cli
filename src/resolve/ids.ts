import { AtlError } from "../core/errors.ts";

export type ConfluenceKind = "page" | "blogpost" | "comment" | "unknown-content";

export interface ConfluenceRef {
  kind: ConfluenceKind;
  id: string;
  site?: string;
  spaceKey?: string;
  commentId?: string;
  cloudId?: string;
}

export interface JiraRef {
  key?: string;
  id?: string;
  site?: string;
  cloudId?: string;
}

export interface SpaceRef {
  key?: string;
  id?: string;
}

export type AnyRef =
  | { product: "confluence"; ref: ConfluenceRef }
  | { product: "jira"; ref: JiraRef };

function inputError(code: string, message: string, hint?: string): AtlError {
  return new AtlError(
    message,
    hint === undefined ? { code, category: "input" } : { code, category: "input", hint },
  );
}

const NUMERIC = /^\d+$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SITE_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]+)-(\d+)$/;

/** Parse as URL when the input has a scheme or looks like `host/path`. */
function tryUrl(input: string): URL | undefined {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text);
    } catch {
      return undefined;
    }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\//i.test(text)) {
    try {
      return new URL(`https://${text}`);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseSite(input: string): string {
  const text = input.trim();
  const url = tryUrl(text);
  if (url !== undefined) {
    if (url.hostname !== "" && HOSTNAME.test(url.hostname.toLowerCase())) {
      return url.hostname.toLowerCase();
    }
    throw inputError("invalid_site", `Invalid site: ${input}`);
  }
  const lower = text.toLowerCase().replace(/\/+$/, "");
  if (SITE_LABEL.test(lower)) {
    return `${lower}.atlassian.net`;
  }
  if (HOSTNAME.test(lower)) {
    return lower;
  }
  throw inputError(
    "invalid_site",
    `Invalid site: ${input}`,
    "Use a site like acme or acme.atlassian.net",
  );
}

/* Tiny links: page id as 8-byte little-endian, base64, '/'->'-' '+'->'_', trailing '=' and 'A' stripped. */
const TINY_CHARS = /^[A-Za-z0-9_\-+/]+$/;

export function decodeTinyLink(tiny: string): string {
  const text = tiny.trim().replace(/=+$/, "");
  if (text === "" || text.length > 11 || !TINY_CHARS.test(text)) {
    throw inputError("invalid_tiny_link", `Invalid Confluence tiny link: ${tiny}`);
  }
  const b64 = `${text.replaceAll("-", "/").replaceAll("_", "+").padEnd(11, "A")}=`;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== 8) {
    throw inputError("invalid_tiny_link", `Invalid Confluence tiny link: ${tiny}`);
  }
  const id = bytes.readBigUInt64LE(0);
  if (id === 0n) {
    throw inputError("invalid_tiny_link", `Invalid Confluence tiny link: ${tiny}`);
  }
  return id.toString();
}

export function encodeTinyLink(id: string | number | bigint): string {
  const text = String(id);
  if (!NUMERIC.test(text)) {
    throw inputError("invalid_tiny_link", `Cannot encode non-numeric id: ${text}`);
  }
  const value = BigInt(text);
  if (value === 0n || value > 0xffffffffffffffffn) {
    throw inputError("invalid_tiny_link", `Id out of range for tiny link: ${text}`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value, 0);
  return bytes
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/A+$/, "")
    .replaceAll("/", "-")
    .replaceAll("+", "_");
}

interface Ari {
  product: string;
  cloudId: string;
  type: string;
  id: string;
}

function parseAri(input: string): Ari | undefined {
  const m = /^ari:cloud:([a-z-]+):([^:]*):([a-z-]+)\/(.+)$/i.exec(input.trim());
  if (m === null) {
    return undefined;
  }
  const [, product, cloudId, type, id] = m;
  if (product === undefined || cloudId === undefined || type === undefined || id === undefined) {
    return undefined;
  }
  return { product: product.toLowerCase(), cloudId, type: type.toLowerCase(), id };
}

function confluenceFromAri(ari: Ari, input: string): ConfluenceRef {
  const kinds: Record<string, ConfluenceKind> = {
    page: "page",
    blogpost: "blogpost",
    comment: "comment",
    content: "unknown-content",
  };
  const kind = kinds[ari.type];
  if (ari.product !== "confluence" || kind === undefined || !NUMERIC.test(ari.id)) {
    throw inputError("invalid_content_ref", `Unsupported Confluence ARI: ${input}`);
  }
  return { kind, id: ari.id, ...(ari.cloudId === "" ? {} : { cloudId: ari.cloudId }) };
}

function confluenceFromUrl(url: URL, input: string): ConfluenceRef {
  const site = url.hostname.toLowerCase();
  const segs = url.pathname
    .split("/")
    .filter((s) => s !== "")
    .map(decodeURIComponent);
  const focused = url.searchParams.get("focusedCommentId");
  const commentId = focused !== null && NUMERIC.test(focused) ? focused : undefined;
  const build = (kind: ConfluenceKind, id: string, spaceKey?: string): ConfluenceRef => ({
    kind,
    id,
    site,
    ...(spaceKey === undefined ? {} : { spaceKey }),
    ...(commentId === undefined ? {} : { commentId }),
  });
  const rest = segs[0] === "wiki" ? segs.slice(1) : segs;

  if (rest[0] === "spaces" && rest[1] !== undefined) {
    const spaceKey = rest[1];
    if (rest[2] === "pages") {
      const candidate = rest[3] === "edit-v2" || rest[3] === "edit" ? rest[4] : rest[3];
      if (candidate !== undefined && NUMERIC.test(candidate)) {
        return build("page", candidate, spaceKey);
      }
    }
    if (rest[2] === "blog") {
      const candidate = rest
        .slice(3)
        .find((s, i) => NUMERIC.test(s) && !isDatePart(rest.slice(3), i));
      if (candidate !== undefined) {
        return build("blogpost", candidate, spaceKey);
      }
    }
  }
  if (rest[0] === "pages" && (rest[1] === "viewpage.action" || rest[1] === "editpage.action")) {
    const pageId = url.searchParams.get("pageId");
    if (pageId !== null && NUMERIC.test(pageId)) {
      return build("page", pageId);
    }
  }
  if (rest[0] === "x" && rest[1] !== undefined) {
    return build("page", decodeTinyLink(rest[1]));
  }
  const pageId = url.searchParams.get("pageId");
  if (pageId !== null && NUMERIC.test(pageId)) {
    return build("page", pageId);
  }
  throw inputError("invalid_content_ref", `Unrecognized Confluence URL: ${input}`);
}

/** Blog URLs are /blog/YYYY/MM/DD/<id>; skip the date parts when present. */
function isDatePart(segs: readonly string[], index: number): boolean {
  const isDated =
    segs.length >= 4 &&
    /^\d{4}$/.test(segs[0] ?? "") &&
    /^\d{2}$/.test(segs[1] ?? "") &&
    /^\d{2}$/.test(segs[2] ?? "");
  return isDated && index < 3;
}

export function parseConfluenceRef(input: string): ConfluenceRef {
  const text = input.trim();
  if (NUMERIC.test(text)) {
    return { kind: "page", id: text };
  }
  const ari = parseAri(text);
  if (ari !== undefined) {
    return confluenceFromAri(ari, input);
  }
  const url = tryUrl(text);
  if (url !== undefined) {
    return confluenceFromUrl(url, input);
  }
  throw inputError(
    "invalid_content_ref",
    `Unrecognized Confluence reference: ${input}`,
    "Pass a page id, page URL, tiny link, or ARI",
  );
}

function normalizeKey(text: string): string | undefined {
  const upper = text.toUpperCase();
  return ISSUE_KEY.test(upper) ? upper : undefined;
}

export function parseJiraRef(input: string): JiraRef {
  const text = input.trim();
  const invalid = () =>
    inputError(
      "invalid_issue_ref",
      `Unrecognized Jira issue reference: ${input}`,
      "Pass an issue key like ABC-123, an id, URL, or ARI",
    );
  if (NUMERIC.test(text)) {
    return { id: text };
  }
  const key = normalizeKey(text);
  if (key !== undefined) {
    return { key };
  }
  const ari = parseAri(text);
  if (ari !== undefined) {
    if (ari.product !== "jira" || ari.type !== "issue" || !NUMERIC.test(ari.id)) {
      throw invalid();
    }
    return { id: ari.id, ...(ari.cloudId === "" ? {} : { cloudId: ari.cloudId }) };
  }
  const url = tryUrl(text);
  if (url === undefined) {
    throw invalid();
  }
  const site = url.hostname.toLowerCase();
  const selected = url.searchParams.get("selectedIssue");
  const selectedKey = selected === null ? undefined : normalizeKey(selected);
  if (selectedKey !== undefined) {
    return { key: selectedKey, site };
  }
  const segs = url.pathname
    .split("/")
    .filter((s) => s !== "")
    .map(decodeURIComponent);
  if (segs[0] === "browse" && segs[1] !== undefined) {
    const k = normalizeKey(segs[1]);
    if (k !== undefined) {
      return { key: k, site };
    }
  }
  if (segs[0] === "jira") {
    for (let i = segs.length - 1; i >= 0; i--) {
      const k = normalizeKey(segs[i] ?? "");
      if (k !== undefined) {
        return { key: k, site };
      }
    }
  }
  throw invalid();
}

function looksJiraPath(url: URL): boolean {
  const first = url.pathname.split("/").find((s) => s !== "");
  return first === "browse" || first === "jira" || url.searchParams.has("selectedIssue");
}

function looksConfluencePath(url: URL): boolean {
  const first = url.pathname.split("/").find((s) => s !== "");
  return first === "wiki";
}

export function parseAnyRef(input: string): AnyRef {
  const text = input.trim();
  if (NUMERIC.test(text)) {
    throw inputError(
      "ambiguous_ref",
      `Bare numeric id is ambiguous: ${input}`,
      "Use `atl page get <id>` for Confluence or `atl issue get <id>` for Jira",
    );
  }
  const ari = parseAri(text);
  if (ari !== undefined) {
    if (ari.product === "confluence") {
      return { product: "confluence", ref: parseConfluenceRef(text) };
    }
    if (ari.product === "jira") {
      return { product: "jira", ref: parseJiraRef(text) };
    }
    throw inputError("invalid_ref", `Unsupported ARI product: ${ari.product}`);
  }
  if (normalizeKey(text) !== undefined) {
    return { product: "jira", ref: parseJiraRef(text) };
  }
  const url = tryUrl(text);
  if (url !== undefined) {
    if (looksConfluencePath(url)) {
      return { product: "confluence", ref: parseConfluenceRef(text) };
    }
    if (looksJiraPath(url)) {
      return { product: "jira", ref: parseJiraRef(text) };
    }
  }
  throw inputError(
    "invalid_ref",
    `Unrecognized reference: ${input}`,
    "Pass a Confluence/Jira URL, ARI, or issue key",
  );
}

export function parseSpaceRef(input: string): SpaceRef {
  const text = input.trim();
  if (NUMERIC.test(text)) {
    return { id: text };
  }
  const url = tryUrl(text);
  if (url !== undefined) {
    const segs = url.pathname
      .split("/")
      .filter((s) => s !== "")
      .map(decodeURIComponent);
    const rest = segs[0] === "wiki" ? segs.slice(1) : segs;
    if (rest[0] === "spaces" && rest[1] !== undefined) {
      return { key: rest[1] };
    }
    throw inputError("invalid_space_ref", `Unrecognized space URL: ${input}`);
  }
  if (/^~?[A-Za-z0-9_-]+$/.test(text)) {
    return { key: text };
  }
  throw inputError(
    "invalid_space_ref",
    `Invalid space reference: ${input}`,
    "Pass a space key, id, or space URL",
  );
}
