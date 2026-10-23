#!/usr/bin/env bun
/**
 * Corporate-nightmare "chaos multi" seed (idempotent): data for scenarios that need several sources at once (n30,
 * n31) or a careful write between near-identical targets (n32, n33). Everything is created through the atl binary and
 * prefixed `atl smoke nm chaos `; nothing existing is modified.
 *
 *  - n30 multi-hop:     Confluence "Incident 2026-10 postmortem" (SZOFTVERFE) names a tracking bug; the bug is blocked by
 *                       a fix issue whose fixVersion is 2.0 "Phoenix" (a second, older linked issue carries 1.0); the
 *                       NMCORP "Release Calendar" table gives the committed date of 2.0 Phoenix, which differs from the
 *                       placeholder date of the Jira version. The postmortem also records a wrong earlier promise (1.1).
 *  - n31 aggregation:   "On-call Owners 2026-10" maps team labels to owners; one owner covers two teams. Open NMS
 *                       issues per label (JQL) sum to the true winner; the owner of the single largest team and the
 *                       owner with the most issues including done ones are the decoys.
 *  - n32 page write:    "Payments Refund Runbook" (current) and "Payments Refund Runbook (OLD)" (archived copy).
 *  - n33 issue write:   an Apple Pay follow-up story and its "[DUPLICATE]" copy (linked with Duplicate), both To Do.
 *
 * Open issues sit in the future sprint "NMS Sprint 4" (id 5), never in the active sprint, the sprint-less backlog or
 * fixVersion 1.1, so the facts of seed-scrum.ts (n16-n21) and seed-chaos-confluence.ts (n29) stay valid.
 *
 * Idempotent: issues are found by the exact summary prefix `atl smoke nm chaos multi `, pages by title among the
 * children of their parent; every step checks live state first. Everything is read back; any divergence exits 1. The
 * token has no Confluence delete scope, so the owner removes the pages in the UI by the prefix.
 *
 *   bun eval/nightmare/seed-chaos-multi.ts
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-chaos-multi.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PREFIX = "atl smoke nm chaos ";
const TAG = `${PREFIX}multi `;
const SPRINT_ID = 5;
const ACTIVE_SPRINT_ID = 4;
const WIKI_SPACE = "SZOFTVERFE";
const CORP_SPACE = "NMCORP";
const NM_ROOT = "1572892";
const CORP_HOME = "5472368";
const PACE_MS = 200;
const MAX_ATTEMPTS = 5;
const TODO = "Teendő";
const DONE = "Kész";
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const BODIES = join(OUT, "bodies-chaos-multi");
const MANIFEST = join(OUT, "chaos-multi.json");
const CHAOS_JIRA = "chaos-jira.json";

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
  process.stderr.write(`[nm-chaos-multi] ${message}\n`);
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

/** Descriptions, comments and page bodies are a string or a list of lines. */
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

// ---------------------------------------------------------------------------------------------------------------------
// Planted data

interface TeamSpec {
  label: string;
  team: string;
  owner: string;
  open: string[];
  done: string[];
}

const TEAMS: TeamSpec[] = [
  {
    label: "team-ledger",
    team: "Ledger",
    owner: "Dóra Lengyel",
    open: ["Reconcile daily ledger totals", "Fix rounding on partial captures"],
    done: [],
  },
  {
    label: "team-reconciliation",
    team: "Reconciliation",
    owner: "Dóra Lengyel",
    open: ["Match acquirer files to ledger entries", "Alert on unmatched settlements"],
    done: [],
  },
  {
    label: "team-payouts",
    team: "Payouts",
    owner: "Péter Vass",
    open: ["Batch payouts by currency", "Retry failed bank transfers", "Payout cut-off banner"],
    done: ["Payout CSV export", "Payout status webhook"],
  },
  {
    label: "team-risk",
    team: "Risk",
    owner: "Zsófia Balogh",
    open: ["Velocity rules for new merchants"],
    done: ["Chargeback ratio dashboard"],
  },
];

const PAGES = {
  postmortem: `${PREFIX}Incident 2026-10 postmortem`,
  calendar: `${PREFIX}Release Calendar`,
  oncall: `${PREFIX}On-call Owners 2026-10`,
  runbook: `${PREFIX}Payments Refund Runbook`,
  runbookOld: `${PREFIX}Payments Refund Runbook (OLD)`,
};

