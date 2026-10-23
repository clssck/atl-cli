#!/usr/bin/env bun
/**
 * Seed the "chaos" Confluence pages that only a careful reader can answer, through the frozen atl binary, and
 * write eval/.out/nightmare/chaos-confluence.json (ids, facts with answers and decoys, how atl renders each page).
 *
 * Usage: bun eval/nightmare/seed-chaos-confluence.ts
 *
 * Everything lives under the page "atl smoke nm chaos Root" in SZOFTVERFE (parent: the nightmare wiki root
 * 1572892). Idempotent: pages are found by exact title among the children of the chaos root (the renamed page by
 * any of its four titles) and only missing pages, missing versions or drifted bodies are written; a re-run on a
 * finished site writes nothing. The token has no Confluence delete scope, so the owner removes the tree in the UI by
 * the "atl smoke nm chaos " prefix.
 *
 * What is planted (all bodies are storage XHTML because the macros have no markdown form):
 *   n26 excerpt-include   "Payments On-call Card" holds only an excerpt-include macro (named excerpt "escalation");
 *                         the answer lives in the named excerpt of "Payments On-call Runbook". The same runbook
 *                         has a second excerpt ("summary") with a different number, a legacy figure outside any
 *                         excerpt, and a near-identical "(2025 archive)" page with the superseded answer.
 *   n27 expand + status   "Cache Flush Procedure": the visible step 3 sits under a status lozenge DEPRECATED; the
 *                         step in force is inside an expand macro under the CURRENT section, and the expand
 *                         itself warns against a third command.
 *   n28 renamed page      one page renamed three times (four versions, each with its own title and bridge number);
 *                         the prompt uses the first title, which no longer exists. "Incident Handbook" links to the
 *                         page by id under the old title text and quotes the first number.
 *   n29 Jira macro        "Release 1.1 Readiness" shows its blockers only as a Jira issues macro (JQL on NMS
 *                         fixVersion 1.1, statusCategory != Done); the body carries stale hand-written counts. The
 *                         live count is computed from the same JQL at seed time.
 *
 * Exit code 1 lists every failed check; the manifest is written either way.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const SITE_URL = "https://foldvarszki.atlassian.net";
const SPACE = "SZOFTVERFE";
const NM_ROOT = "1572892";
const PREFIX = "atl smoke nm chaos ";
const PACE_MS = 250;
const MAX_ATTEMPTS = 6;
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const BODIES = join(OUT, "bodies-chaos-confluence");
const MANIFEST = join(OUT, "chaos-confluence.json");
const JQL_RELEASE = 'project = NMS AND fixVersion = "1.1" AND statusCategory != Done ORDER BY key';
const JQL_ALL = 'project = NMS AND fixVersion = "1.1"';

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

function log(message: string): void {
  process.stderr.write(`[seed-chaos-confluence] ${message}\n`);
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

async function spawnAtl(args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([ATL, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** One atl call; exit 3 (rate limit, 5xx, timeout) retries after a backoff. Writes are only retried by callers that re-check state. */
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

// ---------------------------------------------------------------------------
// Storage XHTML builders
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function macro(name: string, params: Record<string, string>, body?: string): string {
  const parameters = Object.entries(params)
    .map(([key, value]) => `<ac:parameter ac:name="${key}">${value}</ac:parameter>`)
    .join("");
  const rich = body === undefined ? "" : `<ac:rich-text-body>${body}</ac:rich-text-body>`;
  return `<ac:structured-macro ac:name="${name}" ac:schema-version="1">${parameters}${rich}</ac:structured-macro>`;
}

function status(title: string, colour: string): string {
  return macro("status", { title, colour });
}

function pageLink(title: string): string {
  return `<ac:link><ri:page ri:content-title="${esc(title)}" /></ac:link>`;
}

// ---------------------------------------------------------------------------
// Content plan
// ---------------------------------------------------------------------------

