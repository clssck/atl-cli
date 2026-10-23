#!/usr/bin/env bun
/**
 * Corporate-nightmare scrum and second-space verifier (read-only).
 *
 * The data was set up once by hand: the company-managed scrum project NMS "atl smoke nm Scrum" (board 2), its
 * components, versions, sprints (start/complete) and story points, the Confluence space NMCORP "atl smoke nm Corp
 * Handbook", its page labels and the travel-limits.csv attachment through the browser; issues, links and pages through
 * `atl issue create` / `atl page create`. This script creates nothing. It reads the live data with the frozen atl
 * binary, computes the facts the n16-n21 scenarios check (remaining points, velocity, carried-over and backlog keys,
 * policy values), compares them with the expected setup and writes eval/.out/nightmare/scrum.json. Any divergence is
 * listed under `consistencyChecks` and makes the script exit 1.
 *
 *   bun eval/nightmare/seed-scrum.ts
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-scrum.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PROJECT = "NMS";
const BOARD = "2";
const SPACE = "NMCORP";
const ENGINEERING_SPACE = "SZOFTVERFE";
const PREFIX = "atl smoke nm scrum ";
const PAGE_PREFIX = "atl smoke nm corp ";
const POINTS_FIELD = "customfield_10016";
const LEGACY_POINTS_FIELD = "customfield_10042";
const SPRINT_FIELD = "customfield_10020";
const DUPLICATE_LABEL = "nm-duplicate";
const OUT_DIR = join(import.meta.dir, "..", ".out", "nightmare");
const MANIFEST_PATH = join(OUT_DIR, "scrum.json");
const MAX_ATTEMPTS = 5;

/** The one-time setup; the live data must still match it. */
const EXPECTED = {
  sprints: { 2: "NMS Sprint 1", 3: "NMS Sprint 2", 4: "NMS Sprint 3", 5: "NMS Sprint 4", 6: "NMS Sprint 5 (Q1 stretch)" },
  activeSprint: { id: 4, goal: "Mobile offline mode — kötelező", issueCount: 11, total: 44, remaining: 41 },
  carryOver: { key: "NMS-19", points: 8, legacyPoints: 13, partialKey: "NMS-25" },
  velocity: { 2: 13, 3: 27 },
  backlog: ["NMS-41", "NMS-42", "NMS-43", "NMS-44", "NMS-45"],
  backlogWithDuplicates: 15,
  duplicates: ["NMS-6", "NMS-7", "NMS-8", "NMS-9", "NMS-10", "NMS-11", "NMS-12", "NMS-13", "NMS-14", "NMS-15"],
  components: ["Backend", "Fizetés (Payments)", "Frontend", "Mobile 📱", "Platform / Infra"],
  versions: ["1.0", "1.1", '2.0 "Phoenix"', "0.9-legacy"],
  homepage: "5472368",
  pages: {
    travel: { id: "5603349", title: "Travel Policy" },
    expense: { id: "5308439", title: "Expense Policy" },
    expenseDraft: { id: "5177412", title: "Expense Policy (DRAFT v2 — superseded)" },
    remote: { id: "5439511", title: "Remote Work Policy" },
    onboarding: { id: "5373982", title: "Onboarding" },
    release: { id: "5505032", title: "Release Process" },
  },
  engineeringRelease: "5177432",
  expense: { receiptEur: 25, days: 30 },
  expenseDraft: { receiptEur: 10, days: 14 },
  travel: { euPerDiem: 45, attachment: "travel-limits.csv" },
  remote: { daysPerWeek: 3, coreHours: "10:00–15:00 CET" },
  release: { corpDay: "Thursday", engineeringDay: "Tuesday" },
  policyLabel: ["Expense Policy", "Expense Policy (DRAFT v2 — superseded)", "Remote Work Policy", "Travel Policy"],
  expenseLabels: ["finance", "policy", "pénzügy"],
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Plumbing

type Obj = Record<string, unknown>;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let calls = 0;
const checks: string[] = [];

function log(message: string): void {
  process.stderr.write(`[nm-scrum] ${message}\n`);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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

/** One atl call; exit 3 (transient) is retried with backoff. */
async function spawnAtl(argv: string[]): Promise<Run> {
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawn([ATL, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    calls += 1;
    if (exitCode !== 3 || attempt >= MAX_ATTEMPTS) {
      return { exitCode, stdout, stderr };
    }
    log(`atl ${argv.join(" ")}: transient, retrying`);
    await Bun.sleep(1500 * 2 ** (attempt - 1));
  }
}

async function atl(argv: string[]): Promise<unknown> {
  const run = await spawnAtl(argv);
  if (run.exitCode !== 0) {
    throw new Error(`atl ${argv.join(" ")} exited ${run.exitCode}: ${(run.stderr.trim() || run.stdout.trim()).slice(0, 300)}`);
  }
  return JSON.parse(run.stdout);
}

function expectEqual(label: string, live: unknown, expected: unknown): void {
  const a = JSON.stringify(live);
  const b = JSON.stringify(expected);
  if (a !== b) {
    checks.push(`${label}: live ${a} vs expected ${b}`);
  }
}

function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function byKey(a: string, b: string): number {
  return Number(a.split("-")[1]) - Number(b.split("-")[1]);
}

/** First capture of `pattern` in `text` as a number; a miss is a check failure. */
function grab(label: string, text: string, pattern: RegExp): number {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) {
    checks.push(`${label}: ${String(pattern)} not found in ${JSON.stringify(text.slice(0, 200))}`);
    return Number.NaN;
  }
  return Number(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Jira

interface Issue {
  key: string;
  summary: string;
  status: string;
  done: boolean;
  type: string;
  epic: boolean;
  labels: string[];
  points: number | null;
  legacyPoints: number | null;
  sprints: number[];
  duplicates: string[];
}

interface Sprint {
  id: number;
  name: string;
  state: string;
  goal: string;
  start: string;
  end: string;
  issues: string[];
}

async function loadIssues(): Promise<Map<string, Issue>> {
  const fields = ["summary", "status", "issuetype", "labels", "issuelinks", POINTS_FIELD, LEGACY_POINTS_FIELD, SPRINT_FIELD].join(",");
  const result = await atl(["jql", `project = ${PROJECT} ORDER BY key ASC`, "--issue-fields", fields, "--all", "--full"]);
  const issues = new Map<string, Issue>();
  for (const item of items(result)) {
    const f = record(item.fields);
    const status = record(f.status);
    const type = record(f.issuetype);
    const issue: Issue = {
      key: asString(item.key),
      summary: asString(f.summary),
      status: asString(status.name),
      done: asString(record(status.statusCategory).key) === "done",
      type: asString(type.name),
      epic: type.hierarchyLevel === 1,
      labels: asArray(f.labels).map(asString),
      points: asNumber(f[POINTS_FIELD]),
      legacyPoints: asNumber(f[LEGACY_POINTS_FIELD]),
      sprints: asArray(f[SPRINT_FIELD])
        .map((sprint) => asNumber(record(sprint).id))
        .filter((id) => id !== null),
      duplicates: asArray(f.issuelinks)
        .map(record)
        .filter((link) => asString(record(link.type).name) === "Duplicate")
        .map((link) => asString(record(link.outwardIssue).key))
        .filter((key) => key !== ""),
    };
    issues.set(issue.key, issue);
    if (!issue.summary.startsWith(PREFIX)) {
      checks.push(`${issue.key} summary lacks the prefix "${PREFIX}": ${issue.summary}`);
    }
  }
  return issues;
}

async function loadSprints(): Promise<Sprint[]> {
  return items(await atl(["board", "sprints", BOARD, "--issues"])).map((item) => ({
    id: asNumber(item.id) ?? -1,
    name: asString(item.name),
    state: asString(item.state),
    goal: asString(item.goal),
    start: asString(item.start),
    end: asString(item.end),
    issues: asArray(item.issues).map(asString).toSorted(byKey),
  }));
}

function bare(summary: string): string {
  return summary.slice(PREFIX.length).replace(/^\[DUPLICATE\]\s*/, "");
}

async function verifyJira(): Promise<Obj> {
  const [issues, sprints, board] = await Promise.all([loadIssues(), loadSprints(), atl(["board", "get", BOARD])]);
  expectEqual("board", { type: record(board).type, project: record(board).project }, { type: "SCRUM", project: PROJECT });
  expectEqual(
    "sprints",
    Object.fromEntries(sprints.map((s) => [s.id, s.name])),
    EXPECTED.sprints,
  );
  const issue = (key: string): Issue => {
    const found = issues.get(key);
    if (found === undefined) {
      throw new Error(`${key} not found in project ${PROJECT}`);
    }
    return found;
  };
  for (const sprint of sprints) {
    const fromField = [...issues.values()].filter((i) => i.sprints.includes(sprint.id)).map((i) => i.key).toSorted(byKey);
    expectEqual(`${sprint.name} issues (board vs Sprint field)`, sprint.issues, fromField);
  }

  // Active sprint: total and remaining story points (sub-tasks carry none).
  const active = sprints.filter((s) => s.state === "active");
  const current = active[0];
  if (active.length !== 1 || current === undefined) {
    throw new Error(`expected one active sprint, found ${active.length}`);
  }
  const currentIssues = current.issues.map(issue);
  const total = sum(currentIssues.map((i) => i.points));
  const remaining = sum(currentIssues.filter((i) => !i.done).map((i) => i.points));
  // What a sum over the legacy "Story Points" field sees: its value where set, else the real estimate.
  const legacyTotal = sum(currentIssues.map((i) => i.legacyPoints ?? i.points));
  const legacyRemaining = sum(currentIssues.filter((i) => !i.done).map((i) => i.legacyPoints ?? i.points));
  const unestimated = currentIssues.filter((i) => i.points === null && !i.type.startsWith("Alfeladat")).map((i) => i.key);
  expectEqual("active sprint", { id: current.id, goal: current.goal, issueCount: current.issues.length, total, remaining }, EXPECTED.activeSprint);

  // Carry-over: in the first closed sprint and still in the active one.
  const closed = sprints.filter((s) => s.state === "closed").toSorted((a, b) => a.id - b.id);
  const first = closed[0];
  if (first === undefined) {
    throw new Error("no closed sprint");
  }
  const carried = [...issues.values()].filter((i) => i.sprints.includes(first.id) && i.sprints.includes(current.id));
  const partial = [...issues.values()].filter((i) => !i.sprints.includes(first.id) && i.sprints.length > 1 && i.sprints.includes(current.id));
  const carriedIssue = carried[0];
  if (carried.length !== 1 || carriedIssue === undefined) {
    throw new Error(`expected one issue carried from ${first.name} to ${current.name}, found ${carried.map((i) => i.key).join(",")}`);
  }
  expectEqual(
    "carry-over",
    { key: carriedIssue.key, points: carriedIssue.points, legacyPoints: carriedIssue.legacyPoints, partialKey: partial.map((i) => i.key).join(",") },
    EXPECTED.carryOver,
  );
  const carriedDuplicate = [...issues.values()].filter((i) => i.duplicates.includes(carriedIssue.key)).map((i) => i.key);

  // Velocity: points of the issues done in a closed sprint that is their last sprint; committed = everything in it.
  const velocity = closed.map((sprint) => {
    const members = sprint.issues.map(issue);
    const completed = members.filter((i) => i.done && Math.max(...i.sprints) === sprint.id);
    return {
      sprint: sprint.name,
      id: sprint.id,
      completed: sum(completed.map((i) => i.points)),
      completedKeys: completed.map((i) => i.key),
      committed: sum(members.map((i) => i.points)),
      committedLegacy: sum(members.map((i) => i.legacyPoints ?? i.points)),
    };
  });
  expectEqual("velocity", Object.fromEntries(velocity.map((v) => [v.id, v.completed])), EXPECTED.velocity);

  // Backlog: open non-epic issues in no sprint (Jira lists epics in the epic panel, not as backlog rows).
  const backlog = [...issues.values()].filter((i) => i.sprints.length === 0 && !i.done && !i.epic);
  const duplicates = backlog.filter((i) => i.labels.includes(DUPLICATE_LABEL));
  const clean = backlog.filter((i) => !i.labels.includes(DUPLICATE_LABEL));
  expectEqual("backlog size", backlog.length, EXPECTED.backlogWithDuplicates);
  expectEqual("backlog without duplicates", clean.map((i) => i.key), EXPECTED.backlog);
  expectEqual("duplicate decoys", duplicates.map((i) => i.key), EXPECTED.duplicates);
  for (const duplicate of duplicates) {
    const original = duplicate.duplicates[0];
    if (duplicate.duplicates.length !== 1 || original === undefined || !duplicate.summary.includes("[DUPLICATE]")) {
      checks.push(`${duplicate.key} is not a [DUPLICATE] with exactly one "duplicates" link`);
    } else if (bare(issue(original).summary) !== bare(duplicate.summary) || issue(original).labels.includes(DUPLICATE_LABEL)) {
      checks.push(`${duplicate.key} duplicates ${original}, whose summary differs or which is itself a duplicate`);
    }
  }
  const epics = new Set([...issues.values()].filter((i) => i.epic).map((i) => i.key));
  const boardBacklog = items(await atl(["board", "issues", BOARD, "--dataset", "backlog", "--all"]))
    .map((item) => asString(item.key))
    .filter((key) => !epics.has(key))
    .toSorted(byKey);
  expectEqual("board backlog (epics removed) vs computed backlog", boardBacklog, backlog.map((i) => i.key));

  const [components, versions] = await Promise.all([atl(["component", "list", PROJECT]), atl(["version", "list", PROJECT])]);
  expectEqual("components", items(components).map((c) => asString(c.name)).toSorted(), [...EXPECTED.components].toSorted());
  expectEqual("versions", items(versions).map((v) => asString(v.name)), EXPECTED.versions);

  return {
    project: PROJECT,
    board: Number(BOARD),
    fields: { points: POINTS_FIELD, legacyPoints: LEGACY_POINTS_FIELD, sprint: SPRINT_FIELD },
    sprints,
    activeSprint: {
      id: current.id,
      name: current.name,
      goal: current.goal,
      start: current.start,
      end: current.end,
      issueCount: current.issues.length,
      totalPoints: total,
      remainingPoints: remaining,
      legacyTotalPoints: legacyTotal,
      legacyRemainingPoints: legacyRemaining,
      doneKeys: currentIssues.filter((i) => i.done).map((i) => i.key),
      unestimatedKeys: unestimated,
    },
    carryOver: {
      key: carriedIssue.key,
      summary: carriedIssue.summary.slice(PREFIX.length),
      points: carriedIssue.points,
      legacyPoints: carriedIssue.legacyPoints,
      sprints: sprints.filter((s) => carriedIssue.sprints.includes(s.id)).map((s) => s.name),
      duplicateKeys: carriedDuplicate,
      partialKeys: partial.map((i) => i.key),
    },
    velocity,
    backlog: {
      keys: clean.map((i) => i.key),
      summaries: clean.map((i) => i.summary.slice(PREFIX.length)),
      duplicateKeys: duplicates.map((i) => i.key),
      epicKeys: [...epics].toSorted(byKey),
      withDuplicates: backlog.length,
      withEpics: backlog.length + epics.size,
    },
    issues: Object.fromEntries(
      [...issues.values()].map((i) => [i.key, { summary: i.summary, type: i.type, status: i.status, points: i.points, legacyPoints: i.legacyPoints, sprints: i.sprints, labels: i.labels }]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Confluence

interface Page {
  id: string;
  title: string;
  spaceId: string;
  body: string;
}

async function loadPage(id: string): Promise<Page> {
  const page = record(await atl(["page", "get", id]));
  const body = page.body;
  return {
    id: asString(page.id),
    title: asString(page.title),
    spaceId: asString(page.spaceId),
    body: Array.isArray(body) ? body.map(asString).join("\n") : asString(body),
  };
}

async function verifyConfluence(): Promise<Obj> {
  const [space, engineering, listing, policy] = await Promise.all([
    atl(["space", "get", SPACE]),
    atl(["space", "get", ENGINEERING_SPACE]),
    atl(["cql", `space = ${SPACE} AND type = page`, "--all"]),
    atl(["cql", `space = ${SPACE} AND type = page AND label = "policy"`, "--all"]),
  ]);
  const spaceId = asString(record(space).id);
  const engineeringId = asString(record(engineering).id);
  expectEqual("NMCORP homepage", asString(record(space).homepageId), EXPECTED.homepage);
  const titles = new Map(items(listing).map((hit) => [asString(hit.title), asString(hit.id)]));
  const pages: Record<string, Page> = {};
  for (const [name, spec] of Object.entries(EXPECTED.pages)) {
    const title = `${PAGE_PREFIX}${spec.title}`;
    expectEqual(`page "${title}" id`, titles.get(title), spec.id);
    const page = await loadPage(spec.id);
    expectEqual(`page ${spec.id} title/space`, { title: page.title, spaceId: page.spaceId }, { title, spaceId });
    pages[name] = page;
  }
  const page = (name: string): Page => {
    const found = pages[name];
    if (found === undefined) {
      throw new Error(`page ${name} not loaded`);
    }
    return found;
  };
  const engineeringRelease = await loadPage(EXPECTED.engineeringRelease);
  expectEqual("Engineering release page title/space", { title: engineeringRelease.title, spaceId: engineeringRelease.spaceId }, { title: page("release").title, spaceId: engineeringId });
  const clash = await atl(["cql", `type = page AND title = "${page("release").title}"`, "--all"]);
  expectEqual("Release Process title clash", items(clash).map((hit) => asString(hit.id)).toSorted(), [EXPECTED.pages.release.id, EXPECTED.engineeringRelease].toSorted());

  const expense = {
    receiptEur: grab("expense receipts", page("expense").body, /above \*\*(\d+) EUR\*\*/),
    days: grab("expense days", page("expense").body, /within (\d+) days/),
  };
  const expenseDraft = {
    receiptEur: grab("draft receipts", page("expenseDraft").body, /above \*\*(\d+) EUR\*\*/),
    days: grab("draft days", page("expenseDraft").body, /within (\d+) days/),
  };
  expectEqual("expense policy", expense, EXPECTED.expense);
  expectEqual("expense draft", expenseDraft, EXPECTED.expenseDraft);
  if (!/superseded/i.test(page("expenseDraft").title) || !/rejected/i.test(page("expenseDraft").body)) {
    checks.push("expense draft no longer says superseded/rejected");
  }

  const remote = {
    daysPerWeek: grab("remote days", page("remote").body, /\*\*(\d+) days\*\* per week/),
    coreHours: /Core hours ([^.]+)\./.exec(page("remote").body)?.[1] ?? "",
  };
  expectEqual("remote work", remote, EXPECTED.remote);

  const release = {
    corpDay: /\*\*(\w+?)s\*\*/.exec(page("release").body)?.[1] ?? "",
    corpCab: /CAB approval/.test(page("release").body),
    engineeringDay: /\*\*(\w+?)s\*\*/.exec(engineeringRelease.body)?.[1] ?? "",
    engineeringCab: !/no CAB/i.test(engineeringRelease.body),
  };
  expectEqual("release process", release, {
    corpDay: EXPECTED.release.corpDay,
    corpCab: true,
    engineeringDay: EXPECTED.release.engineeringDay,
    engineeringCab: false,
  });

  // Travel: the body's EU per diem plus the attachment it declares authoritative.
  const travelBody = page("travel").body;
  const euPerDiem = grab("travel EU per diem", travelBody, /Per diem \(EU\)\s*\|\s*\*\*€(\d+)\*\*/);
  const attachments = items(await atl(["attachment", "list", EXPECTED.pages.travel.id]));
  const csv = attachments.find((a) => asString(a.title) === EXPECTED.travel.attachment);
  if (csv === undefined || !travelBody.includes(EXPECTED.travel.attachment) || !/authoritative/i.test(travelBody)) {
    checks.push(`travel page lacks the authoritative ${EXPECTED.travel.attachment} attachment or its mention`);
  }
  // The attachment content (EU 45, UK 55, US 60 by setup) cannot be read with this token (download endpoints are 401), so it is not a scenario fact.
  expectEqual("travel EU per diem", euPerDiem, EXPECTED.travel.euPerDiem);

  const policyTitles = items(policy).map((hit) => asString(hit.title).slice(PAGE_PREFIX.length)).toSorted();
  expectEqual("label policy", policyTitles, [...EXPECTED.policyLabel].toSorted());
  const expenseLabels = items(await atl(["page", "labels", EXPECTED.pages.expense.id])).map((l) => asString(l.name)).toSorted();
  expectEqual("Expense Policy labels", expenseLabels, [...EXPECTED.expenseLabels].toSorted());

  return {
    space: { key: SPACE, id: spaceId, name: asString(record(space).name), homepageId: asString(record(space).homepageId) },
    engineeringSpace: { key: ENGINEERING_SPACE, id: engineeringId, name: asString(record(engineering).name) },
    pages: Object.fromEntries(Object.entries(pages).map(([name, p]) => [name, { id: p.id, title: p.title }])),
    engineeringRelease: { id: engineeringRelease.id, title: engineeringRelease.title },
    expense,
    expenseDraft,
    remote,
    release,
    travel: {
      euPerDiem,
      attachment: { id: asString(csv?.id), title: asString(csv?.title), comment: asString(csv?.comment), size: asNumber(csv?.size) },
    },
    policyLabelTitles: policyTitles,
    expenseLabels,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

function facts(jira: Obj, wiki: Obj): { id: string; question: string; answer: string; whyHard: string }[] {
  const active = record(jira.activeSprint);
  const carry = record(jira.carryOver);
  const velocity = asArray(jira.velocity).map(record);
  const backlog = record(jira.backlog);
  const expense = record(wiki.expense);
  const draft = record(wiki.expenseDraft);
  const release = record(wiki.release);
  return [
    {
      id: "scrum-current-sprint",
      question: "Which NMS sprint is active, what is its goal, and how many story points remain?",
      answer: `${asString(active.name)}; goal "${asString(active.goal)}"; ${String(active.remainingPoints)} of ${String(active.totalPoints)} points remaining`,
      whyHard: `the total (${String(active.totalPoints)}) and the legacy Story Points field (${String(active.legacyRemainingPoints)} remaining) are decoys; one story is unestimated`,
    },
    {
      id: "scrum-carry-over",
      question: "Which NMS issue was carried over from Sprint 1 through the active sprint, and what is its estimate?",
      answer: `${asString(carry.key)} ${asString(carry.summary)}; ${String(carry.points)} story points`,
      whyHard: `the legacy "Story Points" field says ${String(carry.legacyPoints)}; a [DUPLICATE] twin (${asArray(carry.duplicateKeys).map(asString).join(", ")}) and a two-sprint carry-over (${asArray(carry.partialKeys).map(asString).join(", ")}) exist`,
    },
    {
      id: "scrum-velocity",
      question: "How many story points were completed in each closed NMS sprint?",
      answer: velocity.map((v) => `${asString(v.sprint)}: ${String(v.completed)}`).join("; "),
      whyHard: `committed points (${velocity.map((v) => String(v.committed)).join(", ")}) include the carried-over stories`,
    },
    {
      id: "scrum-backlog",
      question: "How many NMS backlog issues are not duplicates, and which?",
      answer: `${asArray(backlog.keys).length}: ${asArray(backlog.keys).map(asString).join(", ")}`,
      whyHard: `${String(backlog.withDuplicates)} with the [DUPLICATE] decoys, ${String(backlog.withEpics)} if epics are counted`,
    },
    {
      id: "corp-expense",
      question: "Current Corp Handbook expense policy: receipt threshold and submission window?",
      answer: `receipts above ${String(expense.receiptEur)} EUR; submit within ${String(expense.days)} days`,
      whyHard: `a superseded draft with the same label says ${String(draft.receiptEur)} EUR / ${String(draft.days)} days`,
    },
    {
      id: "corp-release",
      question: "On which weekday do Corp releases need CAB approval, and how does the Engineering release process differ?",
      answer: `Corp: CAB approval on ${asString(release.corpDay)}s; Engineering: ${asString(release.engineeringDay)}s, no CAB`,
      whyHard: "two pages titled exactly the same in two spaces",
    },
  ];
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const [jira, confluence] = await Promise.all([verifyJira(), verifyConfluence()]);
  const manifest = {
    generatedAt: new Date().toISOString(),
    site: "foldvarszki.atlassian.net",
    note: "read-only verification of the one-time manual setup (browser + atl create); see the header of seed-scrum.ts",
    jira,
    confluence,
    facts: facts(jira, confluence),
    consistencyChecks: checks,
    atlCalls: calls,
  };
  await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest written: ${MANIFEST_PATH} (${manifest.facts.length} facts, ${checks.length} check failures, ${calls} atl calls)`);
  for (const check of checks) {
    log(`CHECK FAILED: ${check}`);
  }
  if (checks.length > 0) {
    process.exitCode = 1;
  }
}

await main();
