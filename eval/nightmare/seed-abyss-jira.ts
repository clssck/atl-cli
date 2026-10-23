#!/usr/bin/env bun
/**
 * Corporate-nightmare "abyss" Jira seed (n43-n45): data that the default first page or the issue-embedded field
 * silently leaves out. Everything is created through the atl binary with summaries prefixed `atl smoke nm abyss ` and
 * labels prefixed `nm-abyss-`; nothing existing is modified.
 *
 *  - n43 comments:  KAN "Settlement cutover decision" carries 240 comments, "Note 001:" .. "Note 240:", oldest first.
 *                   Jira lists comments oldest first and atl's default page is 25, so the first page only shows
 *                   "FINAL: Option A" (notes 4 and 11). Note 120 agrees Option B, note 200 decides Option C, and the
 *                   last note (240) records the CAB's final decision, Option D, superseding all earlier ones.
 *  - n44 worklogs:  KAN "Ledger replay effort" carries 45 worklogs, September to November 2025; the issue embeds only
 *                   20 of them. Work started in October 2025, Budapest time, sums to 2395 min (39h 55m): 2025-09-30
 *                   22:30Z is 1 Oct 00:30 CEST (counts), 2025-10-31 23:30Z is 1 Nov 00:30 CET (does not), and two
 *                   worklogs straddle the 26 Oct DST switch. Decoys: October among the embedded 20 (965), the UTC month
 *                   (2415), everything (4180), a fixed +02:00 (2335) or +01:00 (2300) offset.
 *  - n45 write:     27 open KAN issues labelled nm-abyss-rollout (9 each in Teendő, Folyamatban, Ellenőrzés alatt),
 *                   6 Kész ones with the same label and 5 open ones labelled nm-abyss-rollout-old. 27 is more than
 *                   the 25-issue default page.
 *
 * Idempotent where Jira allows it. Comments are append-only and their order is the answer, so the live thread must be
 * an exact prefix "Note 001" .. "Note k" of the plan; the missing notes k+1 .. 240 are then appended in order, and any
 * gap, duplicate, reordering, edit or foreign comment exits 1 with instructions. Worklogs are found by their comment
 * ("ledger replay w01"); missing ones are created, wrong or duplicated ones fail. Rollout issues are found by summary;
 * labels and status are repaired. Every answer is recomputed from live read-back (October in Europe/Budapest via Intl)
 * and must equal the intended constant; the manifest is written only when every check passes.
 *
 *   bun eval/nightmare/seed-abyss-jira.ts
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-abyss-jira.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PREFIX = "atl smoke nm abyss ";
const PACE_MS = 200;
const MAX_ATTEMPTS = 5;
const TODO = "Teendő";
const DOING = "Folyamatban";
const REVIEW = "Ellenőrzés alatt";
const DONE = "Kész";
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const MANIFEST = join(OUT, "abyss-jira.json");

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
  process.stderr.write(`[nm-abyss-jira] ${message}\n`);
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

/** Comment bodies are a string or a list of lines. */
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
// Jira helpers

interface LiveIssue {
  key: string;
  summary: string;
  status: string;
  labels: string[];
}

/** Issues of `project` matching `jql`, keyed by exact summary. */
async function findIssues(jql: string): Promise<Map<string, LiveIssue[]>> {
  const result = await atl(["jql", `${jql} ORDER BY created ASC`, "--all", "--issue-fields", "summary,status,labels"]);
  const found = new Map<string, LiveIssue[]>();
  for (const item of items(result)) {
    const live: LiveIssue = {
      key: asString(item.key),
      summary: asString(item.summary),
      status: asString(item.status),
      labels: asArray(item.labels).map(asString).toSorted(),
    };
    found.set(live.summary, [...(found.get(live.summary) ?? []), live]);
  }
  return found;
}

/** The one issue named exactly `summary`; two of them is a loud failure (nothing here deletes issues). */
function exact(found: Map<string, LiveIssue[]>, summary: string): LiveIssue | undefined {
  const matches = found.get(summary) ?? [];
  if (matches.length > 1) {
    throw new Error(`${matches.length} issues are named "${summary}" (${matches.map((issue) => issue.key).join(", ")}): retire all but one and rerun`);
  }
  return matches[0];
}

interface IssueSpec {
  summary: string;
  body: string;
  labels: string[];
  status: string;
}