const T = {
  root: `${PREFIX}Root`,
  runbook: `${PREFIX}Payments On-call Runbook`,
  archive: `${PREFIX}Payments On-call Runbook (2025 archive)`,
  card: `${PREFIX}Payments On-call Card`,
  cache: `${PREFIX}Cache Flush Procedure`,
  handbook: `${PREFIX}Incident Handbook`,
  readiness: `${PREFIX}Release 1.1 Readiness`,
};

/** The four titles of the renamed page, oldest first, each with the Tier-2 bridge number of that version. */
const RENAMED = [
  { title: `${PREFIX}Pager Rota Cheatsheet`, bridge: "+36 1 555 0142", message: "First draft" },
  { title: `${PREFIX}On-call Quick Reference`, bridge: "+36 1 555 0155", message: "Rename, new bridge" },
  { title: `${PREFIX}Incident Contacts`, bridge: "+36 1 555 0171", message: "Rename" },
  { title: `${PREFIX}Escalation Matrix`, bridge: "+36 1 555 0188", message: "Rename, bridge moved to the new provider" },
] as const;

const ESCALATION = { minutes: 25, secondary: "Réka Tóth", ackMinutes: 5, legacyMinutes: 10, archiveSecondary: "Gábor Szabó" };
const CACHE = {
  command: "cachectl drain --region eu --grace 90s",
  grace: "90s",
  deprecated: "cachectl purge --region eu",
  forbidden: "cachectl flushall",
};

function runbookBody(): string {
  const summary = macro(
    "excerpt",
    { name: "summary" },
    `<p>Payments on-call: the primary acknowledges every page within ${ESCALATION.ackMinutes} minutes; the rota lives in the team calendar.</p>`,
  );
  const escalation = macro(
    "excerpt",
    { name: "escalation" },
    `<p>If the primary has not acknowledged within ${ESCALATION.minutes} minutes, page the secondary on-call, ${ESCALATION.secondary}, on bridge line 7.</p>`,
  );
  return [
    "<h1>Payments On-call Runbook</h1>",
    summary,
    "<h2>Escalation</h2>",
    escalation,
    "<h2>History</h2>",
    `<p>Until June 2026 the escalation wait was ${ESCALATION.legacyMinutes} minutes; it was lengthened after the pager provider moved to batched delivery.</p>`,
    "<h2>Handover</h2>",
    "<p>The outgoing primary posts open incidents in the team channel before 09:00.</p>",
  ].join("");
}

function archiveBody(): string {
  const escalation = macro(
    "excerpt",
    { name: "escalation" },
    `<p>If the primary has not acknowledged within ${ESCALATION.legacyMinutes} minutes, page the secondary on-call, ${ESCALATION.archiveSecondary}, on bridge line 3.</p>`,
  );
  return ["<h1>Payments On-call Runbook (2025 archive)</h1>", "<p>Snapshot kept for the audit trail.</p>", escalation].join("");
}

function cardBody(): string {
  const include = macro("excerpt-include", { "": pageLink(T.runbook), name: "escalation" });
  return ["<h1>Payments On-call Card</h1>", include].join("");
}

function cacheBody(): string {
  const oldSection = [
    `<h2>Procedure for 2025 ${status("DEPRECATED", "Red")}</h2>`,
    "<ol>",
    "<li><p>Announce the flush in the team channel.</p></li>",
    "<li><p>Set the EU load balancer to maintenance.</p></li>",
    `<li><p>Run <code>${CACHE.deprecated}</code>.</p></li>`,
    "<li><p>Take the load balancer out of maintenance.</p></li>",
    "</ol>",
  ].join("");
  const detail = macro(
    "expand",
    { title: "Step 3 details (click to expand)" },
    [
      `<p>Run <code>${CACHE.command}</code> and wait for the drain to report zero in-flight requests.</p>`,
      `<p>Do not use <code>${CACHE.forbidden}</code>; it also drops the session store.</p>`,
    ].join(""),
  );
  const newSection = [
    `<h2>Procedure ${status("CURRENT", "Green")}</h2>`,
    "<ol>",
    "<li><p>Announce the flush in the team channel.</p></li>",
    "<li><p>Set the EU load balancer to maintenance.</p></li>",
    "<li><p>Flush the cache nodes as described below.</p></li>",
    "<li><p>Take the load balancer out of maintenance.</p></li>",
    "</ol>",
    detail,
  ].join("");
  return ["<h1>Cache Flush Procedure</h1>", "<p>How to flush the EU cache cluster.</p>", oldSection, newSection].join("");
}

