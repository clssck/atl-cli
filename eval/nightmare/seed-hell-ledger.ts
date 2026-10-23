#!/usr/bin/env bun
/**
 * Corporate-nightmare "hell" KAN seed (idempotent) for the read scenarios n37, n38 and n42. Everything is created
 * through the atl binary in project KAN and prefixed `atl smoke nm hell `; nothing existing is modified.
 *
 *  - n37 ledger sum:     144 "Ledger batch NNN" issues. 112 carry the label nm-hell-ledger, are not done and are due
 *                        in November 2026 (both boundary days included); their description states an amount ("Amount:
 *                        EUR 4210."), twelve of them a corrected one ("EUR <new> (corrected from EUR <old> ...)") and
 *                        three "Amount: pending" (counted, adds 0). Excluded look-alikes: 9 done, 6 due 2026-10-31,
 *                        4 due 2026-12-01, 5 without a due date, 8 labelled nm-hell-ledger-archive. More than 100
 *                        matches, so a single result page cuts the answer short.
 *  - n38 duplicates:     five "Card token rotation" issues; A, B and C duplicate D (D "is duplicated by" all three),
 *                        E relates to A. A, B, C are Kész, D Teendő, E Folyamatban. The descriptions are stale and
 *                        point the other way (A calls itself canonical, D says it is a duplicate of A).
 *  - n42 ADF date:       "Merchant portal go-live" with an ADF description: a superseded planned date node
 *                        (2026-11-17), an info panel with the original estimate (3 November 2026) and an expand
 *                        "Change log" holding the confirmed date node (2026-12-01).
 *
 * Idempotent: issues are found by exact summary (JQL text search over KAN, filtered in code); missing ones are created,
 * drifted labels, due dates, descriptions and statuses are repaired, links are added only when absent. Everything is
 * read back; the answers are recomputed from the live data and must equal the planned constants. The manifest is
 * written only when every check passed; otherwise the failed checks are listed and the process exits 1.
 *
 *   bun eval/nightmare/seed-hell-ledger.ts
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-hell-ledger.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PROJECT = "KAN";
const TYPE = "Feladat";
const PREFIX = "atl smoke nm hell ";
const PACE_MS = 200;
const MAX_ATTEMPTS = 5;
const TODO = "Teendő";
const IN_PROGRESS = "Folyamatban";
const IN_REVIEW = "Ellenőrzés alatt";
const DONE = "Kész";
const OPEN_STATUSES = [TODO, IN_PROGRESS, IN_REVIEW];
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const BODIES = join(OUT, "bodies-hell-ledger");
const MANIFEST = join(OUT, "hell-ledger.json");
const ISSUE_FIELDS = "summary,status,labels,duedate,description";

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
  process.stderr.write(`[nm-hell-ledger] ${message}\n`);
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

/** Descriptions are a string or a list of lines. */
function bodyText(value: unknown): string {
  return typeof value === "string" ? value : asArray(value).map(asString).join("\n");
}