async function createIssue(spec: IssueSpec): Promise<string> {
  const args = ["issue", "create", "--project", "KAN", "--type", "Feladat", "--summary", spec.summary, "--body", spec.body];
  if (spec.labels.length > 0) {
    args.push("--set", `labels=${JSON.stringify(spec.labels)}`);
  }
  if (spec.status !== TODO) {
    args.push("--transition", spec.status);
  }
  const key = asString(record(await atl(args)).key);
  if (key === "") {
    throw new Error(`creating "${spec.summary}" returned no key`);
  }
  writes += 1;
  log(`created ${key} ${spec.summary}`);
  return key;
}

/** Creates the issue, or repairs the labels and status of the existing one. */
async function ensureIssue(found: Map<string, LiveIssue[]>, spec: IssueSpec): Promise<string> {
  const live = exact(found, spec.summary);
  if (live === undefined) {
    return await createIssue(spec);
  }
  if (JSON.stringify(live.labels) !== JSON.stringify(spec.labels.toSorted())) {
    await atl(["issue", "update", live.key, "--set", `labels=${JSON.stringify(spec.labels)}`]);
    writes += 1;
    log(`${live.key}: labels ${JSON.stringify(live.labels)} -> ${JSON.stringify(spec.labels)}`);
  }
  if (live.status !== spec.status) {
    await atl(["issue", "move", live.key, spec.status]);
    writes += 1;
    log(`${live.key}: moved ${live.status} -> ${spec.status}`);
  }
  return live.key;
}

// ---------------------------------------------------------------------------------------------------------------------
// n43: comment thread whose last comment overrides the confident first page

const CUTOVER = `${PREFIX}Settlement cutover decision`;
const COMMENT_COUNT = 240;
/** `atl issue comments` default page size; Jira returns comments oldest first. */
const COMMENT_PAGE = 25;
const NOTE = /^Note (\d{3}): /;
/** A comment that records a decision: a decision word, then the option it names, in one sentence. */
const DECISION = /\b(?:FINAL|agreed|decision)\b[^.]*?\bOption ([A-D])\b/i;
const ANSWER_OPTION = "D";

interface CutoverOption {
  letter: string;
  label: string;
  /** Phrases that name the option without its letter (lower case). */
  keywords: string[];
}

const OPTIONS: readonly CutoverOption[] = [
  { letter: "A", label: "a big-bang weekend cutover", keywords: ["big-bang", "big bang"] },
  { letter: "B", label: "a parallel run for two settlement cycles", keywords: ["parallel run"] },
  { letter: "C", label: "a phased cutover by region", keywords: ["phased", "by region"] },
  { letter: "D", label: "shadow settlement with a dark launch", keywords: ["shadow settlement", "dark launch"] },
];

const PLANNED_DECISIONS = [
  { note: 4, option: "A" },
  { note: 11, option: "A" },
  { note: 120, option: "B" },
  { note: 200, option: "C" },
  { note: 240, option: "D" },
];

const KEY_NOTES: ReadonlyMap<number, string> = new Map([
  [1, `Kick-off. Options on the table for the settlement cutover: ${OPTIONS.map((option) => `Option ${option.letter}, ${option.label}`).join("; ")}.`],
  [4, "FINAL: Option A. Big-bang weekend cutover, settled in the architecture sync. No further discussion needed."],
  [11, "Finance confirmed it too: the decision is final, Option A on the first weekend of the quarter."],
  [19, "Runbook drafted for Option A, the big-bang weekend cutover."],
  [60, "Risk review: a single weekend window for Option A leaves no room for a rollback."],
  [118, "Steering call tomorrow to revisit the cutover approach."],
  [120, "Steering call outcome, agreed by all leads: Option B, a parallel run for two settlement cycles. This replaces Option A."],
  [150, "Runbook rewritten for Option B, the parallel run."],
  [185, "Regional leads ask whether a phased approach would be safer than the parallel run."],
  [200, "Decision: Option C, a phased cutover by region, signed off by the programme lead. Option B is dropped."],
  [220, "Runbook updated for Option C, region by region."],
  [236, "Change request for the cutover submitted to the CAB; they meet on Thursday."],
  [238, "Reminder: Option C remains the plan of record until the CAB rules."],
  [
    240,
    "CAB final decision: Option D, shadow settlement with a dark launch. This supersedes every earlier decision in this thread, including Option A, Option B and Option C.",
  ],
]);

