#!/usr/bin/env bun
/**
 * Corporate-nightmare "hell history" seed (n34-n36): issue history that has to be replayed in full, worklog start
 * instants that have to be read in a given time zone, and a write whose worklog starts at a Budapest wall-clock time.
 * Everything is created through the atl binary with summaries prefixed `atl smoke nm hell `; nothing existing is
 * modified.
 *
 *  - n34 changelog: NMS "Ledger reconciliation job" enters In Progress (Folyamatban) three times among ~150 history
 *                   entries of label (nm-hell-noise) and priority churn: at Medium, at High (the very next entry raises
 *                   it to Highest) and at Lowest; it now sits in To Do at Low. 100+ entries precede the second entry
 *                   and 40+ follow it, so neither the first nor the last page of 100 entries is enough. Its
 *                   "– archived copy" entered In Progress twice (Low, then Medium) and is Done.
 *  - n35 worklogs:  KAN "Card vault DST migration" and its sub-task carry worklogs around the 2025 DST changes. Work
 *                   started on 26 Oct 2025 New York time (EDT) sums to 495 min (8h 15m); the parent alone (435), the
 *                   UTC date (445), the Budapest date (485, EU DST ended 2025-10-26 01:00Z) and all worklogs (990)
 *                   are the decoys.
 *  - n36 write:     KAN "Chargeback export" (In Progress) and its Done "(duplicate)" copy, linked with Duplicate.
 *
 * Idempotent where Jira allows it. History is append-only and NMS issues cannot be deleted, so the n34 issues are
 * written exactly once: when they exist, their live changelog is only replayed, never appended to, and a mismatch exits
 * 1 with instructions to retire them. Worklogs are found by their comment ("vault batch a"); missing ones are created,
 * wrong or duplicated ones fail. The n36 target is moved back to In Progress on every run (eval runs send it to
 * review). New NMS issues go into the future sprint id 5 so the NMS backlog facts stay unchanged. Every answer is
 * recomputed from live read-back and must equal the intended constant; the manifest is written only when every check
 * passes.
 *
 *   bun eval/nightmare/seed-hell-history.ts
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-hell-history.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PREFIX = "atl smoke nm hell ";
const SPRINT_ID = 5;
const PACE_MS = 200;
const MAX_ATTEMPTS = 5;
const TODO = "Teendő";
const DOING = "Folyamatban";
const DONE = "Kész";
const NOISE_LABEL = "nm-hell-noise";
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const MANIFEST = join(OUT, "hell-history.json");

type Obj = Record<string, unknown>;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let writes = 0;
let calls = 0;
const failures: string[] = [];

function log(message: string): void {
  process.stderr.write(`[nm-hell-history] ${message}\n`);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Obj {
  return isRecord(value) ? value : {};
}

function items(value: unknown): Obj[] {
  return asArray(record(value).items).filter(isRecord);
}

/** Descriptions and comments are a string or a list of lines. */
function bodyText(value: unknown): string {
  return typeof value === "string" ? value : asArray(value).map(asString).join("\n");
}

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