const VERSION_FIX = '2.0 "Phoenix"';
const VERSION_PILOT = "1.0";
const CALENDAR = {
  phoenixDate: "2027-03-18",
  phoenixCab: "2027-03-11",
  promisedVersion: "1.1",
  promisedDate: "2026-12-15",
  pilotDate: "2026-03-31",
};

const JIRA = {
  bug: `${TAG}Bug: Settlement file omits refund lines`,
  fix: `${TAG}Fix: write refund lines into the settlement export`,
  pilot: `${TAG}Settlement export: refund lines for the 2025 pilot merchants`,
  apple: `${TAG}Apple Pay follow-up: merchant certificate renewal`,
  appleDuplicate: `${TAG}[DUPLICATE] Apple Pay follow-up: merchant certificate renewal`,
};

// ---------------------------------------------------------------------------------------------------------------------
// Jira helpers

interface IssueState {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  resolution: string | null;
  labels: string[];
  fixVersions: string[];
  sprints: string[];
  description: string;
}

async function state(key: string): Promise<IssueState> {
  const raw = record(await atl(["issue", "get", key, "--issue-fields", "summary,status,resolution,labels,fixVersions,customfield_10020,description"]));
  return {
    key: asString(raw.key),
    summary: asString(raw.summary),
    status: asString(raw.status),
    statusCategory: asString(raw.statusCategory),
    resolution: typeof raw.resolution === "string" ? raw.resolution : null,
    labels: asArray(raw.labels).map(asString),
    fixVersions: asArray(raw.fixVersions).map((entry) => (typeof entry === "string" ? entry : asString(record(entry).name))),
    sprints: asArray(raw.customfield_10020).map((sprint) => asString(record(sprint).name)),
    description: bodyText(raw.description),
  };
}

async function findExisting(): Promise<Map<string, string>> {
  const result = await atl(["jql", `project = NMS AND summary ~ "atl smoke nm chaos multi" ORDER BY created ASC`, "--all"]);
  const found = new Map<string, string>();
  for (const item of items(result)) {
    const summary = asString(item.summary);
    if (summary.startsWith(TAG) && !found.has(summary)) {
      found.set(summary, asString(item.key));
    }
  }
  return found;
}

interface IssueSpec {
  summary: string;
  type: string;
  body: string;
  labels?: string[];
  fixVersion?: string;
  done?: boolean;
}

async function versionIds(): Promise<{ ids: Map<string, string>; dates: Map<string, string> }> {
  const ids = new Map<string, string>();
  const dates = new Map<string, string>();
  for (const version of items(await atl(["version", "list", "NMS"]))) {
    ids.set(asString(version.name), asString(version.id));
    dates.set(asString(version.name), asString(version.releaseDate));
  }
  return { ids, dates };
}