/** Routine status notes: no option, no decision word. */
const FILLERS: readonly ((n: number) => string)[] = [
  (n) => `Reconciliation dry run ${n} finished; ${n % 7} breaks, all explained by timing differences.`,
  (n) => `Test environment refreshed from the settlement snapshot of week ${(n % 40) + 1}.`,
  (n) => `Acquirer file format check passed for batch ${1000 + n}.`,
  (n) => `Stand-up: data migration scripts at ${(n * 3) % 100} percent.`,
  () => "Treasury asked for the cutover calendar again; pointed them at the runbook.",
  (n) => `Rehearsal ${n} logged; rollback took ${20 + (n % 30)} minutes.`,
  () => "Monitoring dashboards for settlement latency updated.",
  (n) => `Vendor ticket CLR-${300 + n} on the clearing interface closed.`,
];

function noteText(note: number): string {
  const body = KEY_NOTES.get(note) ?? FILLERS[note % FILLERS.length]?.(note) ?? "";
  return `Note ${String(note).padStart(3, "0")}: ${body}`;
}

interface LiveComment {
  id: string;
  text: string;
}

async function comments(key: string): Promise<LiveComment[]> {
  return items(await atl(["issue", "comments", key, "--all"])).map((comment) => ({ id: asString(comment.id), text: bodyText(comment.body).trim() }));
}

/** The live thread must be notes 1 .. k exactly as planned, in order; anything else needs a human. */
function threadProblems(thread: readonly LiveComment[]): string[] {
  const problems: string[] = [];
  thread.forEach((comment, index) => {
    const expected = noteText(index + 1);
    if (comment.text !== expected) {
      problems.push(`comment ${comment.id} at position ${index + 1}: ${JSON.stringify(comment.text.slice(0, 80))}, expected ${JSON.stringify(expected.slice(0, 80))}`);
    }
  });
  if (thread.length > COMMENT_COUNT) {
    problems.push(`${thread.length} comments, more than the planned ${COMMENT_COUNT}`);
  }
  return problems;
}

function decisionsIn(thread: readonly LiveComment[]): { note: number; option: string }[] {
  return thread.flatMap((comment) => {
    const option = DECISION.exec(comment.text)?.[1];
    const note = NOTE.exec(comment.text)?.[1];
    return option === undefined || note === undefined ? [] : [{ note: Number(note), option: option.toUpperCase() }];
  });
}

