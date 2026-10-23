#!/usr/bin/env bun
/**
 * Seed the "abyss" Confluence scenarios (n46, n47) through the frozen atl binary and write
 * eval/.out/nightmare/abyss-confluence.json (page ids, issue keys, answers computed from live read-back, decoys).
 *
 * Usage: bun eval/nightmare/seed-abyss-confluence.ts
 *
 * Pages live under "atl smoke nm abyss" in SZOFTVERFE (parent: the nightmare wiki root 1572892); the hub is only found
 * or created, never rewritten, because other abyss seeders may share it. Issues live in KAN. Idempotent: pages are
 * found by exact title among the children of their parent, issues by exact summary; only missing pages and issues,
 * drifted bodies and labels, and missing or drifted web links are written. The token has no Confluence delete scope,
 * so the owner removes the tree in the UI by the "atl smoke nm abyss " prefix.
 *
 * What is planted:
 *   n46 register children  "Merchant onboarding register" with 130 child pages "Merchant NNN – <company> (tier T)",
 *                          created in number order so the listing order is the number order. Tier 3 has 33 merchants,
 *                          the highest being 127; the default listing page (25) holds 7 of them (highest 22), the
 *                          first 50 hold 13 (highest 48) and the first 100 hold 26 (highest 98).
 *   n47 four-hop penalty   "Incident 4471 review" names a KAN epic (Eposz) whose 6 child issues carry one
 *                          nm-abyss-root-cause label; that issue's web link points at "Vendor contract – Paynetix",
 *                          whose table says EUR 1,850 per hour of outage (version 1 said EUR 1,200). A contributing
 *                          factor links the sibling "Vendor contract – Paynetics" (EUR 2,400); the review page itself
 *                          estimates approx. EUR 1,000/h.
 *
 * Bodies are compared on the markdown render (`page get --format md`), which has no HTML entities or wrapped lines.
 * Exit code 1 lists every failed check; the manifest is written only when every check passed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const SITE = "foldvarszki.atlassian.net";
const SPACE = "SZOFTVERFE";
const NM_ROOT = "1572892";
const PROJECT = "KAN";
const PREFIX = "atl smoke nm abyss ";
const PACE_MS = 250;
const MAX_ATTEMPTS = 6;
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const BODIES = join(OUT, "bodies-abyss-confluence");
const MANIFEST = join(OUT, "abyss-confluence.json");

type Json = Record<string, unknown>;

function rec(value: unknown, what: string): Json {
  if (!isRecord(value)) {
    throw new Error(`${what}: expected an object`);
  }
  return value;
}

function str(obj: Json, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`expected string at ${key}`);
  }
  return value;
}

function num(obj: Json, key: string): number {
  const value = obj[key];
  if (typeof value !== "number") {
    throw new Error(`expected number at ${key}`);
  }
  return value;
}

function items(obj: Json): Json[] {
  const value = obj.items;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function log(message: string): void {
  process.stderr.write(`[seed-abyss-confluence] ${message}\n`);
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let calls = 0;
let writes = 0;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (!ok) {
    failures.push(what);
    log(`CHECK FAILED: ${what}`);
  }
}

function expect(label: string, live: unknown, expected: unknown): void {
  const a = JSON.stringify(live);
  const b = JSON.stringify(expected);
  check(a === b, `${label}: live ${a} vs expected ${b}`);
}

async function spawnAtl(args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([ATL, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

/** One atl call; exit 3 (rate limit, 5xx, timeout) retries after a backoff. Creates re-check state when a retry fails. */
async function atl(args: readonly string[]): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    await Bun.sleep(PACE_MS);
    const run = await spawnAtl(args);
    calls += 1;
    if (run.exitCode === 0) {
      const text = run.stdout.trim();
      return text === "" ? {} : rec(JSON.parse(text), args.join(" "));
    }
    if (run.exitCode === 3 && attempt < MAX_ATTEMPTS) {
      log(`exit 3 on ${args.slice(0, 3).join(" ")} (attempt ${attempt})`);
      await Bun.sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`atl ${args.slice(0, 4).join(" ")} failed (exit ${run.exitCode}): ${(run.stderr.trim() || run.stdout.trim()).slice(0, 400)}`);
  }
}