async function ensureIssue(found: Map<string, string>, versions: Map<string, string>, spec: IssueSpec): Promise<string> {
  let key = found.get(spec.summary);
  if (key === undefined) {
    const args = ["issue", "create", "--project", "NMS", "--type", spec.type, "--summary", spec.summary, "--body", spec.body, "--set", `Sprint=${SPRINT_ID}`];
    if (spec.labels !== undefined) {
      args.push("--set", `labels=${JSON.stringify(spec.labels)}`);
    }
    if (spec.fixVersion !== undefined) {
      const id = versions.get(spec.fixVersion);
      if (id === undefined) {
        throw new Error(`NMS has no version ${spec.fixVersion}`);
      }
      args.push("--set", `fixVersions=${JSON.stringify([{ id }])}`);
    }
    key = asString(record(await atl(args)).key);
    writes += 1;
    found.set(spec.summary, key);
    log(`created ${key} ${spec.summary}`);
  }
  if (spec.done === true && (await state(key)).status !== DONE) {
    await atl(["issue", "move", key, DONE]);
    writes += 1;
    log(`${key}: moved to ${DONE}`);
  }
  return key;
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

async function jqlKeys(jql: string): Promise<string[]> {
  return items(await atl(["jql", jql, "--all", "--issue-fields", "summary"])).map((item) => asString(item.key));
}

// ---------------------------------------------------------------------------------------------------------------------
// Confluence helpers

function bodyFile(name: string, text: string): string {
  mkdirSync(BODIES, { recursive: true });
  const path = join(BODIES, `${name}.md`);
  writeFileSync(path, text);
  return path;
}

async function children(parent: string): Promise<Map<string, string>> {
  return new Map(items(await atl(["page", "children", parent, "--all"])).map((entry) => [asString(entry.title), asString(entry.id)]));
}

async function pageBody(id: string): Promise<string> {
  return bodyText(record(await atl(["page", "get", id])).body);
}

async function ensurePage(
  registry: Map<string, string>,
  space: string,
  parent: string,
  title: string,
  body: string,
  needles: readonly string[],
): Promise<string> {
  const file = bodyFile(title.slice(PREFIX.length).replaceAll(/[^A-Za-z0-9]+/g, "-"), body);
  let id = registry.get(title);
  if (id === undefined) {
    id = asString(record(await atl(["page", "create", "--space", space, "--title", title, "--parent", parent, "--file", file])).id);
    writes += 1;
    registry.set(title, id);
    log(`created page ${title} (${id})`);
  }
  let live = await pageBody(id);
  if (!needles.every((needle) => live.includes(needle))) {
    await atl(["page", "update", id, "--file", file, "--message", "Restore seeded body"]);
    writes += 1;
    log(`updated page ${title}`);
    live = await pageBody(id);
  }
  for (const needle of needles) {
    check(live.includes(needle), `page ${title}: body lacks ${JSON.stringify(needle)}`);
  }
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Page bodies

function postmortemBody(bug: string): string {
  return [
    "# Incident 2026-10: refund lines missing from the settlement file",
    "",
    "Severity: SEV2. Window: 6-8 October 2026. Incident lead: Márta Fehér.",
    "",
    "## Summary",
    "",
    "The settlement files sent to the acquirer on 6, 7 and 8 October carried the charge line of every refunded order but not its refund line. Finance noticed on 9 October when the totals did not reconcile.",
    "",
    "## Tracking",
    "",
    `- Tracking bug: ${bug}`,
    `- Customer communication: affected merchants were first told the fix would ship with ${CALENDAR.promisedVersion}. That promise was made before the fix was scoped; the issue that fixes the bug carries the real target version.`,
    "",
    "## Action items",
    "",
    "| Action | Owner | Status |",
    "|---|---|---|",
    "| Backfill the three affected settlement files | Finance ops | done |",
    "| Write refund lines into the settlement export | Payments | planned |",
    "| Add a reconciliation alert for unmatched refunds | Payments | planned |",
  ].join("\n");
}

function calendarBody(): string {
  return [
    "# Release calendar 2026-2027",
    "",
    "These are the committed release dates. Version dates in Jira are planning placeholders and may differ from this table.",
    "",
    "| Version | Codename | Release date | CAB |",
    "|---|---|---|---|",
    `| 1.0 | - | ${CALENDAR.pilotDate} | released |`,
    `| ${CALENDAR.promisedVersion} | - | ${CALENDAR.promisedDate} | 2026-12-10 |`,
    `| 2.0 | Phoenix | ${CALENDAR.phoenixDate} | ${CALENDAR.phoenixCab} |`,
    "| 2.1 | - | 2027-06-24 | 2027-06-17 |",
    "",
    "Corp releases go out on Thursdays after CAB approval.",
  ].join("\n");
}

function oncallBody(): string {
  return [
    "# On-call owners, October 2026",
    "",
    "Each team is on call through its owner. Jira issues of a team carry the team label from the first column.",
    "",
    "| Team label | Team | On-call owner |",
    "|---|---|---|",
    ...TEAMS.map((team) => `| ${team.label} | ${team.team} | ${team.owner} |`),
    "",
    "Owners who cover several teams are paged once.",
  ].join("\n");
}

function runbookBody(old: boolean): string {
  return [
    old ? "# Payments Refund Runbook (OLD)" : "# Payments Refund Runbook",
    "",
    old
      ? "ARCHIVED copy kept for the audit trail. Superseded by the current Payments Refund Runbook; do not use."
      : "Current procedure for manual refunds, valid from September 2026. The previous version is archived as the (OLD) copy.",
    "",
    "## Limits",
    "",
    `- Refunds up to ${old ? 250 : 500} EUR: any on-call engineer.`,
    `- Above ${old ? 250 : 500} EUR: a second approver from Finance ops.`,
    "",
    "## Steps",
    "",
    "1. Find the original charge in the ledger.",
    "2. Check that the order was not refunded already.",
    "3. Issue the refund and note the refund id in the ticket.",
    "4. Post the refund in the payments channel.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  const found = await findExisting();
  log(`found ${found.size} existing chaos multi issues`);
  const versions = await versionIds();

  const bug = await ensureIssue(found, versions.ids, {
    summary: JIRA.bug,
    type: "Bug",
    body: "Settlement files for refunded orders carry the charge line but not the refund line. Raised after the October incident.",
  });
  const fix = await ensureIssue(found, versions.ids, {
    summary: JIRA.fix,
    type: "Story",
    body: "Write one refund line per refunded order into the settlement export.",
    fixVersion: VERSION_FIX,
  });
  const pilot = await ensureIssue(found, versions.ids, {
    summary: JIRA.pilot,
    type: "Story",
    body: "Refund lines for the 2025 pilot merchants only (manual export). Shipped long before the October incident.",
    fixVersion: VERSION_PILOT,
    done: true,
  });
  await ensureLink(fix, "Blocks", bug, "blocks");
  await ensureLink(bug, "Relates", pilot, "relates to");

  const teamKeys = new Map<string, { open: string[]; done: string[] }>();
  for (const team of TEAMS) {
    const open: string[] = [];
    const done: string[] = [];
    for (const name of team.open) {
      open.push(await ensureIssue(found, versions.ids, { summary: `${TAG}${team.team}: ${name}`, type: "Feladat", body: `${team.team} team work item.`, labels: [team.label] }));
    }
    for (const name of team.done) {
      done.push(await ensureIssue(found, versions.ids, { summary: `${TAG}${team.team}: ${name}`, type: "Feladat", body: `${team.team} team work item, finished.`, labels: [team.label], done: true }));
    }
    teamKeys.set(team.label, { open, done });
  }

  const apple = await ensureIssue(found, versions.ids, {
    summary: JIRA.apple,
    type: "Story",
    body: "Renew the Apple Pay merchant certificate before it expires and confirm the new expiry date.",
  });
  const duplicate = await ensureIssue(found, versions.ids, {
    summary: JIRA.appleDuplicate,
    type: "Story",
    body: `Raised twice from the support queue; duplicate of ${apple}. Do not work on this one.`,
  });
  await ensureLink(duplicate, "Duplicate", apple, "duplicates");

  const chaosJira = await readChaosJira();

  const wikiRoot = (await children(NM_ROOT)).get(`${PREFIX}Root`);
  if (wikiRoot === undefined) {
    throw new Error(`${PREFIX}Root not found under ${NM_ROOT}: run seed-chaos-confluence.ts first`);
  }
  const wiki = await children(wikiRoot);
  const corp = await children(CORP_HOME);
  const postmortem = await ensurePage(wiki, WIKI_SPACE, wikiRoot, PAGES.postmortem, postmortemBody(bug), [`Tracking bug: ${bug}`, "first told the fix would ship"]);
  const calendar = await ensurePage(corp, CORP_SPACE, CORP_HOME, PAGES.calendar, calendarBody(), [CALENDAR.phoenixDate, CALENDAR.promisedDate, "Phoenix"]);
  const oncall = await ensurePage(wiki, WIKI_SPACE, wikiRoot, PAGES.oncall, oncallBody(), TEAMS.flatMap((team) => [team.label, team.owner]));
  const runbook = await ensurePage(wiki, WIKI_SPACE, wikiRoot, PAGES.runbook, runbookBody(false), ["500 EUR", "Current procedure"]);
  const runbookOld = await ensurePage(wiki, WIKI_SPACE, wikiRoot, PAGES.runbookOld, runbookBody(true), ["250 EUR", "ARCHIVED copy"]);

  // Read-back verification.
  const bugState = await state(bug);
  expect("bug: status", bugState.status, TODO);
  expect("bug: no fixVersion of its own", bugState.fixVersions, []);
  expect("bug: sprint", bugState.sprints, ["NMS Sprint 4"]);
  const fixState = await state(fix);
  expect("fix: fixVersion", fixState.fixVersions, [VERSION_FIX]);
  expect("fix: status", fixState.status, TODO);
  const pilotState = await state(pilot);
  expect("pilot: fixVersion", pilotState.fixVersions, [VERSION_PILOT]);
  expect("pilot: status", pilotState.status, DONE);
  expect(
    "bug: links",
    items(await atl(["issue", "links", bug])).map((link) => `${asString(link.relation)} ${asString(link.key)}`).toSorted(),
    [`is blocked by ${fix}`, `relates to ${pilot}`].toSorted(),
  );
  const phoenixJira = versions.dates.get(VERSION_FIX) ?? "";
  check(phoenixJira !== "" && phoenixJira !== CALENDAR.phoenixDate, `Jira date of ${VERSION_FIX} (${phoenixJira}) must differ from the calendar ${CALENDAR.phoenixDate}`);

  const owners = new Map<string, { open: number; all: number; labels: string[] }>();
  for (const team of TEAMS) {
    const open = await jqlKeys(`project = NMS AND labels = "${team.label}" AND statusCategory != Done`);
    const all = await jqlKeys(`project = NMS AND labels = "${team.label}"`);
    expect(`${team.label}: open`, open.length, team.open.length);
    expect(`${team.label}: all`, all.length, team.open.length + team.done.length);
    const entry = owners.get(team.owner) ?? { open: 0, all: 0, labels: [] };
    owners.set(team.owner, { open: entry.open + open.length, all: entry.all + all.length, labels: [...entry.labels, team.label] });
  }
  const ranked = [...owners.entries()].toSorted((a, b) => b[1].open - a[1].open);
  const [winner, runnerUp] = ranked;
  check(winner !== undefined && runnerUp !== undefined && winner[1].open > runnerUp[1].open, "on-call: open-issue winner is not unique");
  const byAll = [...owners.entries()].toSorted((a, b) => b[1].all - a[1].all)[0];
  check(byAll !== undefined && winner !== undefined && byAll[0] !== winner[0], "on-call: the owner with most issues incl. done must differ from the open winner");
  const biggestTeam = TEAMS.toSorted((a, b) => b.open.length - a.open.length)[0];
  check(biggestTeam !== undefined && winner !== undefined && biggestTeam.owner !== winner[0], "on-call: the owner of the biggest single team must differ from the winner");

  const appleState = await state(apple);
  const duplicateState = await state(duplicate);
  check([TODO, "Folyamatban"].includes(appleState.status), `apple pay: unexpected status ${appleState.status}`);
  expect("apple pay duplicate: status", duplicateState.status, TODO);
  expect("apple pay duplicate: link", items(await atl(["issue", "links", duplicate])).map((link) => `${asString(link.relation)} ${asString(link.key)}`), [`duplicates ${apple}`]);

  const mine = [...found.values()];
  const stray = await jqlKeys(`project = NMS AND summary ~ "atl smoke nm chaos multi" AND sprint is EMPTY AND statusCategory != Done`);
  expect("guard: open multi issues in no sprint (would join the NMS backlog)", stray, []);
  const inActive = await jqlKeys(`project = NMS AND summary ~ "atl smoke nm chaos multi" AND sprint = ${ACTIVE_SPRINT_ID}`);
  expect("guard: multi issues in the active sprint", inActive, []);
  const release11 = await jqlKeys(`project = NMS AND summary ~ "atl smoke nm chaos multi" AND fixVersion = "1.1"`);
  expect("guard: multi issues with fixVersion 1.1", release11, []);
  check(mine.length === 3 + TEAMS.reduce((sum, team) => sum + team.open.length + team.done.length, 0) + 2, `multi issue count ${mine.length}`);

  const postmortemLive = await pageBody(postmortem);
  check(postmortemLive.includes(bug) && !postmortemLive.includes(fix) && !postmortemLive.includes(CALENDAR.phoenixDate), "postmortem must name only the bug (not the fix or the final date)");
  const calendarLive = await pageBody(calendar);
  check(!calendarLive.includes(bug) && !calendarLive.includes(fix), "calendar page must not mention the issues");

  const winnerName = winner?.[0] ?? "";
  const winnerCount = winner?.[1].open ?? 0;
  const winnerLabels = winner?.[1].labels ?? [];
  const manifest = {
    generatedAt: new Date().toISOString(),
    pages: {
      postmortem: { id: postmortem, title: PAGES.postmortem, space: WIKI_SPACE },
      calendar: { id: calendar, title: PAGES.calendar, space: CORP_SPACE },
      oncall: { id: oncall, title: PAGES.oncall, space: WIKI_SPACE },
      runbook: { id: runbook, title: PAGES.runbook, space: WIKI_SPACE },
      runbookOld: { id: runbookOld, title: PAGES.runbookOld, space: WIKI_SPACE },
    },
    release: {
      bug,
      fix,
      pilot,
      fixVersion: VERSION_FIX,
      pilotVersion: VERSION_PILOT,
      date: CALENDAR.phoenixDate,
      cab: CALENDAR.phoenixCab,
      jiraPlaceholderDate: phoenixJira,
      promisedVersion: CALENDAR.promisedVersion,
      promisedDate: CALENDAR.promisedDate,
      pilotDate: CALENDAR.pilotDate,
    },
    oncall: {
      winner: winnerName,
      winnerOpen: winnerCount,
      winnerLabels,
      owners: [...owners.entries()].map(([name, entry]) => ({ name, open: entry.open, all: entry.all, labels: entry.labels })),
      biggestTeamOwner: biggestTeam?.owner ?? "",
      biggestTeamOpen: biggestTeam?.open.length ?? 0,
      mostIncludingDone: byAll?.[0] ?? "",
      mostIncludingDoneCount: byAll?.[1].all ?? 0,
      teams: TEAMS.map((team) => ({ label: team.label, owner: team.owner, keys: teamKeys.get(team.label) })),
    },
    apple: { key: apple, duplicate, existingChild: chaosJira.appleChild },
    runbooks: { current: runbook, old: runbookOld, onCall: chaosJira.onCallRunbook, onCallArchive: chaosJira.onCallArchive },
    facts: [
      {
        id: "multi-release-date",
        question: `The "${PAGES.postmortem}" page names a tracking bug. On which date does the fix for that bug ship, according to the release calendar in space ${CORP_SPACE}?`,
        answer: `${CALENDAR.phoenixDate} (${bug} is blocked by ${fix}, fixVersion 2.0 Phoenix)`,
        whyHard: `three hops: postmortem -> ${bug} -> ${fix} (${VERSION_FIX}) -> calendar table; decoys: ${CALENDAR.promisedDate} (the 1.1 promise in the postmortem), ${CALENDAR.pilotDate} (the older linked pilot issue, ${pilot}, fixVersion ${VERSION_PILOT}), ${phoenixJira} (Jira placeholder date of the version), ${CALENDAR.phoenixCab} (CAB)`,
      },
      {
        id: "multi-oncall-open",
        question: `On the page "${PAGES.oncall}", which on-call owner is responsible (across all teams they cover) for the most open NMS issues, and how many?`,
        answer: `${winnerName}: ${winnerCount} open (${winnerLabels.join(" + ")})`,
        whyHard: `owners: ${[...owners.entries()].map(([name, entry]) => `${name} ${entry.open} open / ${entry.all} total`).join("; ")}; the owner of the largest single team (${biggestTeam?.owner ?? ""}) and the owner with the most issues including done ones (${byAll?.[0] ?? ""}) are decoys`,
      },
      {
        id: "multi-write-runbook",
        question: "Add a comment to the payments refund runbook.",
        answer: `only on the current page ${runbook}; ${runbookOld} is the archived (OLD) copy`,
        whyHard: "two near-identical pages; the archived one is marked only by '(OLD)' in the title and an ARCHIVED banner",
      },
      {
        id: "multi-write-apple-pay",
        question: "Move the Apple Pay follow-up to In Progress and comment on it.",
        answer: `${apple}; ${duplicate} is the [DUPLICATE] decoy (duplicates ${apple}); ${chaosJira.appleChild} (Checkout v2: Apple Pay) is Done`,
        whyHard: "the duplicate has the same summary apart from the prefix and sits in the same status; only the summary prefix and the Duplicate link tell them apart",
      },
    ],
    createdThisRun: writes,
    atlCalls: calls,
    consistencyChecks: failures,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote ${MANIFEST}; ${writes} writes this run; ${failures.length} failed checks`);
  if (failures.length > 0) {
    process.exit(1);
  }
}

async function readChaosJira(): Promise<{ appleChild: string; onCallRunbook: string; onCallArchive: string }> {
  const jira = record(JSON.parse(await Bun.file(join(OUT, CHAOS_JIRA)).text()));
  const confluence = record(JSON.parse(await Bun.file(join(OUT, "chaos-confluence.json")).text()));
  const pages = record(confluence.pages);
  return {
    appleChild: asString(record(record(jira.children)["apple-pay"]).key),
    onCallRunbook: asString(record(pages.runbook).id),
    onCallArchive: asString(record(pages.archive).id),
  };
}

await main();