async function spawnAtl(argv: readonly string[]): Promise<Run> {
  for (let attempt = 1; ; attempt++) {
    await Bun.sleep(PACE_MS);
    const proc = Bun.spawn([ATL, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    calls += 1;
    if (exitCode !== 3 || attempt >= MAX_ATTEMPTS) {
      return { exitCode, stdout, stderr };
    }
    log(`atl ${argv.slice(0, 3).join(" ")}: transient, retrying`);
    await Bun.sleep(1500 * 2 ** (attempt - 1));
  }
}

async function atl(argv: readonly string[]): Promise<unknown> {
  const run = await spawnAtl(argv);
  if (run.exitCode !== 0) {
    throw new Error(`atl ${argv.slice(0, 5).join(" ")} exited ${run.exitCode}: ${(run.stderr.trim() || run.stdout.trim()).slice(0, 300)}`);
  }
  const text = run.stdout.trim();
  return text === "" ? {} : JSON.parse(text);
}

/** Parses Jira's "2026-10-23T10:56:09+0200" (no colon in the offset). */
function jiraTime(at: string): number {
  return Date.parse(at.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

// ---------------------------------------------------------------------------------------------------------------------
// Planted data

const LEDGER = {
  target: `${PREFIX}Ledger reconciliation job`,
  decoy: `${PREFIX}Ledger reconciliation job – archived copy`,
};

const VAULT = {
  parent: `${PREFIX}Card vault DST migration`,
  sub: `${PREFIX}Card vault DST migration – key escrow`,
};

const CHARGEBACK = {
  target: `${PREFIX}Chargeback export`,
  duplicate: `${PREFIX}Chargeback export (duplicate)`,
};

/** Changelog page size of the Jira API (and of the MCP tool): the second entry must lie beyond the first page. */
const PAGE = 100;
const MIN_AFTER_SECOND = 40;
const START_PRIORITY = "Low";
const TARGET_ENTRY_PRIORITIES = ["Medium", "High", "Lowest"];
const TARGET_NEXT_PRIORITY = "Highest";
const TARGET_CURRENT = { status: TODO, priority: "Low" };
const DECOY_ENTRY_PRIORITIES = ["Low", "Medium"];
const ANSWER_PRIORITY = "High";

interface WorklogSpec {
  batch: string;
  onSub: boolean;
  started: string;
  minutes: number;
}

const WORKLOGS: readonly WorklogSpec[] = [
  { batch: "a", onSub: false, started: "2025-10-25T21:30:00Z", minutes: 60 },
  { batch: "b", onSub: false, started: "2025-10-25T22:15:00Z", minutes: 120 },
  { batch: "c", onSub: false, started: "2025-10-26T00:30:00Z", minutes: 45 },
  { batch: "d", onSub: false, started: "2025-10-26T01:30:00Z", minutes: 30 },
  { batch: "h", onSub: false, started: "2025-10-26T05:00:00Z", minutes: 50 },
  { batch: "e", onSub: false, started: "2025-10-26T22:30:00Z", minutes: 180 },
  { batch: "f", onSub: false, started: "2025-10-26T23:10:00Z", minutes: 80 },
  { batch: "i", onSub: false, started: "2025-10-27T03:30:00Z", minutes: 125 },
  { batch: "g", onSub: false, started: "2025-10-27T08:00:00Z", minutes: 240 },
  { batch: "s", onSub: true, started: "2025-10-26T14:00:00Z", minutes: 60 },
];

const VAULT_DAY = "2025-10-26";
const VAULT_ZONE = "America/New_York";
const VAULT_MINUTES = { answer: 495, parentOnly: 435, utcDate: 445, budapestDate: 485, all: 990 };
const HOUR_MS = 3_600_000;
/** New York stays on EDT (UTC-4) until 2025-11-02; Budapest leaves CEST (UTC+2) for CET (UTC+1) at this instant. */
const EDT_OFFSET_HOURS = -4;
const EU_DST_END = Date.UTC(2025, 9, 26, 1);

const REVIEW = { started: "2025-10-20T07:00:00Z", seconds: 5400 };

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

const NEW_YORK_DAY = dayFormatter(VAULT_ZONE);
const BUDAPEST_DAY = dayFormatter("Europe/Budapest");
const UTC_DAY = dayFormatter("UTC");

// ---------------------------------------------------------------------------------------------------------------------
// Jira helpers

interface IssueState {
  key: string;
  summary: string;
  status: string;
  priority: string;
  sprintIds: number[];
  parent: string;
}

async function state(key: string): Promise<IssueState> {
  const raw = record(await atl(["issue", "get", key, "--issue-fields", "summary,status,priority,customfield_10020,parent"]));
  return {
    key: asString(raw.key),
    summary: asString(raw.summary),
    status: asString(raw.status),
    priority: typeof raw.priority === "string" ? raw.priority : asString(record(raw.priority).name),
    sprintIds: asArray(raw.customfield_10020).flatMap((sprint) => {
      const id = record(sprint).id;
      return typeof id === "number" ? [id] : [];
    }),
    parent: asString(record(raw.parent).key),
  };
}

/** Issues of `project` matching `phrase`, keyed by exact summary. */
async function findByPhrase(project: string, phrase: string): Promise<Map<string, string[]>> {
  const result = await atl(["jql", `project = ${project} AND summary ~ "${phrase}" ORDER BY created ASC`, "--all", "--issue-fields", "summary"]);
  const found = new Map<string, string[]>();
  for (const item of items(result)) {
    const summary = asString(item.summary);
    found.set(summary, [...(found.get(summary) ?? []), asString(item.key)]);
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

async function createIssue(project: string, type: string, summary: string, body: string, extra: readonly string[]): Promise<string> {
  const key = asString(record(await atl(["issue", "create", "--project", project, "--type", type, "--summary", summary, "--body", body, ...extra])).key);
  if (key === "") {
    throw new Error(`creating "${summary}" returned no key`);
  }
  writes += 1;
  log(`created ${key} ${summary}`);
  return key;
}

async function ensureStatus(key: string, status: string): Promise<void> {
  if ((await state(key)).status !== status) {
    await atl(["issue", "move", key, status]);
    writes += 1;
    log(`${key}: moved to ${status}`);
  }
}

/** Links `from` to `to` unless `from` already lists `to` with that type and relation (as `from` sees it). */
async function ensureLink(from: string, type: string, to: string, relation: string): Promise<void> {
  const links = items(await atl(["issue", "links", from]));
  const present = links.some((link) => asString(link.type) === type && asString(link.relation) === relation && asString(link.key) === to);
  if (!present) {
    await atl(["issue", "link", from, type, to]);
    writes += 1;
    log(`${from} ${type} ${to}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// n34: changelog plan and replay

interface Change {
  field: string;
  from: string;
  to: string;
}

interface Entry {
  changes: Change[];
}

type Step = { kind: "label"; on: boolean } | { kind: "priority"; name: string } | { kind: "move"; status: string };

/** A history plan; every step must change something (a no-op write leaves no history entry). */
interface Plan {
  priority: string;
  status: string;
  labelled: boolean;
  steps: Step[];
  history: Entry[];
}

function newPlan(): Plan {
  return { priority: START_PRIORITY, status: TODO, labelled: false, steps: [], history: [] };
}

function setPriority(plan: Plan, name: string): void {
  if (plan.priority === name) {
    throw new Error(`history plan: priority is already ${name}`);
  }
  plan.history.push({ changes: [{ field: "priority", from: plan.priority, to: name }] });
  plan.steps.push({ kind: "priority", name });
  plan.priority = name;
}

function moveTo(plan: Plan, status: string): void {
  if (plan.status === status) {
    throw new Error(`history plan: status is already ${status}`);
  }
  plan.history.push({ changes: [{ field: "status", from: plan.status, to: status }] });
  plan.steps.push({ kind: "move", status });
  plan.status = status;
}

function toggleLabel(plan: Plan): void {
  const on = !plan.labelled;
  plan.history.push({ changes: [{ field: "labels", from: on ? "" : NOISE_LABEL, to: on ? NOISE_LABEL : "" }] });
  plan.steps.push({ kind: "label", on });
  plan.labelled = on;
}

/** `count` noise entries: label toggles, every fourth one a priority change taken from `churn` (all of it is used). */
function noise(plan: Plan, count: number, churn: readonly string[]): void {
  const queue = [...churn];
  for (let index = 0; index < count; index++) {
    const next = index % 4 === 3 ? queue.shift() : undefined;
    if (next === undefined) {
      toggleLabel(plan);
    } else {
      setPriority(plan, next);
    }
  }
  if (queue.length > 0) {
    throw new Error(`history plan: ${queue.length} churn priorities left over`);
  }
}

/** ~150 entries: In Progress at Medium (entry ~25), at High (entry ~102, then Highest), at Lowest; ends To Do at Low. */
function targetPlan(): Plan {
  const plan = newPlan();
  noise(plan, 24, ["Lowest", "High", "Low", "Highest", "Low", "Lowest"]);
  setPriority(plan, "Medium");
  moveTo(plan, DOING);
  noise(plan, 30, ["High", "Medium", "Highest", "Low", "Lowest", "Medium", "High"]);
  moveTo(plan, TODO);
  noise(plan, 44, ["Medium", "Low", "Highest", "Lowest", "Medium", "Highest", "Low", "Lowest", "Medium", "Lowest", "Highest"]);
  setPriority(plan, "High");
  moveTo(plan, DOING);
  setPriority(plan, TARGET_NEXT_PRIORITY);
  noise(plan, 16, ["Medium", "High", "Highest", "Medium"]);
  moveTo(plan, TODO);
  noise(plan, 10, ["High", "Low"]);
  setPriority(plan, "Lowest");
  moveTo(plan, DOING);
  noise(plan, 10, ["Medium", "High"]);
  setPriority(plan, "Low");
  moveTo(plan, TODO);
  noise(plan, 6, []);
  return plan;
}

/** In Progress at Low, then at Medium, then Done. */
function decoyPlan(): Plan {
  const plan = newPlan();
  toggleLabel(plan);
  moveTo(plan, DOING);
  setPriority(plan, "Highest");
  moveTo(plan, TODO);
  toggleLabel(plan);
  setPriority(plan, "Medium");
  moveTo(plan, DOING);
  moveTo(plan, DONE);
  return plan;
}

async function apply(key: string, step: Step): Promise<void> {
  if (step.kind === "label") {
    await atl(["issue", "update", key, "--set", `labels=${JSON.stringify(step.on ? [NOISE_LABEL] : [])}`]);
  } else if (step.kind === "priority") {
    await atl(["issue", "update", key, "--set", `priority=${JSON.stringify({ name: step.name })}`]);
  } else {
    await atl(["issue", "move", key, step.status]);
  }
  writes += 1;
}

async function changelog(key: string): Promise<Entry[]> {
  return items(await atl(["issue", "changelog", key, "--all"])).map((entry) => ({
    changes: asArray(entry.changes)
      .filter(isRecord)
      .map((change) => ({ field: asString(change.field).toLowerCase(), from: asString(change.from), to: asString(change.to) })),
  }));
}

interface InProgressEntry {
  /** 0-based position in the changelog (oldest first) = number of entries before it. */
  index: number;
  /** Priority when the entry happened (before any change in the same entry). */
  priority: string;
}

interface Replay {
  total: number;
  entries: InProgressEntry[];
  /** Priority set by the entry right after the second In Progress entry ("" when that entry is not a lone priority change). */
  nextPriority: string;
  /** Every priority change starts from the replayed priority and the replay ends at the current one. */
  consistent: boolean;
}

/** Replays priority through the whole history: the initial priority is the `from` of the first priority change. */
function replay(history: readonly Entry[], currentPriority: string): Replay {
  const firstChange = history.flatMap((entry) => entry.changes).find((change) => change.field === "priority");
  let priority = firstChange?.from ?? currentPriority;
  let consistent = true;
  const entries: InProgressEntry[] = [];
  for (const [index, entry] of history.entries()) {
    if (entry.changes.some((change) => change.field === "status" && change.to === DOING)) {
      entries.push({ index, priority });
    }
    for (const change of entry.changes) {
      if (change.field === "priority") {
        consistent &&= change.from === priority;
        priority = change.to;
      }
    }
  }
  const second = entries[1];
  const next = second === undefined ? undefined : history[second.index + 1];
  const [only] = next?.changes ?? [];
  const nextPriority = next?.changes.length === 1 && only?.field === "priority" ? only.to : "";
  return { total: history.length, entries, nextPriority, consistent: consistent && priority === currentPriority };
}

function targetProblems(facts: Replay, status: string, priority: string): string[] {
  const problems: string[] = [];
  const [first, second] = facts.entries;
  const priorities = facts.entries.map((entry) => entry.priority);
  if (!facts.consistent) {
    problems.push("priority changes do not chain into the current priority");
  }
  if (JSON.stringify(priorities) !== JSON.stringify(TARGET_ENTRY_PRIORITIES)) {
    problems.push(`priorities at the In Progress entries ${JSON.stringify(priorities)}, expected ${JSON.stringify(TARGET_ENTRY_PRIORITIES)}`);
  }
  if (second === undefined || second.index < PAGE) {
    problems.push(`${second?.index ?? 0} entries before the second In Progress entry, need ${PAGE}+`);
  }
  if (second === undefined || facts.total - second.index - 1 < MIN_AFTER_SECOND) {
    problems.push(`${second === undefined ? 0 : facts.total - second.index - 1} entries after the second In Progress entry, need ${MIN_AFTER_SECOND}+`);
  }
  if (first === undefined || first.index >= facts.total - PAGE) {
    problems.push(`first In Progress entry (#${first?.index ?? "?"} of ${facts.total}) lies inside the last ${PAGE} entries`);
  }
  if (facts.nextPriority !== TARGET_NEXT_PRIORITY) {
    problems.push(`entry after the second In Progress entry sets priority "${facts.nextPriority}", expected ${TARGET_NEXT_PRIORITY}`);
  }
  if (status !== TARGET_CURRENT.status || priority !== TARGET_CURRENT.priority) {
    problems.push(`now ${status}/${priority}, expected ${TARGET_CURRENT.status}/${TARGET_CURRENT.priority}`);
  }
  return problems;
}

function decoyProblems(facts: Replay, status: string): string[] {
  const problems: string[] = [];
  const priorities = facts.entries.map((entry) => entry.priority);
  if (!facts.consistent) {
    problems.push("priority changes do not chain into the current priority");
  }
  if (JSON.stringify(priorities) !== JSON.stringify(DECOY_ENTRY_PRIORITIES)) {
    problems.push(`priorities at the In Progress entries ${JSON.stringify(priorities)}, expected ${JSON.stringify(DECOY_ENTRY_PRIORITIES)}`);
  }
  if (status !== DONE) {
    problems.push(`now ${status}, expected ${DONE}`);
  }
  return problems;
}

interface LedgerIssue {
  key: string;
  facts: Replay;
  live: IssueState;
}

/** Creates the issue and writes its whole history once; an existing issue is only replayed. */
async function ledgerIssue(found: Map<string, string[]>, summary: string, body: string, plan: Plan, problemsOf: (facts: Replay, live: IssueState) => string[]): Promise<LedgerIssue> {
  let key = exact(found, summary);
  if (key === undefined) {
    key = await createIssue("NMS", "Feladat", summary, body, ["--set", `Sprint=${SPRINT_ID}`, "--set", `priority=${JSON.stringify({ name: START_PRIORITY })}`]);
    for (const [index, step] of plan.steps.entries()) {
      await apply(key, step);
      if ((index + 1) % 25 === 0) {
        log(`${key}: ${index + 1}/${plan.steps.length} history writes`);
      }
    }
  } else {
    log(`${key} exists: replaying its history, never appending`);
  }
  const live = await state(key);
  const facts = replay(await changelog(key), live.priority);
  const problems = problemsOf(facts, live);
  if (!live.sprintIds.includes(SPRINT_ID)) {
    problems.push(`not in sprint id ${SPRINT_ID}`);
  }
  for (const problem of problems) {
    check(false, `${key} "${summary}": ${problem}`);
  }
  if (problems.length > 0) {
    log(`${key} cannot be repaired (history is append-only, NMS issues cannot be deleted). Retire it, then rerun to rebuild it: ${ATL} issue update ${key} --summary "${PREFIX}retired ${key}" && ${ATL} issue move ${key} ${DONE}`);
  }
  return { key, facts, live };
}

function assertPlan(label: string, problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(`${label} history plan is wrong (fix the seeder before writing anything): ${problems.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// n35: worklogs

interface LiveWorklog {
  issue: string;
  started: number;
  seconds: number;
  comment: string;
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest}m`;
  }
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

async function worklogs(key: string): Promise<LiveWorklog[]> {
  return items(await atl(["issue", "worklogs", key, "--all"])).map((worklog) => ({
    issue: key,
    started: jiraTime(asString(worklog.started)),
    seconds: typeof worklog.seconds === "number" ? worklog.seconds : 0,
    comment: bodyText(worklog.comment).trim(),
  }));
}

function minutesOn(logs: readonly LiveWorklog[], day: (started: number) => string): number {
  return logs.filter((worklog) => day(worklog.started) === VAULT_DAY).reduce((sum, worklog) => sum + worklog.seconds / 60, 0);
}

function isoDay(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

function budapestByOffset(millis: number): string {
  return isoDay(millis + (millis < EU_DST_END ? 2 : 1) * HOUR_MS);
}

async function seedVault(): Promise<Obj> {
  const found = await findByPhrase("KAN", VAULT.parent);
  const parent = exact(found, VAULT.parent) ?? (await createIssue("KAN", "Feladat", VAULT.parent, "Move the card vault batch jobs to the new key store. Batches are logged as separate worklogs.", []));
  const sub = exact(found, VAULT.sub) ?? (await createIssue("KAN", "Subtask", VAULT.sub, "Escrow the new vault keys with the second custodian.", ["--parent", parent]));

  const before = [...(await worklogs(parent)), ...(await worklogs(sub))];
  for (const spec of WORKLOGS) {
    const key = spec.onSub ? sub : parent;
    const comment = `vault batch ${spec.batch}`;
    if (!before.some((worklog) => worklog.issue === key && worklog.comment === comment)) {
      await atl(["issue", "log", key, duration(spec.minutes), "--started", spec.started, "--comment", comment]);
      writes += 1;
      log(`${key}: logged ${duration(spec.minutes)} at ${spec.started} (${comment})`);
    }
  }

  const subState = await state(sub);
  expect("vault sub-task: parent", subState.parent, parent);
  const logs = [...(await worklogs(parent)), ...(await worklogs(sub))];
  expect("vault: worklog count on parent + sub-task", logs.length, WORKLOGS.length);
  const rows: Obj[] = [];
  for (const spec of WORKLOGS) {
    const key = spec.onSub ? sub : parent;
    const matches = logs.filter((worklog) => worklog.issue === key && worklog.comment === `vault batch ${spec.batch}`);
    expect(`vault batch ${spec.batch}: worklogs on ${key}`, matches.length, 1);
    const [live] = matches;
    if (live !== undefined) {
      expect(`vault batch ${spec.batch}: started`, new Date(live.started).toISOString(), new Date(spec.started).toISOString());
      expect(`vault batch ${spec.batch}: seconds`, live.seconds, spec.minutes * 60);
      rows.push({
        batch: spec.batch,
        issue: key,
        started: new Date(live.started).toISOString(),
        minutes: live.seconds / 60,
        newYorkDay: NEW_YORK_DAY.format(live.started),
        utcDay: UTC_DAY.format(live.started),
        budapestDay: BUDAPEST_DAY.format(live.started),
      });
    }
  }
  for (const worklog of logs) {
    const at = new Date(worklog.started).toISOString();
    expect(`vault ${at}: New York day (Intl vs EDT offset)`, NEW_YORK_DAY.format(worklog.started), isoDay(worklog.started + EDT_OFFSET_HOURS * HOUR_MS));
    expect(`vault ${at}: Budapest day (Intl vs CEST/CET offset)`, BUDAPEST_DAY.format(worklog.started), budapestByOffset(worklog.started));
    expect(`vault ${at}: UTC day`, UTC_DAY.format(worklog.started), isoDay(worklog.started));
  }

  const minutes = {
    answer: minutesOn(logs, (at) => NEW_YORK_DAY.format(at)),
    parentOnly: minutesOn(
      logs.filter((worklog) => worklog.issue === parent),
      (at) => NEW_YORK_DAY.format(at),
    ),
    utcDate: minutesOn(logs, (at) => UTC_DAY.format(at)),
    budapestDate: minutesOn(logs, (at) => BUDAPEST_DAY.format(at)),
    all: logs.reduce((sum, worklog) => sum + worklog.seconds / 60, 0),
  };
  expect("vault: minutes (answer and decoys)", minutes, VAULT_MINUTES);
  check(new Set(Object.values(minutes)).size === Object.keys(minutes).length, "vault: answer and decoy sums must all differ");

  return {
    parent: { key: parent, summary: VAULT.parent },
    sub: { key: sub, summary: VAULT.sub },
    day: VAULT_DAY,
    timeZone: VAULT_ZONE,
    minutes,
    logs: rows,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// n36: review write target

async function seedChargeback(): Promise<Obj> {
  const found = await findByPhrase("KAN", CHARGEBACK.target);
  const target = exact(found, CHARGEBACK.target) ?? (await createIssue("KAN", "Feladat", CHARGEBACK.target, "Monthly chargeback export for finance: one CSV row per disputed payment.", []));
  const duplicate =
    exact(found, CHARGEBACK.duplicate) ??
    (await createIssue("KAN", "Feladat", CHARGEBACK.duplicate, `Raised twice from the finance queue; duplicate of ${target}. Do not work on this one.`, []));
  await ensureStatus(target, DOING);
  await ensureStatus(duplicate, DONE);
  await ensureLink(duplicate, "Duplicate", target, "duplicates");

  expect("chargeback target: status", (await state(target)).status, DOING);
  expect("chargeback duplicate: status", (await state(duplicate)).status, DONE);
  expect(
    "chargeback duplicate: links",
    items(await atl(["issue", "links", duplicate])).map((link) => `${asString(link.relation)} ${asString(link.key)}`),
    [`duplicates ${target}`],
  );
  return {
    target: { key: target, summary: CHARGEBACK.target },
    duplicate: { key: duplicate, summary: CHARGEBACK.duplicate },
    started: REVIEW.started,
    seconds: REVIEW.seconds,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Main

async function seedLedger(): Promise<Obj> {
  const target = targetPlan();
  const decoy = decoyPlan();
  assertPlan("target", targetProblems(replay(target.history, target.priority), target.status, target.priority));
  assertPlan("decoy", decoyProblems(replay(decoy.history, decoy.priority), decoy.status));

  const found = await findByPhrase("NMS", LEDGER.target);
  const t = await ledgerIssue(found, LEDGER.target, "Nightly job that reconciles the ledger totals against the acquirer settlement files.", target, (facts, live) =>
    targetProblems(facts, live.status, live.priority),
  );
  const d = await ledgerIssue(found, LEDGER.decoy, "Archived copy of the reconciliation job ticket, kept for reference.", decoy, (facts, live) => decoyProblems(facts, live.status));

  const [first, second, third] = t.facts.entries;
  const answer = second?.priority ?? "";
  expect("ledger: answer priority", answer, ANSWER_PRIORITY);
  return {
    target: { key: t.key, summary: LEDGER.target },
    decoy: { key: d.key, summary: LEDGER.decoy },
    answer,
    decoys: {
      firstEntry: first?.priority ?? "",
      nextEntry: t.facts.nextPriority,
      thirdEntry: third?.priority ?? "",
      current: t.live.priority,
    },
    inProgressEntries: t.facts.entries,
    entries: t.facts.total,
    beforeSecond: second?.index ?? 0,
    afterSecond: second === undefined ? 0 : t.facts.total - second.index - 1,
    current: { status: t.live.status, priority: t.live.priority },
    decoyInProgressEntries: d.facts.entries,
    decoyStatus: d.live.status,
  };
}

async function main(): Promise<void> {
  const ledger = await seedLedger();
  const vault = await seedVault();
  const review = await seedChargeback();
  if (failures.length > 0) {
    log(`${failures.length} failed checks; ${writes} writes this run; manifest NOT written`);
    process.exit(1);
  }
  const minutes = record(vault.minutes);
  const manifest = {
    generatedAt: new Date().toISOString(),
    changelog: ledger,
    worklogs: vault,
    review,
    facts: [
      {
        id: "hell-changelog-second-entry",
        question: `What was the priority of "${LEDGER.target}" when it entered In Progress for the second time?`,
        answer: `${ANSWER_PRIORITY} (${asString(record(ledger.target).key)})`,
        whyHard: `~${String(ledger.entries)} history entries; ${String(ledger.beforeSecond)} before the second entry and ${String(ledger.afterSecond)} after it, so neither the first nor the last page of ${PAGE} suffices; decoys: ${JSON.stringify(ledger.decoys)} and the archived copy ${asString(record(ledger.decoy).key)}`,
      },
      {
        id: "hell-dst-worklogs",
        question: `How much work was logged on "${VAULT.parent}" and its sub-tasks for work started on ${VAULT_DAY} in ${VAULT_ZONE}?`,
        answer: `${String(minutes.answer)} min (8h 15m)`,
        whyHard: `start instants straddle both DST changes; parent only ${String(minutes.parentOnly)}, UTC date ${String(minutes.utcDate)}, Budapest date ${String(minutes.budapestDate)}, all ${String(minutes.all)}`,
      },
      {
        id: "hell-write-review-worklog",
        question: "Send the chargeback export to review and log 1h 30m started 2025-10-20 09:00 Budapest time.",
        answer: `${asString(record(review.target).key)} -> Ellenőrzés alatt, worklog 5400 s started ${REVIEW.started}; not ${asString(record(review.duplicate).key)} (Done duplicate)`,
        whyHard: "a Done duplicate with the same summary prefix; 09:00 Budapest in October is CEST, i.e. 07:00Z",
      },
    ],
    writesThisRun: writes,
    atlCalls: calls,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote ${MANIFEST}; ${writes} writes this run; ${calls} atl calls`);
}

await main();