function renamedBody(version: number): string {
  const entry = RENAMED[version - 1];
  if (entry === undefined) {
    throw new Error(`no renamed version ${version}`);
  }
  return [
    `<h1>${esc(entry.title.slice(PREFIX.length))}</h1>`,
    "<p>Who to call when the payments incident bridge is needed.</p>",
    "<table><tbody>",
    "<tr><th>Item</th><th>Value</th></tr>",
    `<tr><td>Tier-2 bridge</td><td>${entry.bridge}</td></tr>`,
    "<tr><td>Tier-2 lead</td><td>Anna Kovács</td></tr>",
    "</tbody></table>",
  ].join("");
}

function handbookBody(renamedId: string): string {
  const url = `${SITE_URL}/wiki/spaces/${SPACE}/pages/${renamedId}`;
  return [
    "<h1>Incident Handbook</h1>",
    "<p>Severity definitions and the war-room checklist live in the sections below.</p>",
    `<p>Tier-2 bridge: ${RENAMED[0].bridge} (copied from the <a href="${url}">${esc(RENAMED[0].title.slice(PREFIX.length))}</a>, check there for changes).</p>`,
  ].join("");
}

function readinessBody(): string {
  const jira = macro("jira", {
    server: "System Jira",
    columns: "key,summary,status,fixversion",
    maximumIssues: "50",
    jqlQuery: esc(JQL_RELEASE),
  });
  return [
    "<h1>Release 1.1 Readiness</h1>",
    "<p>Go/no-go checklist for the NMS mobile app 1.1.</p>",
    `<p>Hand-counted on 9 October: <strong>9 blockers</strong> still open (14 on 29 September).</p>`,
    "<h2>Open blockers</h2>",
    jira,
    "<p>Release captain: Márta Fehér. Scope changes were frozen at the end of Sprint 2.</p>",
  ].join("");
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

interface PageState {
  id: string;
  title: string;
  version: number;
  body: string;
}

function bodyLines(page: Json): string {
  const body = page.body;
  return Array.isArray(body) ? body.filter((line): line is string => typeof line === "string").join("\n") : "";
}

async function readPage(id: string, version?: number): Promise<PageState> {
  const args = ["page", "get", id, "--format", "storage"];
  if (version !== undefined) {
    args.push("--version", String(version));
  }
  const page = await atl(args);
  return {
    id,
    title: str(page, "title"),
    version: num(page, "version"),
    body: bodyLines(page),
  };
}

async function children(parent: string): Promise<Map<string, string>> {
  const result = await atl(["page", "children", parent, "--all"]);
  return new Map(items(result).map((entry) => [str(entry, "title"), str(entry, "id")]));
}

async function createPage(title: string, body: string, parent: string): Promise<string> {
  writes += 1;
  const created = await atl(["page", "create", "--space", SPACE, "--title", title, "--parent", parent, "--file", bodyFile(body), "--body-format", "storage"]);
  log(`created ${title}`);
  return str(created, "id");
}

async function updatePage(id: string, body: string, title?: string, message?: string): Promise<void> {
  writes += 1;
  const args = ["page", "update", id, "--file", bodyFile(body), "--body-format", "storage"];
  if (title !== undefined) {
    args.push("--title", title);
  }
  if (message !== undefined) {
    args.push("--message", message);
  }
  await atl(args);
  log(`updated ${title ?? id}`);
}

/** Every `needle` must survive the storage round trip; macro names and parameters are what the page is about. */
function expectBody(state: PageState, needles: readonly string[]): void {
  for (const needle of needles) {
    check(state.body.includes(needle), `${state.title}: storage body lacks ${JSON.stringify(needle)}`);
  }
}

async function ensurePage(registry: Map<string, string>, title: string, parent: string, body: string, needles: readonly string[]): Promise<string> {
  let id = registry.get(title);
  if (id === undefined) {
    id = await createPage(title, body, parent);
    registry.set(title, id);
  }
  let state = await readPage(id);
  if (!needles.every((needle) => state.body.includes(needle))) {
    await updatePage(id, body, undefined, "Restore seeded body");
    state = await readPage(id);
  }
  check(state.title === title, `${title}: title is ${state.title}`);
  expectBody(state, needles);
  return id;
}

async function ensureRenamed(registry: Map<string, string>, root: string): Promise<{ id: string; versions: Json[] }> {
  let id: string | undefined;
  for (const entry of RENAMED) {
    id ??= registry.get(entry.title);
  }
  if (id === undefined) {
    const first = RENAMED[0];
    id = await createPage(first.title, renamedBody(1), root);
  }
  const current = await readPage(id);
  for (let version = current.version + 1; version <= RENAMED.length; version++) {
    const entry = RENAMED[version - 1];
    if (entry === undefined) {
      break;
    }
    await updatePage(id, renamedBody(version), entry.title, entry.message);
  }
  const listing = items(await atl(["page", "versions", id, "--all"])).toSorted((a, b) => num(a, "number") - num(b, "number"));
  check(listing.length === RENAMED.length, `renamed page has ${listing.length} versions, expected ${RENAMED.length}`);
  for (const [index, entry] of RENAMED.entries()) {
    const version = listing[index];
    check(version !== undefined && str(version, "title") === entry.title, `renamed page version ${index + 1} title is ${version === undefined ? "missing" : str(version, "title")}`);
    const state = await readPage(id, index + 1);
    check(state.title === entry.title && state.body.includes(entry.bridge), `renamed page v${index + 1} does not carry ${entry.title} / ${entry.bridge}`);
  }
  return { id, versions: listing };
}

async function renderOf(id: string): Promise<{ md: string; view: string }> {
  const md = await atl(["page", "get", id]);
  const view = await atl(["page", "get", id, "--format", "view"]);
  return { md: bodyLines(md), view: bodyLines(view) };
}

async function liveReadiness(): Promise<{ open: string[]; all: number }> {
  const open = items(await atl(["jql", JQL_RELEASE, "--all", "--issue-fields", "summary"])).map((issue) => str(issue, "key"));
  const all = items(await atl(["jql", JQL_ALL, "--all", "--issue-fields", "summary"])).length;
  return { open, all };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const nm = await children(NM_ROOT);
  let rootId = nm.get(T.root);
  const rootBody = [
    "<h1>Chaos Root</h1>",
    "<p>Pages for the adversarial Confluence scenarios of the corporate-nightmare eval. Everything below is seeded by eval/nightmare/seed-chaos-confluence.ts.</p>",
  ].join("");
  rootId ??= await createPage(T.root, rootBody, NM_ROOT);
  const registry = await children(rootId);

  const runbook = await ensurePage(registry, T.runbook, rootId, runbookBody(), [
    'ac:name="excerpt"',
    "summary",
    "escalation",
    `${ESCALATION.minutes} minutes`,
  ]);
  const archive = await ensurePage(registry, T.archive, rootId, archiveBody(), ['ac:name="excerpt"', `${ESCALATION.legacyMinutes} minutes`]);
  const card = await ensurePage(registry, T.card, rootId, cardBody(), ['ac:name="excerpt-include"', "escalation", T.runbook]);
  const cache = await ensurePage(registry, T.cache, rootId, cacheBody(), ['ac:name="expand"', 'ac:name="status"', "DEPRECATED", CACHE.command, CACHE.deprecated]);

  const renamed = await ensureRenamed(registry, rootId);
  const handbook = await ensurePage(registry, T.handbook, rootId, handbookBody(renamed.id), [`pages/${renamed.id}`, RENAMED[0].title.slice(PREFIX.length)]);

  const live = await liveReadiness();
  const readiness = await ensurePage(registry, T.readiness, rootId, readinessBody(), ['ac:name="jira"', "jqlQuery", "statusCategory"]);
  check(live.open.length > 0 && live.open.length !== 9 && live.open.length !== 14 && live.open.length !== live.all, `live open count ${live.open.length} collides with a decoy (9, 14, all ${live.all})`);

  const renders = {
    card: await renderOf(card),
    cache: await renderOf(cache),
    handbook: await renderOf(handbook),
    readiness: await renderOf(readiness),
  };

  const finalTitle = RENAMED[RENAMED.length - 1]?.title ?? "";
  const manifest = {
    generatedAt: new Date().toISOString(),
    site: "foldvarszki.atlassian.net",
    space: SPACE,
    root: { id: rootId, title: T.root },
    pages: {
      runbook: { id: runbook, title: T.runbook },
      archive: { id: archive, title: T.archive },
      card: { id: card, title: T.card },
      cache: { id: cache, title: T.cache },
      renamed: { id: renamed.id, title: finalTitle, titles: RENAMED.map((entry) => entry.title) },
      handbook: { id: handbook, title: T.handbook },
      readiness: { id: readiness, title: T.readiness },
    },
    facts: [
      {
        id: "excerpt-include",
        question: `On ${T.card} (a page that only embeds another page's excerpt): after how many minutes without acknowledgement is the secondary paged, and who is it?`,
        answer: `${ESCALATION.minutes} minutes; ${ESCALATION.secondary}`,
        whyHard: `the card body is a single excerpt-include macro (source page "${T.runbook}", excerpt name "escalation"); the source also has excerpt "summary" (${ESCALATION.ackMinutes} min primary ack), a legacy ${ESCALATION.legacyMinutes} minutes in plain text and a near-identical 2025 archive page (${ESCALATION.legacyMinutes} minutes, ${ESCALATION.archiveSecondary})`,
      },
      {
        id: "expand-status",
        question: `On ${T.cache}: which command does step 3 of the procedure in force run, and with what grace period?`,
        answer: `${CACHE.command}; grace ${CACHE.grace}`,
        whyHard: `the CURRENT section only says "flush the cache nodes as described below" and the command is inside an expand macro; the visible step 3 under the DEPRECATED lozenge is "${CACHE.deprecated}"; the expand warns off "${CACHE.forbidden}"`,
      },
      {
        id: "renamed-page",
        question: `The page once called "${RENAMED[0].title}": what is the Tier-2 bridge number now and what is the page called today?`,
        answer: `${RENAMED[RENAMED.length - 1]?.bridge ?? ""}; ${finalTitle.slice(PREFIX.length)}`,
        whyHard: `renamed three times (${RENAMED.map((entry) => entry.title.slice(PREFIX.length)).join(" -> ")}); no page carries the old title any more; ${T.handbook} links to it by id under the old title text and quotes ${RENAMED[0].bridge}; versions 1-3 carry ${RENAMED.slice(0, 3).map((entry) => entry.bridge).join(", ")}`,
      },
      {
        id: "jira-macro",
        question: `${T.readiness}: how many issues are open for NMS 1.1 right now?`,
        answer: `${live.open.length} (${live.open.join(", ")})`,
        whyHard: `the blockers exist only as a Jira macro (JQL: ${JQL_RELEASE}); the body says "9 blockers" (14 earlier); ${live.all} issues carry fixVersion 1.1 in total`,
      },
    ],
    live: { jql: JQL_RELEASE, open: live.open, allWithFixVersion: live.all },
    renders,
    versions: { renamed: renamed.versions.map((v) => ({ number: num(v, "number"), title: str(v, "title") })) },
    checkFailures: failures,
    atlCalls: calls,
    atlWrites: writes,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest written to ${MANIFEST} (${calls} atl calls, ${writes} writes)`);
  if (failures.length > 0) {
    log(`${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