/** Markdown read back without escapes and blank lines, for comparing a description with the planned text. */
function plain(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replaceAll(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1").trim())
    .filter((line) => line !== "")
    .join("\n");
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
  const out = run.stdout.trim();
  return out === "" ? {} : JSON.parse(out);
}

// ---------------------------------------------------------------------------------------------------------------------
// Planted data: n37 ledger

const LEDGER_LABEL = "nm-hell-ledger";
const ARCHIVE_LABEL = "nm-hell-ledger-archive";
const LEDGER_TAG = `${PREFIX}Ledger batch `;
const LEDGER_SEED = 20_261_101;
const ANSWER_JQL = `project = ${PROJECT} AND labels = "${LEDGER_LABEL}" AND statusCategory != Done AND duedate >= 2026-11-01 AND duedate <= 2026-11-30`;
const ALL_JQL = `project = ${PROJECT} AND labels in ("${LEDGER_LABEL}", "${ARCHIVE_LABEL}")`;
const CORRECTED = 12;
const PENDING = 3;
/** The first counted issues (in batch order) sit on the boundary days, so both ends of November are present. */
const FORCED_DAYS = [1, 30, 1, 30];

type Group = "counted" | "done" | "october" | "december" | "undated" | "archive";

const GROUP_SIZES: readonly (readonly [Group, number])[] = [
  ["counted", 112],
  ["done", 9],
  ["october", 6],
  ["december", 4],
  ["undated", 5],
  ["archive", 8],
];

interface LedgerSpec {
  batch: string;
  summary: string;
  group: Group;
  labels: string[];
  due: string | null;
  status: string;
  /** Current amount in EUR; null when the description says "pending". */
  amount: number | null;
  /** The pre-repricing amount quoted after "corrected from"; null when there was no correction. */
  correctedFrom: number | null;
  description: string;
}

function mulberry32(seed: number): () => number {
  let seedState = seed >>> 0;
  return () => {
    seedState = (seedState + 0x6d_2b_79_f5) >>> 0;
    let t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function between(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = between(random, 0, i);
    const a = values[i];
    const b = values[j];
    if (a !== undefined && b !== undefined) {
      values[i] = b;
      values[j] = a;
    }
  }
  return values;
}

function november(day: number): string {
  return `2026-11-${String(day).padStart(2, "0")}`;
}

function amountLine(amount: number | null, correctedFrom: number | null): string {
  if (amount === null) {
    return "Amount: pending.";
  }
  if (correctedFrom === null) {
    return `Amount: EUR ${amount}.`;
  }
  return `Amount: EUR ${amount} (corrected from EUR ${correctedFrom} after the October repricing).`;
}

function ledgerPlan(): LedgerSpec[] {
  const random = mulberry32(LEDGER_SEED);
  const groups = shuffle(
    GROUP_SIZES.flatMap(([group, size]) => Array.from({ length: size }, (): Group => group)),
    random,
  );
  const countedPositions = shuffle(
    groups.flatMap((group, index) => (group === "counted" ? [index] : [])),
    random,
  );
  const corrected = new Set(countedPositions.slice(0, CORRECTED));
  const pending = new Set(countedPositions.slice(CORRECTED, CORRECTED + PENDING));
  let countedSeen = 0;
  return groups.map((group, index) => {
    const batch = String(index + 1).padStart(3, "0");
    const open = OPEN_STATUSES[between(random, 0, OPEN_STATUSES.length - 1)] ?? TODO;
    let due: string | null = november(between(random, 1, 30));
    let status = open;
    if (group === "counted") {
      due = november(FORCED_DAYS[countedSeen] ?? between(random, 1, 30));
      countedSeen += 1;
    } else if (group === "done") {
      status = DONE;
    } else if (group === "october") {
      due = "2026-10-31";
    } else if (group === "december") {
      due = "2026-12-01";
    } else if (group === "undated") {
      due = null;
    }
    const amount = pending.has(index) ? null : between(random, 100, 9999);
    let correctedFrom: number | null = null;
    if (corrected.has(index)) {
      correctedFrom = between(random, 100, 9999);
      while (correctedFrom === amount) {
        correctedFrom = between(random, 100, 9999);
      }
    }
    return {
      batch,
      summary: `${LEDGER_TAG}${batch}`,
      group,
      labels: [group === "archive" ? ARCHIVE_LABEL : LEDGER_LABEL],
      due,
      status,
      amount,
      correctedFrom,
      description: `Ledger batch ${batch}. ${amountLine(amount, correctedFrom)}\n\nBooked by Finance Ops.`,
    };
  });
}

/** Current amount on the "Amount:" line (the first EUR amount, not the corrected-from one); pending is 0; NaN if unreadable. */
function currentAmount(description: string): number {
  const line = description.split("\n").find((entry) => entry.includes("Amount:"));
  if (line === undefined) {
    return Number.NaN;
  }
  const rest = line.slice(line.indexOf("Amount:") + "Amount:".length);
  if (/^\s*pending/i.test(rest)) {
    return 0;
  }
  const match = /EUR\s*(\d+)/.exec(rest);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

function sumOf(specs: readonly LedgerSpec[], amount: (spec: LedgerSpec) => number): number {
  return specs.reduce((sum, spec) => sum + amount(spec), 0);
}

function current(spec: LedgerSpec): number {
  return spec.amount ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Planted data: n38 duplicates and n42 ADF date

const CARD_TAG = `${PREFIX}Card token rotation – `;
const CARDS = {
  pci: `${CARD_TAG}PCI scope`,
  hsm: `${CARD_TAG}HSM side`,
  vault: `${CARD_TAG}vault side`,
  tracking: `${CARD_TAG}tracking`,
  comms: `${CARD_TAG}rollout comms`,
};
const CANONICAL_CLAIM = "Canonical ticket for card token rotation; track everything here.";

const GO_LIVE = {
  summary: `${PREFIX}Merchant portal go-live`,
  date: "2026-12-01",
  planned: "2026-11-17",
  estimate: "2026-11-03",
  estimateText: "Original board estimate was 3 November 2026.",
  offByOne: "2026-11-30",
};

function utcMidnight(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function dateNode(iso: string): Obj {
  return { type: "date", attrs: { timestamp: String(utcMidnight(iso)) } };
}

function text(value: string): Obj {
  return { type: "text", text: value };
}

function goLiveAdf(): Obj {
  return {
    version: 1,
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Go-live")] },
      {
        type: "paragraph",
        content: [
          text("Planned go-live: "),
          dateNode(GO_LIVE.planned),
          text(" "),
          { type: "status", attrs: { text: "SUPERSEDED", color: "red", localId: "6f1c2a4e-0b7d-4d8e-9a51-3c2f8e1d7a01" } },
        ],
      },
      { type: "panel", attrs: { panelType: "info" }, content: [{ type: "paragraph", content: [text(GO_LIVE.estimateText)] }] },
      {
        type: "expand",
        attrs: { title: "Change log" },
        content: [
          {
            type: "paragraph",
            content: [
              text("Rescheduled by CAB: go-live "),
              dateNode(GO_LIVE.date),
              text(" "),
              { type: "status", attrs: { text: "CONFIRMED", color: "green", localId: "6f1c2a4e-0b7d-4d8e-9a51-3c2f8e1d7a02" } },
            ],
          },
        ],
      },
    ],
  };
}

const GO_LIVE_NEEDLES = [
  "Go-live",
  `Planned go-live: ${GO_LIVE.planned}`,
  "[SUPERSEDED]",
  GO_LIVE.estimateText,
  "<summary>Change log</summary>",
  `Rescheduled by CAB: go-live ${GO_LIVE.date}`,
  "[CONFIRMED]",
];

interface AdfFacts {
  dates: number[];
  statuses: string[];
  types: string[];
  expands: string[];
  text: string;
}

function walkAdf(node: unknown, facts: AdfFacts): void {
  const entry = record(node);
  const type = asString(entry.type);
  const attrs = record(entry.attrs);
  facts.types.push(type);
  if (type === "date") {
    facts.dates.push(Number(attrs.timestamp));
  } else if (type === "status") {
    facts.statuses.push(asString(attrs.text));
  } else if (type === "expand" || type === "nestedExpand") {
    facts.expands.push(asString(attrs.title));
  } else if (type === "text") {
    facts.text += asString(entry.text);
  }
  for (const child of asArray(entry.content)) {
    walkAdf(child, facts);
  }
}

function adfFacts(doc: unknown): AdfFacts {
  const facts: AdfFacts = { dates: [], statuses: [], types: [], expands: [], text: "" };
  walkAdf(doc, facts);
  return facts;
}

function adfIntact(facts: AdfFacts): boolean {
  return (
    JSON.stringify(facts.dates) === JSON.stringify([utcMidnight(GO_LIVE.planned), utcMidnight(GO_LIVE.date)]) &&
    JSON.stringify(facts.statuses) === JSON.stringify(["SUPERSEDED", "CONFIRMED"]) &&
    JSON.stringify(facts.expands) === JSON.stringify(["Change log"]) &&
    facts.types.includes("panel") &&
    facts.text.includes(GO_LIVE.estimateText) &&
    facts.text.includes("Rescheduled by CAB: go-live ")
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Jira helpers

interface Live {
  key: string;
  summary: string;
  status: string;
  labels: string[];
  due: string;
  description: string;
}

function liveOf(item: Obj): Live {
  return {
    key: asString(item.key),
    summary: asString(item.summary),
    status: asString(item.status),
    labels: asArray(item.labels).map(asString).toSorted(),
    due: asString(item.duedate),
    description: bodyText(item.description),
  };
}

async function state(key: string): Promise<Live> {
  return liveOf(record(await atl(["issue", "get", key, "--issue-fields", ISSUE_FIELDS])));
}

async function findExisting(): Promise<Map<string, Live>> {
  const result = await atl(["jql", `project = ${PROJECT} AND summary ~ "atl smoke nm hell" ORDER BY created ASC`, "--all", "--issue-fields", ISSUE_FIELDS]);
  const found = new Map<string, Live>();
  for (const item of items(result)) {
    const live = liveOf(item);
    if (live.summary.startsWith(PREFIX) && !found.has(live.summary)) {
      found.set(live.summary, live);
    }
  }
  return found;
}

interface IssueSpec {
  summary: string;
  /** Markdown description, compared and repaired on re-runs. */
  body?: string;
  /** ADF description file, checked separately (see ensureGoLive). */
  adfFile?: string;
  labels: string[];
  due: string | null;
  status: string;
}

async function createIssue(found: Map<string, Live>, spec: IssueSpec): Promise<string> {
  const args = ["issue", "create", "--project", PROJECT, "--type", TYPE, "--summary", spec.summary];
  if (spec.adfFile === undefined) {
    args.push("--body", spec.body ?? "");
  } else {
    args.push("--file", spec.adfFile, "--body-format", "adf");
  }
  if (spec.labels.length > 0) {
    args.push("--set", `labels=${JSON.stringify(spec.labels)}`);
  }
  if (spec.due !== null) {
    args.push("--set", `duedate=${spec.due}`);
  }
  if (spec.status !== TODO) {
    args.push("--transition", spec.status);
  }
  const key = asString(record(await atl(args)).key);
  writes += 1;
  found.set(spec.summary, { key, summary: spec.summary, status: spec.status, labels: spec.labels.toSorted(), due: spec.due ?? "", description: spec.body ?? "" });
  log(`created ${key} ${spec.summary}`);
  return key;
}

async function ensureIssue(found: Map<string, Live>, spec: IssueSpec): Promise<string> {
  const live = found.get(spec.summary);
  if (live === undefined) {
    return await createIssue(found, spec);
  }
  const update: string[] = [];
  if (JSON.stringify(live.labels) !== JSON.stringify(spec.labels.toSorted())) {
    update.push("--set", `labels=${JSON.stringify(spec.labels)}`);
  }
  if (live.due !== (spec.due ?? "")) {
    update.push("--set", `duedate=${spec.due ?? "null"}`);
  }
  if (spec.body !== undefined && plain(live.description) !== plain(spec.body)) {
    update.push("--body", spec.body);
  }
  if (update.length > 0) {
    await atl(["issue", "update", live.key, ...update]);
    writes += 1;
    log(`${live.key}: repaired ${update.length / 2} field(s)`);
  }
  if (live.status !== spec.status) {
    await atl(["issue", "move", live.key, spec.status]);
    writes += 1;
    log(`${live.key}: moved ${live.status} -> ${spec.status}`);
  }
  return live.key;
}

/** Links `from` to `to` unless `from` already lists `to` with that type and relation (as `from` sees it). */
async function ensureLink(from: string, type: string, to: string, relation: string): Promise<void> {
  const links = items(await atl(["issue", "links", from]));
  const present = links.some((link) => asString(link.type) === type && asString(link.relation) === relation && asString(link.key) === to);
  if (!present) {
    await atl(["issue", "link", from, type, to]);
    writes += 1;
    log(`${from} ${relation} ${to}`);
  }
}

async function linkList(key: string): Promise<string[]> {
  return items(await atl(["issue", "links", key]))
    .map((link) => `${asString(link.relation)} ${asString(link.key)}`)
    .toSorted();
}

async function adfOf(key: string): Promise<unknown> {
  return record(await atl(["issue", "get", key, "--format", "adf", "--issue-fields", "description"])).description;
}

async function ensureGoLive(found: Map<string, Live>): Promise<string> {
  mkdirSync(BODIES, { recursive: true });
  const file = join(BODIES, "merchant-portal-go-live.json");
  writeFileSync(file, `${JSON.stringify(goLiveAdf(), null, 2)}\n`);
  const key = await ensureIssue(found, { summary: GO_LIVE.summary, adfFile: file, labels: [], due: null, status: TODO });
  if (!adfIntact(adfFacts(await adfOf(key)))) {
    await atl(["issue", "update", key, "--file", file, "--body-format", "adf"]);
    writes += 1;
    log(`${key}: restored the ADF description`);
  }
  return key;
}

// ---------------------------------------------------------------------------------------------------------------------
// Main

interface Decoy {
  name: string;
  value: number;
}

async function main(): Promise<void> {
  const found = await findExisting();
  log(`found ${found.size} existing hell issues in ${PROJECT}`);

  // n37
  const plan = ledgerPlan();
  const keys = new Map<string, string>();
  for (const spec of plan) {
    keys.set(spec.summary, await ensureIssue(found, { summary: spec.summary, body: spec.description, labels: spec.labels, due: spec.due, status: spec.status }));
  }

  // n38
  const pci = await ensureIssue(found, { summary: CARDS.pci, body: CANONICAL_CLAIM, labels: [], due: null, status: DONE });
  const hsm = await ensureIssue(found, { summary: CARDS.hsm, body: "HSM side of the card token rotation: rotate the key-encryption keys in the payment HSMs.", labels: [], due: null, status: DONE });
  const vault = await ensureIssue(found, { summary: CARDS.vault, body: "Vault side of the card token rotation: re-encrypt the stored card tokens with the new keys.", labels: [], due: null, status: DONE });
  const trackingClaim = `Superseded: closing as a duplicate of ${pci}; continue in ${pci}.`;
  const tracking = await ensureIssue(found, { summary: CARDS.tracking, body: trackingClaim, labels: [], due: null, status: TODO });
  const comms = await ensureIssue(found, { summary: CARDS.comms, body: "Rollout communications for the card token rotation: merchant emails and the status page notice.", labels: [], due: null, status: IN_PROGRESS });
  for (const duplicate of [pci, hsm, vault]) {
    await ensureLink(duplicate, "Duplicate", tracking, "duplicates");
  }
  await ensureLink(comms, "Relates", pci, "relates to");

  // n42
  const goLive = await ensureGoLive(found);

  // Read-back: n37 answer from the scenario's own JQL plus the descriptions.
  const counted = plan.filter((spec) => spec.group === "counted");
  const plannedSum = sumOf(counted, current);
  const answerItems = items(await atl(["jql", ANSWER_JQL, "--all", "--issue-fields", ISSUE_FIELDS])).map(liveOf);
  const liveSum = answerItems.reduce((sum, item) => sum + currentAmount(item.description), 0);
  check(answerItems.length > 100, `ledger: the answer must need more than one page of 100 (got ${answerItems.length})`);
  expect("ledger: answer count", answerItems.length, counted.length);
  expect("ledger: answer sum", liveSum, plannedSum);
  expect(
    "ledger: answer keys",
    answerItems.map((item) => item.key).toSorted(),
    counted.map((spec) => keys.get(spec.summary) ?? "").toSorted(),
  );

  // Read-back: every planted ledger issue as planned.
  const allLive = new Map(items(await atl(["jql", ALL_JQL, "--all", "--issue-fields", ISSUE_FIELDS])).map((item) => [asString(item.summary), liveOf(item)]));
  expect("ledger: labelled issues (both labels)", allLive.size, plan.length);
  for (const spec of plan) {
    const live = allLive.get(spec.summary);
    if (live === undefined) {
      check(false, `${spec.summary}: not found by ${ALL_JQL}`);
      continue;
    }
    expect(`${live.key}: status`, live.status, spec.status);
    expect(`${live.key}: due`, live.due, spec.due ?? "");
    expect(`${live.key}: labels`, live.labels, spec.labels);
    expect(`${live.key}: current amount`, currentAmount(live.description), current(spec));
    check(plain(live.description) === plain(spec.description), `${live.key}: description drifted: ${JSON.stringify(live.description)}`);
  }
  const corrections = counted.filter((spec) => spec.correctedFrom !== null);
  const pendings = counted.filter((spec) => spec.amount === null);
  expect("ledger: corrected amounts among the counted", corrections.length, CORRECTED);
  expect("ledger: pending amounts among the counted", pendings.length, PENDING);
  const nov1 = counted.filter((spec) => spec.due === november(1)).length;
  const nov30 = counted.filter((spec) => spec.due === november(30)).length;
  check(nov1 > 0 && nov30 > 0, `ledger: both boundary days must be counted (1st ${nov1}, 30th ${nov30})`);

  const inGroup = (...groups: Group[]): LedgerSpec[] => plan.filter((spec) => groups.includes(spec.group));
  const countDecoys: Decoy[] = [
    { name: "first page of 50 only", value: 50 },
    { name: "first page of 100 only", value: 100 },
    { name: "pending amounts left out", value: counted.length - pendings.length },
    { name: "done issues included", value: inGroup("counted", "done").length },
    { name: "2026-10-31 and 2026-12-01 included", value: inGroup("counted", "october", "december").length },
    { name: "issues without a due date included", value: inGroup("counted", "undated").length },
    { name: "nm-hell-ledger-archive issues included", value: inGroup("counted", "archive").length },
    { name: "every nm-hell-ledger issue", value: inGroup("counted", "done", "october", "december", "undated").length },
    { name: "every issue of both labels", value: plan.length },
  ];
  const sumDecoys: Decoy[] = [
    { name: "corrected-from amounts instead of the current ones", value: sumOf(counted, (spec) => spec.correctedFrom ?? current(spec)) },
    { name: "corrected-from amounts added as well", value: plannedSum + sumOf(corrections, (spec) => spec.correctedFrom ?? 0) },
    { name: "done issues included", value: sumOf(inGroup("counted", "done"), current) },
    { name: "2026-10-31 and 2026-12-01 included", value: sumOf(inGroup("counted", "october", "december"), current) },
    { name: "issues without a due date included", value: sumOf(inGroup("counted", "undated"), current) },
    { name: "nm-hell-ledger-archive issues included", value: sumOf(inGroup("counted", "archive"), current) },
    { name: "every nm-hell-ledger issue", value: sumOf(inGroup("counted", "done", "october", "december", "undated"), current) },
  ];
  for (const decoy of countDecoys) {
    check(decoy.value !== counted.length, `ledger: count decoy "${decoy.name}" equals the answer ${counted.length}`);
  }
  for (const decoy of sumDecoys) {
    check(decoy.value !== plannedSum, `ledger: sum decoy "${decoy.name}" equals the answer ${plannedSum}`);
  }

  // Read-back: n38.
  const cardKeys = { pci, hsm, vault, tracking, comms };
  const cardStates = new Map<string, Live>();
  for (const key of Object.values(cardKeys)) {
    cardStates.set(key, await state(key));
  }
  const statusOf = (key: string): string => cardStates.get(key)?.status ?? "";
  expect("cards: PCI scope status", statusOf(pci), DONE);
  expect("cards: HSM side status", statusOf(hsm), DONE);
  expect("cards: vault side status", statusOf(vault), DONE);
  expect("cards: tracking status", statusOf(tracking), TODO);
  expect("cards: rollout comms status", statusOf(comms), IN_PROGRESS);
  expect("cards: PCI scope links", await linkList(pci), [`duplicates ${tracking}`, `relates to ${comms}`].toSorted());
  expect("cards: HSM side links", await linkList(hsm), [`duplicates ${tracking}`]);
  expect("cards: vault side links", await linkList(vault), [`duplicates ${tracking}`]);
  expect("cards: tracking links", await linkList(tracking), [pci, hsm, vault].map((key) => `is duplicated by ${key}`).toSorted());
  expect("cards: rollout comms links", await linkList(comms), [`relates to ${pci}`]);
  check(plain(cardStates.get(pci)?.description ?? "") === CANONICAL_CLAIM, "cards: PCI scope must claim to be canonical");
  check(plain(cardStates.get(tracking)?.description ?? "") === trackingClaim, "cards: tracking must claim to be a duplicate of PCI scope");

  // Read-back: n42 (raw ADF and the markdown atl renders by default).
  const goLiveFacts = adfFacts(await adfOf(goLive));
  check(adfIntact(goLiveFacts), `go-live: ADF description drifted: dates ${JSON.stringify(goLiveFacts.dates)}, statuses ${JSON.stringify(goLiveFacts.statuses)}, expands ${JSON.stringify(goLiveFacts.expands)}`);
  const goLiveState = await state(goLive);
  const markdown = goLiveState.description;
  for (const needle of GO_LIVE_NEEDLES) {
    check(markdown.includes(needle), `go-live: rendered markdown lacks ${JSON.stringify(needle)}`);
  }
  check(!markdown.includes(GO_LIVE.offByOne), `go-live: rendered markdown shows the off-by-one date ${GO_LIVE.offByOne}`);
  expect("go-live: status", goLiveState.status, TODO);

  if (failures.length > 0) {
    log(`${failures.length} failed checks; manifest not written:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }

  const cardEntry = (key: string, role: string): Obj => ({ key, role, summary: cardStates.get(key)?.summary ?? "", status: statusOf(key) });
  const manifest = {
    generatedAt: new Date().toISOString(),
    ledger: {
      label: LEDGER_LABEL,
      archiveLabel: ARCHIVE_LABEL,
      jql: ANSWER_JQL,
      count: counted.length,
      sum: plannedSum,
      corrected: corrections.length,
      pending: pendings.length,
      countDecoys,
      sumDecoys,
      issues: plan.map((spec) => ({
        key: keys.get(spec.summary) ?? "",
        batch: spec.batch,
        group: spec.group,
        label: spec.labels.join(","),
        status: spec.status,
        due: spec.due,
        amount: spec.amount,
        correctedFrom: spec.correctedFrom,
      })),
    },
    duplicates: {
      surviving: cardEntry(tracking, "tracking: the issue the others duplicate"),
      others: [
        cardEntry(pci, "duplicates the tracking issue; its stale description claims to be canonical"),
        cardEntry(hsm, "duplicates the tracking issue"),
        cardEntry(vault, "duplicates the tracking issue"),
        cardEntry(comms, "relates to PCI scope; not a duplicate"),
      ],
    },
    goLive: {
      key: goLive,
      summary: GO_LIVE.summary,
      date: GO_LIVE.date,
      decoyDates: [
        { name: "superseded planned date", date: GO_LIVE.planned },
        { name: "original board estimate", date: GO_LIVE.estimate },
        { name: "time-zone off-by-one of the confirmed date", date: GO_LIVE.offByOne },
      ],
      markdown,
    },
    facts: [
      {
        id: "hell-ledger-sum",
        question: `KAN issues labelled ${LEDGER_LABEL}: how many are not done and due in November 2026, and what is the sum of their current amounts in EUR?`,
        answer: `${counted.length} issues; EUR ${plannedSum}`,
        whyHard: `${counted.length} matches need more than one result page; ${corrections.length} descriptions quote a corrected-from amount, ${pendings.length} say pending (0); decoys: ${countDecoys.map((d) => `${d.value} (${d.name})`).join(", ")}; sums ${sumDecoys.map((d) => `${d.value} (${d.name})`).join(", ")}`,
      },
      {
        id: "hell-duplicate-direction",
        question: 'Which "Card token rotation" issue do the others duplicate, and what is its status?',
        answer: `${tracking} (${CARDS.tracking}), ${statusOf(tracking)}`,
        whyHard: `${pci}, ${hsm} and ${vault} duplicate ${tracking} (Kész); ${comms} only relates to ${pci}; the stale descriptions say the opposite (${pci} "canonical", ${tracking} "duplicate of ${pci}")`,
      },
      {
        id: "hell-adf-go-live",
        question: `What is the current go-live date of "${GO_LIVE.summary}"?`,
        answer: GO_LIVE.date,
        whyHard: `the confirmed date is an ADF date node inside a collapsed "Change log" expand; the visible planned date ${GO_LIVE.planned} is marked SUPERSEDED, an info panel names the original estimate ${GO_LIVE.estimate}; a local-time rendering of the UTC timestamp gives ${GO_LIVE.offByOne}`,
      },
    ],
    createdThisRun: writes,
    atlCalls: calls,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote ${MANIFEST}; ${writes} writes this run; ${calls} atl calls`);
}

await main();