async function seedCutover(): Promise<Obj> {
  const found = await findIssues(`project = KAN AND summary ~ "${CUTOVER}"`);
  const key =
    exact(found, CUTOVER)?.key ??
    (await createIssue({
      summary: CUTOVER,
      body: "Which approach do we take for the settlement platform cutover? The discussion and every decision are in the comments.",
      labels: [],
      status: TODO,
    }));

  const before = await comments(key);
  const problems = threadProblems(before);
  if (problems.length > 0) {
    throw new Error(
      `${key}: the live comment thread is not a prefix of the plan, so appending would scramble the order:\n  ${problems.slice(0, 10).join("\n  ")}\nDelete the stray comments with \`atl issue comment-delete ${key} <id> --yes\` (or retire the issue by renaming it) and rerun`,
    );
  }
  for (let note = before.length + 1; note <= COMMENT_COUNT; note++) {
    await atl(["issue", "comment", key, "--body", noteText(note)]);
    writes += 1;
    if (note % 20 === 0 || KEY_NOTES.has(note)) {
      log(`${key}: comment ${note}/${COMMENT_COUNT}`);
    }
  }

  const thread = await comments(key);
  expect("cutover: comment count", thread.length, COMMENT_COUNT);
  for (const problem of threadProblems(thread)) {
    check(false, `cutover: ${problem}`);
  }
  const decisions = decisionsIn(thread);
  expect("cutover: decisions in thread order", decisions, PLANNED_DECISIONS);
  const answer = decisions.at(-1);
  expect("cutover: final decision", answer?.option, ANSWER_OPTION);
  expect("cutover: final decision is the last comment", answer?.note, COMMENT_COUNT);

  const firstPage = items(await atl(["issue", "comments", key])).map((comment) => bodyText(comment.body).trim());
  expect("cutover: default page size", firstPage.length, COMMENT_PAGE);
  const firstPageOptions = [...new Set(decisionsIn(firstPage.map((text, index) => ({ id: String(index), text }))).map((decision) => decision.option))];
  expect("cutover: decisions visible on the default first page", firstPageOptions, ["A"]);
  check(!firstPage.some((text) => /\bOption D\b/.test(text) && DECISION.test(text)), "cutover: the default first page must not show the final decision");

  const embedded = record(record(record(await atl(["issue", "get", key, "--issue-fields", "comment", "--full"])).fields).comment);
  const embeddedEvidence = {
    maxResults: embedded.maxResults,
    total: embedded.total,
    shown: asArray(embedded.comments).length,
  };
  log(`cutover: comments embedded in the issue: ${JSON.stringify(embeddedEvidence)}`);

  const answerOption = OPTIONS.find((option) => option.letter === ANSWER_OPTION);
  return {
    issue: { key, summary: CUTOVER },
    comments: thread.length,
    answer: `Option ${ANSWER_OPTION}`,
    answerNote: answer?.note ?? 0,
    answerLabel: answerOption?.label ?? "",
    options: OPTIONS,
    decisions,
    firstPage: { size: COMMENT_PAGE, options: firstPageOptions },
    embedded: embeddedEvidence,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// n44: worklogs beyond the 20 embedded ones, counted by Budapest calendar month

const EFFORT = `${PREFIX}Ledger replay effort`;
const MONTH = "2025-10";
const ZONE = "Europe/Budapest";
const EMBEDDED_WORKLOGS = 20;
const HOUR_MS = 3_600_000;
/** Budapest leaves CEST (UTC+2) for CET (UTC+1) at this instant. */
const EU_DST_END = Date.UTC(2025, 9, 26, 1);
const EFFORT_MINUTES = { answer: 2395, embedded20: 965, utcMonth: 2415, all: 4180, fixedCest: 2335, fixedCet: 2300 };

/** [started (UTC), minutes] in creation order, which is also chronological order. */
const EFFORT_LOGS: readonly (readonly [string, number])[] = [
  ["2025-09-02T07:00:00Z", 120],
  ["2025-09-04T08:30:00Z", 90],
  ["2025-09-08T06:15:00Z", 45],
  ["2025-09-11T12:00:00Z", 180],
  ["2025-09-15T07:30:00Z", 60],
  ["2025-09-18T13:45:00Z", 75],
  ["2025-09-22T08:00:00Z", 150],
  ["2025-09-25T09:10:00Z", 35],
  ["2025-09-29T14:00:00Z", 105],
  // 23:30 CEST on 30 Sep: September in every reading.
  ["2025-09-30T21:30:00Z", 50],
  // 00:30 CEST on 1 Oct: October in Budapest, September in UTC and at a fixed +01:00.
  ["2025-09-30T22:30:00Z", 95],
  ["2025-10-01T07:00:00Z", 120],
  ["2025-10-02T11:20:00Z", 40],
  ["2025-10-03T06:45:00Z", 135],
  ["2025-10-06T08:00:00Z", 60],
  ["2025-10-07T12:30:00Z", 25],
  ["2025-10-08T07:15:00Z", 210],
  ["2025-10-09T13:00:00Z", 55],
  ["2025-10-10T09:40:00Z", 80],
  ["2025-10-13T06:30:00Z", 145],
  ["2025-10-14T10:00:00Z", 70],
  ["2025-10-15T07:50:00Z", 100],
  ["2025-10-16T12:10:00Z", 30],
  ["2025-10-17T08:20:00Z", 165],
  ["2025-10-20T07:00:00Z", 85],
  ["2025-10-21T13:30:00Z", 40],
  ["2025-10-22T06:00:00Z", 125],
  ["2025-10-23T09:00:00Z", 65],
  ["2025-10-24T11:45:00Z", 110],
  // 02:30 CEST and 02:30 CET on 26 Oct: the DST switch repeats the wall-clock hour.
  ["2025-10-26T00:30:00Z", 75],
  ["2025-10-26T01:30:00Z", 45],
  ["2025-10-27T07:30:00Z", 190],
  ["2025-10-28T08:15:00Z", 35],
  ["2025-10-29T12:00:00Z", 95],
  ["2025-10-30T07:40:00Z", 140],
  // 23:30 CET on 31 Oct: October in Budapest, November at a fixed +02:00.
  ["2025-10-31T22:30:00Z", 60],
  // 00:30 CET on 1 Nov: November in Budapest, October in UTC.
  ["2025-10-31T23:30:00Z", 115],
  ["2025-11-03T08:00:00Z", 90],
  ["2025-11-04T07:10:00Z", 130],
  ["2025-11-05T12:20:00Z", 45],
  ["2025-11-06T09:30:00Z", 160],
  ["2025-11-10T07:00:00Z", 75],
  ["2025-11-12T13:15:00Z", 55],
  ["2025-11-17T08:45:00Z", 120],
  ["2025-11-20T10:00:00Z", 85],
];

function monthFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" });
}

const BUDAPEST_MONTH = monthFormatter(ZONE);
const UTC_MONTH = monthFormatter("UTC");

/** "2025-10" (en-CA formats a year-month as "2025-10"). */
function monthIn(formatter: Intl.DateTimeFormat): (millis: number) => string {
  return (millis) => formatter.format(millis).slice(0, 7);
}

function offsetMonth(hours: number): (millis: number) => string {
  return (millis) => new Date(millis + hours * HOUR_MS).toISOString().slice(0, 7);
}

function budapestByOffset(millis: number): string {
  return offsetMonth(millis < EU_DST_END ? 2 : 1)(millis);
}

function worklogMarker(index: number): string {
  return `ledger replay w${String(index + 1).padStart(2, "0")}`;
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest}m`;
  }
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

interface LiveWorklog {
  started: number;
  seconds: number;
  comment: string;
}

async function worklogs(key: string): Promise<LiveWorklog[]> {
  return items(await atl(["issue", "worklogs", key, "--all"])).map((worklog) => ({
    started: jiraTime(asString(worklog.started)),
    seconds: typeof worklog.seconds === "number" ? worklog.seconds : 0,
    comment: bodyText(worklog.comment).trim(),
  }));
}

interface Timed {
  started: number;
  seconds: number;
}

function minutesIn(logs: readonly Timed[], month: (millis: number) => string): number {
  return logs.filter((worklog) => month(worklog.started) === MONTH).reduce((sum, worklog) => sum + worklog.seconds / 60, 0);
}

async function seedEffort(): Promise<Obj> {
  const found = await findIssues(`project = KAN AND summary ~ "${EFFORT}"`);
  const key =
    exact(found, EFFORT)?.key ??
    (await createIssue({
      summary: EFFORT,
      body: "Replay of the ledger journal after the settlement migration. Each working session is logged as its own worklog.",
      labels: [],
      status: DOING,
    }));

  const before = await worklogs(key);
  for (const [index, [started, minutes]] of EFFORT_LOGS.entries()) {
    const comment = worklogMarker(index);
    if (!before.some((worklog) => worklog.comment === comment)) {
      await atl(["issue", "log", key, duration(minutes), "--started", started, "--comment", comment]);
      writes += 1;
      log(`${key}: logged ${duration(minutes)} at ${started} (${comment})`);
    }
  }

  const logs = await worklogs(key);
  expect("effort: worklog count", logs.length, EFFORT_LOGS.length);
  const rows: Obj[] = [];
  for (const [index, [started, minutes]] of EFFORT_LOGS.entries()) {
    const comment = worklogMarker(index);
    const matches = logs.filter((worklog) => worklog.comment === comment);
    expect(`effort ${comment}: worklogs`, matches.length, 1);
    const [live] = matches;
    if (live !== undefined) {
      expect(`effort ${comment}: started`, new Date(live.started).toISOString(), new Date(started).toISOString());
      expect(`effort ${comment}: seconds`, live.seconds, minutes * 60);
      rows.push({ worklog: comment, started: new Date(live.started).toISOString(), minutes: live.seconds / 60, budapestMonth: monthIn(BUDAPEST_MONTH)(live.started), utcMonth: monthIn(UTC_MONTH)(live.started) });
    }
  }
  for (const worklog of logs) {
    expect(`effort ${worklog.comment}: Budapest month (Intl vs CEST/CET offset)`, monthIn(BUDAPEST_MONTH)(worklog.started), budapestByOffset(worklog.started));
  }

  const fields = record(record(await atl(["issue", "get", key, "--issue-fields", "worklog,timespent", "--full"])).fields);
  const worklogField = record(fields.worklog);
  const embedded: Timed[] = asArray(worklogField.worklogs)
    .filter(isRecord)
    .map((worklog) => ({ started: jiraTime(asString(worklog.started)), seconds: typeof worklog.timeSpentSeconds === "number" ? worklog.timeSpentSeconds : 0 }));
  const embeddedEvidence = { maxResults: worklogField.maxResults, total: worklogField.total, shown: embedded.length };
  expect("effort: worklogs embedded in the issue", embeddedEvidence, { maxResults: EMBEDDED_WORKLOGS, total: EFFORT_LOGS.length, shown: EMBEDDED_WORKLOGS });
  expect("effort: issue timespent (seconds)", fields.timespent, EFFORT_MINUTES.all * 60);

  const minutes = {
    answer: minutesIn(logs, monthIn(BUDAPEST_MONTH)),
    embedded20: minutesIn(embedded, monthIn(BUDAPEST_MONTH)),
    utcMonth: minutesIn(logs, monthIn(UTC_MONTH)),
    all: logs.reduce((sum, worklog) => sum + worklog.seconds / 60, 0),
    fixedCest: minutesIn(logs, offsetMonth(2)),
    fixedCet: minutesIn(logs, offsetMonth(1)),
  };
  expect("effort: minutes (answer and decoys)", minutes, EFFORT_MINUTES);
  check(new Set(Object.values(minutes)).size === Object.keys(minutes).length, "effort: answer and decoy sums must all differ");

  return {
    issue: { key, summary: EFFORT },
    month: MONTH,
    timeZone: ZONE,
    worklogs: logs.length,
    embedded: embeddedEvidence,
    minutes,
    logs: rows,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// n45: bulk comment write targets

const ROLLOUT_LABEL = "nm-abyss-rollout";
const OLD_LABEL = "nm-abyss-rollout-old";
const ROLLOUT = `${PREFIX}Rollout `;
const OLD_ROLLOUT = `${PREFIX}Rollout (old plan) `;
/** atl's default `jql` page: the open issues must not fit on it. */
const JQL_PAGE = 25;
const OPEN_STATUSES = [TODO, DOING, REVIEW];

const TARGET_SERVICES = [
  "payments-gateway",
  "card-vault",
  "ledger-core",
  "fx-rates",
  "settlement-batch",
  "chargeback-api",
  "kyc-checks",
  "fraud-scoring",
  "notifications",
  "statement-render",
  "merchant-portal",
  "payout-scheduler",
  "risk-limits",
  "audit-trail",
  "recon-engine",
  "refund-service",
  "invoice-export",
  "tax-engine",
  "loyalty-points",
  "webhook-relay",
  "token-service",
  "pricing-rules",
  "dispute-desk",
  "report-builder",
  "iban-validator",
  "sanctions-screen",
  "cash-forecast",
];
const DONE_SERVICES = ["legacy-sftp", "batch-printer", "fax-bridge", "pos-sync", "mainframe-adapter", "sms-otp"];
/** The old plan reuses five target service names. */
const OLD_SERVICES = TARGET_SERVICES.slice(0, 5);

type Role = "target" | "done" | "old";

interface RolloutSpec extends IssueSpec {
  role: Role;
}

function rolloutSpecs(): RolloutSpec[] {
  return [
    ...TARGET_SERVICES.map((service, index) => ({
      role: "target" as const,
      summary: `${ROLLOUT}${service}`,
      body: `Roll the settlement client v4 out to ${service}.`,
      labels: [ROLLOUT_LABEL],
      status: OPEN_STATUSES[index % OPEN_STATUSES.length] ?? TODO,
    })),
    ...DONE_SERVICES.map((service) => ({
      role: "done" as const,
      summary: `${ROLLOUT}${service}`,
      body: `Roll the settlement client v4 out to ${service}.`,
      labels: [ROLLOUT_LABEL],
      status: DONE,
    })),
    ...OLD_SERVICES.map((service, index) => ({
      role: "old" as const,
      summary: `${OLD_ROLLOUT}${service}`,
      body: `Superseded rollout plan for ${service} (settlement client v3); kept for reference.`,
      labels: [OLD_LABEL],
      status: index % 2 === 0 ? TODO : DOING,
    })),
  ];
}

const ROLLOUT_JQL = `project = KAN AND (labels in (${ROLLOUT_LABEL}, ${OLD_LABEL}) OR summary ~ "${PREFIX}Rollout")`;

function brief(issue: LiveIssue): Obj {
  return { key: issue.key, summary: issue.summary, status: issue.status };
}

async function seedRollout(): Promise<Obj> {
  const specs = rolloutSpecs();
  const found = await findIssues(ROLLOUT_JQL);
  for (const spec of specs) {
    await ensureIssue(found, spec);
  }

  const live = await findIssues(ROLLOUT_JQL);
  const rows: Record<Role, LiveIssue[]> = { target: [], done: [], old: [] };
  for (const spec of specs) {
    const issue = exact(live, spec.summary);
    check(issue !== undefined, `rollout "${spec.summary}": missing after seeding`);
    if (issue !== undefined) {
      expect(`rollout ${issue.key}: labels`, issue.labels, spec.labels.toSorted());
      expect(`rollout ${issue.key}: status`, issue.status, spec.status);
      rows[spec.role].push(issue);
    }
  }
  const planned = new Set(specs.map((spec) => spec.summary));
  const labelled = [...live.values()].flat().filter((issue) => issue.labels.some((label) => label === ROLLOUT_LABEL || label === OLD_LABEL));
  expect(
    "rollout: no other KAN issue carries the rollout labels",
    labelled.filter((issue) => !planned.has(issue.summary)).map((issue) => issue.key),
    [],
  );
  const openLabelled = labelled.filter((issue) => issue.labels.includes(ROLLOUT_LABEL) && issue.status !== DONE);
  expect("rollout: open issues labelled nm-abyss-rollout", openLabelled.length, TARGET_SERVICES.length);
  check(openLabelled.length > JQL_PAGE, `rollout: ${openLabelled.length} open targets must exceed the ${JQL_PAGE}-issue default page`);

  return {
    label: ROLLOUT_LABEL,
    oldLabel: OLD_LABEL,
    targets: rows.target.map(brief),
    done: rows.done.map(brief),
    old: rows.old.map(brief),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  const cutover = await seedCutover();
  const effort = await seedEffort();
  const rollout = await seedRollout();
  if (failures.length > 0) {
    log(`${failures.length} failed checks; ${writes} writes this run; manifest NOT written`);
    process.exit(1);
  }
  const minutes = record(effort.minutes);
  const targets = asArray(rollout.targets).length;
  const manifest = {
    generatedAt: new Date().toISOString(),
    comments: cutover,
    worklogs: effort,
    rollout,
    facts: [
      {
        id: "abyss-comment-latest-decision",
        question: `What did the team finally decide for the settlement cutover ("${CUTOVER}")?`,
        answer: `${asString(cutover.answer)} (${asString(cutover.answerLabel)}), note ${String(cutover.answerNote)} of ${String(cutover.comments)} (${asString(record(cutover.issue).key)})`,
        whyHard: `${String(cutover.comments)} comments oldest first; the default first page of ${COMMENT_PAGE} declares "FINAL: Option A"; Option B (note 120) and Option C (note 200) follow; only the last comment holds the CAB decision`,
      },
      {
        id: "abyss-worklog-october",
        question: `How much time was logged on "${EFFORT}" for work started in October 2025, Budapest local time?`,
        answer: `${String(minutes.answer)} min (${duration(EFFORT_MINUTES.answer)})`,
        whyHard: `${String(effort.worklogs)} worklogs, the issue embeds ${EMBEDDED_WORKLOGS} (October among them ${String(minutes.embedded20)}); UTC month ${String(minutes.utcMonth)}, all ${String(minutes.all)}, fixed +02:00 ${String(minutes.fixedCest)}, fixed +01:00 ${String(minutes.fixedCet)}`,
      },
      {
        id: "abyss-write-bulk-comment",
        question: `Comment on every open KAN issue labelled ${ROLLOUT_LABEL}; how many?`,
        answer: `${targets} issues`,
        whyHard: `${targets} open targets exceed the ${JQL_PAGE}-issue default page; ${asArray(rollout.done).length} Kész issues share the label and ${asArray(rollout.old).length} open issues carry ${OLD_LABEL} with the same service names`,
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