function bodyFile(text: string): string {
  mkdirSync(BODIES, { recursive: true });
  const path = join(BODIES, `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.xhtml`);
  writeFileSync(path, text);
  return path;
}

/** "EUR 1,850" -> 1850. */
function eurAmount(text: string): number {
  const match = /EUR\s*([\d,]+)/.exec(text);
  return match?.[1] === undefined ? Number.NaN : Number(match[1].replaceAll(",", ""));
}

// ---------------------------------------------------------------------------
// Storage XHTML builders
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function table(rows: readonly (readonly [string, string])[]): string {
  const body = rows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join("");
  return `<table><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Content plan
// ---------------------------------------------------------------------------

const T = {
  hub: "atl smoke nm abyss",
  register: `${PREFIX}Merchant onboarding register`,
  review: `${PREFIX}Incident 4471 review`,
  contract: `${PREFIX}Vendor contract – Paynetix`,
  contractDecoy: `${PREFIX}Vendor contract – Paynetics`,
};

const MERCHANTS = 130;
/** Tier of merchant n: the top two bits of a Knuth multiplicative hash of n + TIER_SALT (1-4). */
const TIER_SALT = 13;
const COMPANY_FIRST = ["Alder", "Brightwave", "Cobalt", "Danube", "Ember", "Fjord", "Granite", "Harbor", "Iris", "Juniper", "Kestrel", "Lumen", "Meridian"];
const COMPANY_SECOND = ["Pay", "Retail", "Foods", "Travel", "Logistics", "Media", "Health", "Energy", "Games", "Fashion", "Telecom"];
const COMPANY_FORM = ["Kft.", "Zrt.", "Ltd."];
const ANSWER_TIER = 3;
const MERCHANT_TITLE = /^atl smoke nm abyss Merchant (\d{3}) – (.+) \(tier ([1-4])\)$/;

/** Expected register facts; the plan and the live listing must both produce exactly these. */
const REGISTER = {
  total: MERCHANTS,
  tier3: 33,
  highest: 127,
  windows: [
    { limit: 25, tier3: 7, highest: 22 },
    { limit: 50, tier3: 13, highest: 48 },
    { limit: 100, tier3: 26, highest: 98 },
  ],
} as const;

interface Merchant {
  number: number;
  company: string;
  tier: number;
  title: string;
}

function tierOf(n: number): number {
  return ((Math.imul(n + TIER_SALT, 2_654_435_761) >>> 0) >>> 30) + 1;
}

function pick(list: readonly string[], index: number): string {
  const value = list[index % list.length];
  if (value === undefined) {
    throw new Error(`empty word list at ${index}`);
  }
  return value;
}

function plannedMerchants(): Merchant[] {
  return Array.from({ length: MERCHANTS }, (_, index) => {
    const number = index + 1;
    const company = `${pick(COMPANY_FIRST, number)} ${pick(COMPANY_SECOND, number)} ${pick(COMPANY_FORM, number)}`;
    const tier = tierOf(number);
    return { number, company, tier, title: `${PREFIX}Merchant ${String(number).padStart(3, "0")} – ${company} (tier ${tier})` };
  });
}

interface RegisterFacts {
  total: number;
  tier3: number;
  highest: number;
  windows: { limit: number; tier3: number; highest: number }[];
}

function tier3Of(list: readonly Merchant[]): Merchant[] {
  return list.filter((merchant) => merchant.tier === ANSWER_TIER);
}

function highestTier3(list: readonly Merchant[]): number {
  return Math.max(0, ...tier3Of(list).map((merchant) => merchant.number));
}

/** Tier-3 facts of a merchant list in listing order, overall and within the first `limit` entries of each window. */
function registerFacts(merchants: readonly Merchant[]): RegisterFacts {
  return {
    total: merchants.length,
    tier3: tier3Of(merchants).length,
    highest: highestTier3(merchants),
    windows: REGISTER.windows.map(({ limit }) => {
      const window = merchants.slice(0, limit);
      return { limit, tier3: tier3Of(window).length, highest: highestTier3(window) };
    }),
  };
}

const REGISTER_BODY = [
  "<p>Merchant onboarding register: one child page per onboarded merchant, titled with the merchant number, the company and the risk tier.</p>",
  "<p>Risk tiers: 1 = low, 2 = medium, 3 = elevated (enhanced due diligence), 4 = high. Merchant numbers are assigned in onboarding order and never reused.</p>",
].join("");

const PENALTY = {
  answer: 1850,
  firstVersion: 1200,
  sibling: 2400,
  estimate: 1000,
  label: "Penalty per hour of outage",
  message: "Amendment 2: outage penalty raised to EUR 1,850 per hour",
} as const;

const ROOT_LABEL = "nm-abyss-root-cause";
const CONTRIBUTING_LABEL = "nm-abyss-contributing-factor";
const FOLLOW_UP_LABEL = "nm-abyss-follow-up";
const INCIDENT = `${PREFIX}Incident 4471`;
const EPIC_SUMMARY = `${INCIDENT} – root-cause analysis`;
const CONTRACT_LINK = "atl-nm-abyss-n47-contract";
const CONTRACT_DECOY_LINK = "atl-nm-abyss-n47-contract-decoy";

type ChildRole = "root" | "decoy" | "plain";

interface ChildSpec {
  summary: string;
  body: string;
  label: string;
  role: ChildRole;
}

/** Creation order is listing order: the root cause is fifth, the contributing factor that links the decoy contract second. */
const CHILDREN: readonly ChildSpec[] = [
  { summary: `${INCIDENT}: alerts paged the wrong on-call rota`, body: "Contributing factor: the gateway alerts went to the retired payments rota, so the first page was acknowledged 25 minutes late.", label: CONTRIBUTING_LABEL, role: "plain" },
  { summary: `${INCIDENT}: failover to the backup acquirer took 40 minutes`, body: "Contributing factor: the manual failover to the backup acquirer took 40 minutes. The backup acquirer's contract is under Web links.", label: CONTRIBUTING_LABEL, role: "decoy" },
  { summary: `${INCIDENT}: customer communication and status page timeline`, body: "Follow-up: publish the customer-facing timeline and update the status page template.", label: FOLLOW_UP_LABEL, role: "plain" },
  { summary: `${INCIDENT}: synthetic checks for the authorisation path`, body: "Follow-up: add synthetic card authorisations every minute against both acquirers.", label: FOLLOW_UP_LABEL, role: "plain" },
  { summary: `${INCIDENT}: primary acquirer gateway rejected every authorisation`, body: "Confirmed root cause: the primary acquirer let the TLS certificate of its authorisation gateway expire, so every card authorisation was rejected for 3 h 10 min. The vendor contract is under Web links.", label: ROOT_LABEL, role: "root" },
  { summary: `${INCIDENT}: reconcile the declined transactions with finance`, body: "Follow-up: list the declined authorisations for finance and the merchant success team.", label: FOLLOW_UP_LABEL, role: "plain" },
];

function contractBody(vendor: string, service: string, penalty: string, cap: string, note: string): string {
  return [
    `<p>Master services agreement with ${esc(vendor)}. ${esc(note)}</p>`,
    table([
      ["Vendor", vendor],
      ["Service", service],
      ["Availability commitment", "99.95% per calendar month"],
      [PENALTY.label, penalty],
      ["Penalty cap per month", cap],
      ["Contract owner", "Procurement"],
    ]),
  ].join("");
}

const CONTRACT_V1_BODY = contractBody("Paynetix Payments B.V.", "Card acquiring gateway (primary acquirer)", "EUR 1,200", "EUR 25,000", "Amendments are recorded in the page history.");

const CONTRACT_CURRENT_BODY = contractBody("Paynetix Payments B.V.", "Card acquiring gateway (primary acquirer)", "EUR 1,850", "EUR 25,000", "Amendment 2 applies from 2026-06-01; amendments are recorded in the page history.");

const CONTRACT_DECOY_BODY = contractBody("Paynetics AD", "Card acquiring gateway (backup acquirer, failover only)", "EUR 2,400", "EUR 30,000", "Amendments are recorded in the page history.");

function reviewBody(epic: string): string {
  return [
    "<h2>Summary</h2>",
    "<p>On 2026-09-14 card authorisations failed for 3 h 10 min (09:05-12:15 CEST). Every merchant was affected.</p>",
    "<h2>Root-cause analysis</h2>",
    `<p>Tracked in the Jira epic <a href="https://${SITE}/browse/${epic}">${epic}</a>. Every finding is a child issue of the epic; the confirmed root cause carries the label ${ROOT_LABEL}, the other children are contributing factors and follow-ups.</p>`,
    "<h2>Financial impact</h2>",
    table([
      ["Outage duration", "3 h 10 min"],
      ["Vendor penalty (our estimate)", "approx. EUR 1,000/h, to be confirmed against the vendor contract"],
      ["Refunded merchant fees", "EUR 4,300"],
    ]),
  ].join("");
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

interface PageState {
  id: string;
  title: string;
  version: number;
  url: string;
  body: string;
}

function bodyLines(page: Json): string {
  const body = page.body;
  return Array.isArray(body) ? body.filter((line): line is string => typeof line === "string").join("\n") : "";
}

/** The page as rendered markdown: no HTML entities or wrapped lines, so needles compare directly. */
async function readPage(id: string, version?: number): Promise<PageState> {
  const args = ["page", "get", id, "--format", "md"];
  if (version !== undefined) {
    args.push("--version", String(version));
  }
  const page = await atl(args);
  return { id, title: str(page, "title"), version: num(page, "version"), url: typeof page.url === "string" ? page.url : "", body: bodyLines(page) };
}

async function children(parent: string): Promise<Map<string, string>> {
  const result = await atl(["page", "children", parent, "--all"]);
  return new Map(items(result).map((entry) => [str(entry, "title"), str(entry, "id")]));
}

/** Creates a page; when the call fails it re-lists the parent, because a timed-out create may have been applied. */
async function createPage(title: string, body: string, parent: string): Promise<string> {
  writes += 1;
  try {
    const created = await atl(["page", "create", "--space", SPACE, "--title", title, "--parent", parent, "--file", bodyFile(body), "--body-format", "storage"]);
    log(`created ${title}`);
    return str(created, "id");
  } catch (error) {
    const id = (await children(parent)).get(title);
    if (id === undefined) {
      throw error;
    }
    log(`created ${title} (found after a failed call)`);
    return id;
  }
}

async function updatePage(id: string, body: string, message: string): Promise<void> {
  writes += 1;
  await atl(["page", "update", id, "--file", bodyFile(body), "--body-format", "storage", "--message", message]);
  log(`updated ${id} (${message})`);
}

function expectBody(state: PageState, needles: readonly string[]): void {
  for (const needle of needles) {
    check(state.body.includes(needle), `${state.title}: body lacks ${JSON.stringify(needle)}`);
  }
}

async function ensurePage(registry: Map<string, string>, title: string, parent: string, body: string, needles: readonly string[]): Promise<PageState> {
  let id = registry.get(title);
  if (id === undefined) {
    id = await createPage(title, body, parent);
    registry.set(title, id);
  }
  let state = await readPage(id);
  if (!needles.every((needle) => state.body.includes(needle))) {
    await updatePage(id, body, "Restore seeded body");
    state = await readPage(id);
  }
  check(state.title === title, `${title}: title is ${state.title}`);
  expectBody(state, needles);
  return state;
}

/** Cells of every markdown table row whose first cell is `first`. */
function mdRows(md: string, first: string): string[][] {
  return md
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] === first);
}

function penaltyOf(md: string, title: string): number {
  const rows = mdRows(md, PENALTY.label);
  check(rows.length === 1, `${title}: ${rows.length} "${PENALTY.label}" rows in the rendered body, expected 1`);
  return eurAmount(rows[0]?.[1] ?? "");
}

// ---------------------------------------------------------------------------
// n46: merchant register with 130 children
// ---------------------------------------------------------------------------

function parseMerchant(title: string): Merchant | undefined {
  const match = MERCHANT_TITLE.exec(title);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  return { number: Number(match[1]), company: match[2], tier: Number(match[3]), title };
}

async function ensureRegister(hubRegistry: Map<string, string>, hub: string): Promise<Json> {
  const planned = plannedMerchants();
  const plan = registerFacts(planned);
  if (JSON.stringify(plan) !== JSON.stringify(REGISTER)) {
    throw new Error(`register plan is wrong (fix TIER_SALT or REGISTER before writing anything): plan ${JSON.stringify(plan)} vs ${JSON.stringify(REGISTER)}`);
  }

  const register = await ensurePage(hubRegistry, T.register, hub, REGISTER_BODY, ["one child page per onboarded merchant", "3 = elevated"]);
  const existing = await children(register.id);
  for (const merchant of planned) {
    if (!existing.has(merchant.title)) {
      const body = `<p>Merchant ${String(merchant.number).padStart(3, "0")}: ${esc(merchant.company)}. Risk tier ${merchant.tier} (1 = low, 4 = high).</p>`;
      existing.set(merchant.title, await createPage(merchant.title, body, register.id));
    }
  }

  const listed = items(await atl(["page", "children", register.id, "--all"])).map((entry) => ({ id: str(entry, "id"), title: str(entry, "title") }));
  const live = listed.map((entry) => parseMerchant(entry.title));
  const merchants = live.filter((merchant): merchant is Merchant => merchant !== undefined);
  check(merchants.length === listed.length, `${T.register}: ${listed.length - merchants.length} children are not "Merchant NNN – company (tier T)" pages`);
  expect("n46 children in listing order", merchants.map((merchant) => merchant.title), planned.map((merchant) => merchant.title));
  const facts = registerFacts(merchants);
  expect("n46 register facts from the live listing", facts, REGISTER);

  const top = merchants.find((merchant) => merchant.number === facts.highest);
  const firstPage = await atl(["page", "children", register.id]);
  const firstPageTitles = items(firstPage).map((entry) => str(entry, "title"));
  expect("n46 default children page size", firstPageTitles.length, REGISTER.windows[0].limit);
  check(typeof firstPage.nextCursor === "string", `${T.register}: the default children page has no nextCursor`);
  return {
    page: { id: register.id, title: T.register },
    answer: {
      total: facts.total,
      tier3: facts.tier3,
      highest: { number: facts.highest, title: top?.title ?? "", company: top?.company ?? "" },
      windows: facts.windows,
    },
    live: { tiers: Object.fromEntries([1, 2, 3, 4].map((tier) => [`tier ${tier}`, merchants.filter((merchant) => merchant.tier === tier).length])), defaultPage: firstPageTitles },
  };
}

// ---------------------------------------------------------------------------
// n47: review page -> epic -> root-cause child -> web link -> contract table
// ---------------------------------------------------------------------------

interface IssueState {
  key: string;
  summary: string;
  type: string;
  labels: string[];
  parent: string;
}

async function issueState(key: string): Promise<IssueState> {
  const raw = await atl(["issue", "get", key, "--issue-fields", "summary,issuetype,labels,parent"]);
  return {
    key: str(raw, "key"),
    summary: typeof raw.summary === "string" ? raw.summary : "",
    type: typeof raw.type === "string" ? raw.type : "",
    labels: strings(raw.labels).toSorted(),
    parent: isRecord(raw.parent) && typeof raw.parent.key === "string" ? raw.parent.key : "",
  };
}

/** KAN issues whose summary matches the incident phrase, keyed by exact summary. */
async function findIssues(): Promise<Map<string, string[]>> {
  const result = await atl(["jql", `project = ${PROJECT} AND summary ~ "${INCIDENT}" ORDER BY created ASC`, "--all", "--issue-fields", "summary"]);
  const found = new Map<string, string[]>();
  for (const item of items(result)) {
    const summary = typeof item.summary === "string" ? item.summary : "";
    found.set(summary, [...(found.get(summary) ?? []), str(item, "key")]);
  }
  return found;
}

/** Key of the one issue named exactly `summary`; two of them is a loud failure (nothing here deletes issues). */
function exact(found: Map<string, string[]>, summary: string): string | undefined {
  const keys = found.get(summary) ?? [];
  if (keys.length > 1) {
    throw new Error(`${keys.length} issues are named "${summary}" (${keys.join(", ")}): retire all but one and rerun`);
  }
  return keys[0];
}

async function ensureIssue(found: Map<string, string[]>, summary: string, type: string, body: string, labels: readonly string[], parent?: string): Promise<string> {
  let key = exact(found, summary);
  if (key === undefined) {
    const args = ["issue", "create", "--project", PROJECT, "--type", type, "--summary", summary, "--body", body];
    if (parent !== undefined) {
      args.push("--parent", parent);
    }
    if (labels.length > 0) {
      args.push("--set", `labels=${JSON.stringify(labels)}`);
    }
    writes += 1;
    key = str(await atl(args), "key");
    found.set(summary, [key]);
    log(`created ${key} ${summary}`);
  }
  const live = await issueState(key);
  if (JSON.stringify(live.labels) !== JSON.stringify(labels.toSorted())) {
    writes += 1;
    await atl(["issue", "update", key, "--set", `labels=${JSON.stringify(labels)}`]);
    log(`${key}: labels restored`);
  }
  check(live.summary === summary, `${key}: summary is ${live.summary}`);
  check(live.type === type, `${key}: type is ${live.type}, expected ${type}`);
  check(live.parent === (parent ?? ""), `${key}: parent is ${live.parent || "(none)"}, expected ${parent ?? "(none)"}`);
  return key;
}

interface WebLink {
  globalId: string;
  title: string;
  url: string;
}

async function ensureWebLink(key: string, link: WebLink): Promise<void> {
  const live = items(await atl(["issue", "links", key, "--global-id", link.globalId]))[0];
  if (live?.url !== link.url || live.title !== link.title) {
    writes += 1;
    await atl(["issue", "remote-link", "add", key, "--url", link.url, "--title", link.title, "--relationship", "vendor contract", "--global-id", link.globalId]);
    log(`${key}: web link ${link.globalId} -> ${link.url}`);
  }
}

function pageIdOf(url: string): string {
  return /\/pages\/(\d+)/.exec(url)?.[1] ?? "";
}

const CONTRACT_NEEDLES = ["Paynetix Payments B.V.", "primary acquirer", PENALTY.label, "EUR 1,850"] as const;

async function ensureContract(registry: Map<string, string>, hub: string): Promise<{ page: PageState; versions: Json[] }> {
  let id = registry.get(T.contract);
  if (id === undefined) {
    id = await createPage(T.contract, CONTRACT_V1_BODY, hub);
    registry.set(T.contract, id);
  }
  let page = await readPage(id);
  if (!CONTRACT_NEEDLES.every((needle) => page.body.includes(needle))) {
    await updatePage(id, CONTRACT_CURRENT_BODY, PENALTY.message);
    page = await readPage(id);
  }
  check(page.title === T.contract, `${T.contract}: title is ${page.title}`);
  expectBody(page, CONTRACT_NEEDLES);
  const versions = items(await atl(["page", "versions", id, "--all"])).toSorted((a, b) => num(a, "number") - num(b, "number"));
  return { page, versions };
}

async function ensurePenalty(registry: Map<string, string>, hub: string): Promise<Json> {
  const { page: contract, versions } = await ensureContract(registry, hub);
  const decoy = await ensurePage(registry, T.contractDecoy, hub, CONTRACT_DECOY_BODY, ["Paynetics AD", "backup acquirer", PENALTY.label, "EUR 2,400"]);

  const found = await findIssues();
  const epic = await ensureIssue(found, EPIC_SUMMARY, "Eposz", `Root-cause analysis for incident 4471 (card authorisations failed for 3 h 10 min). Every finding is a child issue; the confirmed root cause carries the label ${ROOT_LABEL}.`, []);
  const keys = new Map<ChildRole, string[]>();
  for (const spec of CHILDREN) {
    const key = await ensureIssue(found, spec.summary, "Feladat", spec.body, [spec.label], epic);
    keys.set(spec.role, [...(keys.get(spec.role) ?? []), key]);
  }
  const [root] = keys.get("root") ?? [];
  const [contributing] = keys.get("decoy") ?? [];
  if (root === undefined || contributing === undefined) {
    throw new Error("n47 child plan lacks the root cause or the decoy-linked contributing factor");
  }
  await ensureWebLink(root, { globalId: CONTRACT_LINK, title: T.contract, url: contract.url });
  await ensureWebLink(contributing, { globalId: CONTRACT_DECOY_LINK, title: T.contractDecoy, url: decoy.url });

  const review = await ensurePage(registry, T.review, hub, reviewBody(epic), [epic, ROOT_LABEL, "approx. EUR 1,000/h"]);

  // Read-back: walk the chain the way the scenario expects a reader to.
  const reviewEpic = /\bKAN-\d+\b/.exec(review.body)?.[0] ?? "";
  const tree = await atl(["issue", "tree", reviewEpic || epic, "--depth", "1", "--issue-fields", "summary,labels"]);
  const treeItems = items(tree);
  const rootChildren = treeItems.filter((entry) => strings(entry.labels).includes(ROOT_LABEL));
  const rootKey = rootChildren.length === 1 && rootChildren[0] !== undefined ? str(rootChildren[0], "key") : "";
  const rootLinks = rootKey === "" ? [] : items(await atl(["issue", "links", rootKey, "--remote"]));
  const linkedPage = rootLinks.length === 1 && rootLinks[0] !== undefined ? pageIdOf(str(rootLinks[0], "url")) : "";
  const decoyLinks = items(await atl(["issue", "links", contributing, "--remote"]));
  const linked = linkedPage === "" ? undefined : await readPage(linkedPage);
  const changed = versions.find((entry) => entry.message === PENALTY.message);
  const firstVersion = await readPage(contract.id, 1);
  const changedVersion = changed === undefined ? undefined : await readPage(contract.id, num(changed, "number"));
  const live = {
    reviewEpic,
    children: treeItems.length,
    rootChildren: rootChildren.length,
    rootKey,
    rootLinks: rootLinks.length,
    linkedPage,
    answer: linked === undefined ? Number.NaN : penaltyOf(linked.body, linked.title),
    firstVersion: penaltyOf(firstVersion.body, `${T.contract} v1`),
    changedVersion: changedVersion === undefined ? Number.NaN : penaltyOf(changedVersion.body, `${T.contract} v${changedVersion.version}`),
    sibling: penaltyOf(decoy.body, T.contractDecoy),
    siblingLinkedFrom: decoyLinks.map((link) => pageIdOf(str(link, "url"))),
    estimate: eurAmount(/approx\. (EUR [\d,]+)\/h/.exec(review.body)?.[1] ?? ""),
  };
  expect("n47 epic named on the review page", live.reviewEpic, epic);
  expect("n47 epic children", live.children, CHILDREN.length);
  expect("n47 children labelled root cause", live.rootChildren, 1);
  expect("n47 root-cause issue", live.rootKey, root);
  expect("n47 web links on the root cause", live.rootLinks, 1);
  expect("n47 page behind the root-cause link", live.linkedPage, contract.id);
  expect("n47 current penalty", live.answer, PENALTY.answer);
  expect("n47 version 1 penalty", live.firstVersion, PENALTY.firstVersion);
  check(changed !== undefined, `${T.contract}: no version carries the message ${JSON.stringify(PENALTY.message)}`);
  expect("n47 penalty in the version with the change message", live.changedVersion, PENALTY.answer);
  expect("n47 sibling contract penalty", live.sibling, PENALTY.sibling);
  expect("n47 contributing factor links the sibling contract", live.siblingLinkedFrom, [decoy.id]);
  expect("n47 review page estimate", live.estimate, PENALTY.estimate);

  return {
    pages: {
      review: { id: review.id, title: T.review },
      contract: { id: contract.id, title: T.contract },
      contractDecoy: { id: decoy.id, title: T.contractDecoy },
    },
    issues: {
      epic,
      rootCause: root,
      contractDecoyLinkedFrom: contributing,
      children: treeItems.map((entry) => ({ key: str(entry, "key"), summary: typeof entry.summary === "string" ? entry.summary : "", labels: strings(entry.labels) })),
    },
    answer: {
      value: PENALTY.answer,
      sibling: PENALTY.sibling,
      firstVersion: PENALTY.firstVersion,
      estimate: PENALTY.estimate,
      versionMessage: PENALTY.message,
    },
    live,
    versions,
    renders: { review: review.body, contract: contract.body, contractFirstVersion: firstVersion.body, contractDecoy: decoy.body },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const nm = await children(NM_ROOT);
  const hub = nm.get(T.hub) ?? (await createPage(T.hub, "<p>Pages for the abyss scenarios of the corporate-nightmare eval. Children are seeded by the eval/nightmare/seed-abyss-*.ts scripts.</p>", NM_ROOT));
  const registry = await children(hub);

  const register = await ensureRegister(registry, hub);
  const penalty = await ensurePenalty(registry, hub);

  if (failures.length > 0) {
    log(`${failures.length} check(s) failed; manifest not written (${calls} atl calls, ${writes} writes)`);
    process.exit(1);
  }

  const registerAnswer = rec(register.answer, "register answer");
  const highest = rec(registerAnswer.highest, "register highest");
  const penaltyPages = rec(penalty.pages, "penalty pages");
  const manifest = {
    generatedAt: new Date().toISOString(),
    site: SITE,
    space: SPACE,
    hub: { id: hub, title: T.hub },
    pages: { register: register.page, ...penaltyPages },
    issues: penalty.issues,
    answers: { register: registerAnswer, penalty: penalty.answer },
    facts: [
      {
        id: "n46-register-children",
        question: `${T.register}: tier-3 merchants and the highest tier-3 merchant number?`,
        answer: `${REGISTER.tier3}; ${str(highest, "title")}`,
        whyHard: `the register has ${REGISTER.total} child pages; the default listing page holds ${REGISTER.windows[0].limit} (${REGISTER.windows[0].tier3} tier 3, highest ${REGISTER.windows[0].highest}); 50 children hold ${REGISTER.windows[1].tier3} (highest ${REGISTER.windows[1].highest}); 100 children hold ${REGISTER.windows[2].tier3} (highest ${REGISTER.windows[2].highest})`,
      },
      {
        id: "n47-four-hop-penalty",
        question: `${T.review}: penalty per hour of outage in the vendor contract behind the root cause?`,
        answer: `EUR ${PENALTY.answer}`,
        whyHard: `review page -> epic -> the one child labelled ${ROOT_LABEL} -> its web link -> "${T.contract}"; the sibling "${T.contractDecoy}" (linked from a contributing factor) says EUR ${PENALTY.sibling}; version 1 of the contract said EUR ${PENALTY.firstVersion}; the review page estimates approx. EUR ${PENALTY.estimate}/h`,
      },
    ],
    live: { register: register.live, penalty: penalty.live },
    versions: { contract: penalty.versions },
    renders: penalty.renders,
    atlCalls: calls,
    atlWrites: writes,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest written to ${MANIFEST} (${calls} atl calls, ${writes} writes)`);
}

await main();
