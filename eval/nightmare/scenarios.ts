/**
 * Macro-eval scenarios on the corporate-nightmare dataset (eval/nightmare/seed-*.ts). Prompts are
 * natural-language (no tool or command names; the site host appears once); every expected value is
 * derived from the `facts` of eval/.out/nightmare/{jira,confluence}.json (n01-n15) or the verified values of
 * scrum.json (n16-n21) at load time. Checks
 * normalise formatting (thousand separators, decimal commas, date styles, duration units) and
 * reject the planted decoys: a decoy value stated without the answer next to it and without a
 * hedge ("earlier", "not", "comment 4 says", ...) fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";
import { atl, OUT } from "../lib.ts";
import { type Check, escapeRegExp, HOST, markerCount, type Scenario, verdict } from "../scenarios.ts";

const NIGHTMARE = join(OUT, "nightmare");

type Matcher = (text: string) => boolean;

interface Decoy {
  name: string;
  match: Matcher;
}

interface Expectation {
  label: string;
  answer: Matcher;
  decoys?: Decoy[];
}

interface Fact {
  question: string;
  answer: string;
  whyHard: string;
}

// ---------------------------------------------------------------------------
// Manifest access
// ---------------------------------------------------------------------------

function field(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") {
    throw new Error(`nightmare manifest field ${name} is not a string`);
  }
  return value;
}

function readManifest(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(NIGHTMARE, file), "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${file} is not an object`);
  }
  return parsed;
}

function readFacts(manifest: Record<string, unknown>): Map<string, Fact> {
  if (!Array.isArray(manifest.facts)) {
    throw new Error("nightmare manifest has no facts array");
  }
  const facts = new Map<string, Fact>();
  for (const entry of manifest.facts) {
    if (!isRecord(entry)) {
      throw new Error("nightmare fact is not an object");
    }
    facts.set(field(entry, "id"), {
      question: field(entry, "question"),
      answer: field(entry, "answer"),
      whyHard: field(entry, "whyHard"),
    });
  }
  return facts;
}

function factOf(facts: Map<string, Fact>, id: string): Fact {
  const fact = facts.get(id);
  if (fact === undefined) {
    throw new Error(`nightmare manifest has no fact ${id}`);
  }
  return fact;
}

/** First capture group (or the whole match) of `pattern` in `source`; throws when the manifest drifted. */
function capture(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  const value = match?.[1] ?? match?.[0];
  if (value === undefined) {
    throw new Error(`nightmare manifest text ${JSON.stringify(source.slice(0, 80))} does not match ${String(pattern)}`);
  }
  return value;
}

function captureAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

/** Values captured from every seeded Confluence body snapshot (decoys that live only in page bodies). */
function bodyValues(pattern: RegExp): string[] {
  const dir = join(NIGHTMARE, "bodies-confluence");
  return readdirSync(dir).flatMap((name) => {
    const match = pattern.exec(readFileSync(join(dir, name), "utf8"));
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function child(parent: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = parent[name];
  if (!isRecord(value)) {
    throw new Error(`scrum manifest field ${name} is not an object`);
  }
  return value;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("scrum manifest value is not an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("scrum manifest array entry is not an object");
    }
    return entry;
  });
}

function numberField(parent: Record<string, unknown>, name: string): number {
  const value = parent[name];
  if (typeof value !== "number") {
    throw new Error(`scrum manifest field ${name} is not a number`);
  }
  return value;
}

function list(parent: Record<string, unknown>, name: string): string[] {
  const value = parent[name];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`scrum manifest field ${name} is not a string list`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Text normalisation and matchers
// ---------------------------------------------------------------------------

/**
 * Invisible characters out, exotic spaces to plain spaces, digit grouping removed ("4,242.17",
 * "4 242.17", "4.242,17" -> "4242.17") and a two-digit decimal comma turned into a point.
 */
function normalise(text: string): string {
  return text
    .replaceAll(/\u200B|\u200C|\u200D|\u2060|\uFEFF/g, "")
    .replaceAll(/[\u00A0\u202F\u2009]/g, " ")
    .replaceAll(/(\d{1,3}(?:\.\d{3})+),(\d{1,2})(?!\d)/g, (_match, whole: string, fraction: string) => `${whole.replaceAll(".", "")}.${fraction}`)
    .replaceAll(/(?<=\d)[, ](?=\d{3}(?!\d))/g, "")
    .replaceAll(/(?<=\d),(?=\d{2}(?!\d))/g, ".");
}

const SENTENCE = /\n+|(?<=[.!?;])\s+/;

/** Wording that turns a decoy mention into a contrast rather than an answer. */
const HEDGE =
  /\b(?:not|no longer|never|earlier|early|previous(?:ly)?|prior|former(?:ly)?|original(?:ly)?|initial(?:ly)?|old|older|outdated|stale|superseded|replaced|instead|rather|wrong|incorrect|draft|estimate|decoy|red herring|however|whereas|although|noise|trap|misleading|leaning|rejected|comments?\s*#?\d+|version\s*\d+|v\d+)\b|n't/i;

function rx(pattern: RegExp): Matcher {
  return (text) => pattern.test(text);
}

/** `value` (already normalised, e.g. "4242.17") as a whole number, optionally followed by a unit. */
function numberMatcher(value: string, unit?: string): Matcher {
  const body = `(?<![\\d.])${escapeRegExp(value)}(?!\\d|\\.\\d)`;
  return rx(new RegExp(unit === undefined ? body : `${body}\\s*-?\\s*(?:${unit})(?![\\p{L}])`, "iu"));
}

/** `count` within 30 non-digit characters of a label, in either order. */
function nearMatcher(label: string, count: number): Matcher {
  const number = `(?<![\\d.])${count}(?!\\d)`;
  return rx(new RegExp(`(?:${label})[^\\n\\d]{0,30}${number}|${number}[^\\n\\d]{0,30}(?:${label})`, "i"));
}

const EN_MONTHS = ["January|Jan", "February|Feb", "March|Mar", "April|Apr", "May", "June|Jun", "July|Jul", "August|Aug", "September|Sept?", "October|Oct", "November|Nov", "December|Dec"];
const HU_MONTHS = ["január|jan", "február|febr?", "március|márc", "április|ápr", "május|máj", "június|jún", "július|júl", "augusztus|aug", "szeptember|szept?", "október|okt", "november|nov", "december|dec"];

/** An ISO date written as ISO, "14 Feb 2027", "February 14, 2027", "2027. február 14.", or 14/02/2027. */
function dateMatcher(iso: string): Matcher {
  const [year, month, day] = iso.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not an ISO date: ${iso}`);
  }
  const name = `(?:${EN_MONTHS[month - 1]}|${HU_MONTHS[month - 1]})`;
  const patterns = [
    `${year}[-/.]\\s?0?${month}[-/.]\\s?0?${day}(?!\\d)`,
    `(?<!\\d)0?${day}(?:st|nd|rd|th)?[\\s.-]+(?:of\\s+)?${name}\\.?,?\\s+${year}`,
    `${name}\\.?\\s+0?${day}(?:st|nd|rd|th)?,?\\s+${year}`,
    `${year}\\.?\\s*${name}\\.?\\s*0?${day}(?!\\d)`,
    `(?<!\\d)0?${day}[/.]0?${month}[/.]${year}`,
    `(?<!\\d)0?${month}/0?${day}/${year}`,
  ];
  return rx(new RegExp(patterns.join("|"), "iu"));
}

const DURATION_UNIT = "(?:days?|d|nap|hours?|hrs?|h|óra|ó|minutes?|mins?|m|perc)";
const DURATION_RUN = new RegExp(`(?:\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT}(?![\\p{L}])[\\s,]*(?:and\\s+)?)+`, "giu");
const DURATION_PART = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT})(?![\\p{L}])`, "giu");
const DURATION_CLOCK = /(\d+):(\d{2})\s*h(?![\p{L}])/giu;

/**
 * Every duration in `text`, in minutes: "27h 35m", "27 hours 35 minutes", "27.58 hours", "1655 min",
 * "27:35 h". A day counts as 8 and as 24 hours (Jira's working day vs the calendar day).
 */
function minutesIn(text: string): number[] {
  const found: number[] = [];
  for (const [, hours, minutes] of text.matchAll(DURATION_CLOCK)) {
    found.push(Number(hours) * 60 + Number(minutes));
  }
  for (const [run] of text.matchAll(DURATION_RUN)) {
    let days = 0;
    let rest = 0;
    for (const [, amount, unit] of run.matchAll(DURATION_PART)) {
      const value = Number(amount);
      const initial = (unit ?? "").toLowerCase().charAt(0);
      if (initial === "d" || initial === "n") {
        days += value;
      } else if (initial === "h" || initial === "ó") {
        rest += value * 60;
      } else {
        rest += value;
      }
    }
    found.push(rest + days * 480);
    if (days > 0) {
      found.push(rest + days * 1440);
    }
  }
  return found;
}

function minutesMatcher(expected: number): Matcher {
  return (text) => minutesIn(text).some((minutes) => Math.abs(minutes - expected) <= 1);
}

/** `value` as a number of its own: not part of a longer number, a decimal or a key such as NMS-44. */
function pointsMatcher(value: number): Matcher {
  return rx(new RegExp(`(?<![\\d.\\-])${value}(?!\\d|\\.\\d)`));
}

const POINTS_LABEL = "points?|estimates?|\\bSPs?\\b|pts";
const BACKLOG_LABEL = "backlog|issues|items|tickets|stories|work items";
const NUMBER_WORDS: Record<number, string> = { 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven" };

/** Like nearMatcher, but a number glued to a key ("NMS-44") does not count. */
function countMatcher(label: string, count: number): Matcher {
  const number = `(?<![\\d.\\-])${count}(?!\\d)`;
  return rx(new RegExp(`(?:${label})[^\\n\\d]{0,30}${number}|${number}[^\\n\\d]{0,30}(?:${label})`, "i"));
}

/** `value` next to "Sprint <n>" in either order within one line, without another "sprint" in between. */
function sprintMatcher(sprint: string, value: number): Matcher {
  const label = `sprint\\s*${sprint}(?!\\d)`;
  const number = `(?<![\\d.\\-])${value}(?!\\d)`;
  const gap = String.raw`(?:(?!sprint)[^\n]){0,60}?`;
  return rx(new RegExp(`${label}${gap}${number}|${number}${gap}${label}`, "i"));
}

/** `value` EUR as "25 EUR", "25 euros" or "€25". */
function eurMatcher(value: number): Matcher {
  return rx(new RegExp(`(?<![\\d.\\-])${value}(?!\\d|\\.\\d)\\s*(?:EUR|euros?|€)|€\\s*${value}(?!\\d)`, "i"));
}

function daysMatcher(value: number): Matcher {
  return rx(new RegExp(`(?<![\\d.\\-])${value}(?!\\d|\\.\\d)\\s*-?\\s*(?:(?:calendar\\s+|business\\s+|working\\s+)?days?|nap)(?![\\p{L}])`, "iu"));
}

/**
 * `day` stated for `role` and not for `other`: "Corp: Thursday", "Corp releases need CAB on Thursdays",
 * "Thursdays (Corp); ..." (the reverse order stops at a ';' or table pipe).
 */
function roleDayMatcher(role: string, other: string, day: string): Matcher {
  const forward = `${role}(?:(?!${other})[^\\n.]){0,60}?(?:${day})`;
  const reverse = `(?:${day})[^\\n.;|]{0,30}?${role}`;
  return rx(new RegExp(`${forward}|${reverse}`, "i"));
}

/**
 * Apply the expectations: each answer must appear somewhere; each decoy must not be stated in a
 * sentence (or line) that lacks the answer and carries no hedge (HEDGE or the scenario `excuse`).
 */
function judge(raw: string, expectations: Expectation[], excuse?: RegExp): Check {
  const text = normalise(raw);
  const sentences = text.split(SENTENCE).filter((sentence) => sentence.trim() !== "");
  const details: Record<string, boolean> = {};
  for (const expectation of expectations) {
    details[expectation.label] = expectation.answer(text);
    for (const decoy of expectation.decoys ?? []) {
      details[`${expectation.label}: not ${decoy.name}`] = !sentences.some(
        (sentence) =>
          decoy.match(sentence) &&
          !expectation.answer(sentence) &&
          !HEDGE.test(sentence) &&
          !(excuse?.test(sentence) ?? false),
      );
    }
  }
  return verdict(details);
}

/** Jira shows Hungarian status names; JQL and the MCP use the English ones. */
const STATUS_ALIASES: Record<string, string> = {
  Teendő: "To Do|To-Do|Todo",
  Folyamatban: "In Progress",
  "Ellenőrzés alatt": "In Review",
  Kész: "Done",
};

function statusCount(status: string, count: number): Matcher {
  const alias = STATUS_ALIASES[status];
  if (alias === undefined) {
    throw new Error(`no English alias for status ${status}`);
  }
  return nearMatcher(`${escapeRegExp(status)}|${alias}`, count);
}

function statusCounts(answer: string): [string, number][] {
  const parsed: unknown = JSON.parse(answer);
  if (!isRecord(parsed)) {
    throw new Error("mobile-status-counts answer is not an object");
  }
  return Object.entries(parsed).map(([status, count]) => {
    if (typeof count !== "number") {
      throw new Error("mobile-status-counts count is not a number");
    }
    return [status, count];
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function writeMarker(token: string): string {
  return `atl nm eval: root blocker acknowledged ${token}`;
}

function read(id: string, name: string, prompt: string, expectations: Expectation[], excuse?: RegExp): Scenario {
  return { id, name, write: false, prompt: () => prompt, check: (text) => judge(text, expectations, excuse) };
}

export function buildNightmareScenarios(): Scenario[] {
  const jira = readFacts(readManifest("jira.json"));
  const wikiManifest = readManifest("confluence.json");
  const wiki = readFacts(wikiManifest);
  const pages = wikiManifest.pages;
  if (!isRecord(pages)) {
    throw new Error("confluence.json has no pages object");
  }
  const page = (key: string): { id: string; title: string } => {
    const entry = pages[key];
    if (!isRecord(entry)) {
      throw new Error(`confluence.json has no page ${key}`);
    }
    return { id: field(entry, "id"), title: field(entry, "title") };
  };

  // n01: 13-hop "is blocked by" chain, root blocker named in the description of the last issue.
  const chain = factOf(jira, "chain-root");
  const chainStart = capture(chain.question, /KAN-\d+/);
  const chainRoot = capture(chain.answer, /KAN-\d+/);
  const chainNeighbour = `KAN-${Number(chainRoot.slice(4)) - 1}`;
  const renewal = capture(chain.answer, /REN-\d+/);

  // n02: 31st comment of 36 versus the early estimate in comment 4.
  const rollback = factOf(jira, "thread-31st-comment");
  const thread = capture(rollback.question, /KAN-\d+/);
  const rollbackMinutes = capture(rollback.answer, /^(\d+) minutes/);
  const rollbackDecoy = capture(rollback.answer, /about (\d+) minutes/);

  // n03: vendor named in an early comment, corrected by an edited later one.
  const vendor = factOf(jira, "thread-edited-vendor");
  const vendorRight = capture(vendor.answer, /^([^.]+)\./);
  const vendorWrong = capture(vendor.answer, /says ([^;]+);/);

  // n04: one table cell in a 20 KB description.
  const rateCard = factOf(jira, "ratecard-cell");
  const rateIssue = capture(rateCard.question, /KAN-\d+/);
  const merchant = capture(rateCard.question, /MERCH-\d+/);
  const fee = capture(rateCard.answer, /^\d+(?:\.\d+)?/);

  // n05: worklog total over an epic's stories and sub-tasks; mobile/platform worklogs are noise.
  const worklog = factOf(jira, "payments-worklog-total");
  const paymentsEpic = capture(worklog.question, /KAN-\d+/);
  const paymentMinutes = Number(capture(worklog.answer, /\((\d+) minutes\)/));

  // n06: status counts under an epic, two hierarchy levels plus a re-parented task.
  const mobile = factOf(jira, "mobile-status-counts");
  const mobileEpic = capture(mobile.question, /KAN-\d+/);
  const mobileCounts = statusCounts(mobile.answer);
  const mobileTotal = mobileCounts.reduce((sum, [, count]) => sum + count, 0);

  // n07: near-duplicate summaries; the in-progress one has the later cutover.
  const duplicate = factOf(jira, "near-duplicate");
  const [duplicateRight, duplicateWrong] = captureAll(duplicate.answer, /KAN-\d+/g);
  const [dateRight, dateWrong] = captureAll(duplicate.answer, /\d{4}-\d{2}-\d{2}/g);
  if (duplicateRight === undefined || duplicateWrong === undefined || dateRight === undefined || dateWrong === undefined) {
    throw new Error("near-duplicate answer lacks the two keys or dates");
  }

  // n08: value before the March change in the version messages of a 28-version page.
  const retention = factOf(wiki, "F01");
  const retentionDays = capture(retention.answer, /^\d+/);
  const retentionSeries = capture(retention.whyHard, /\(([\d, ]+)\)/).split(",").map((part) => part.trim());
  const retentionDecoys = [
    capture(retention.whyHard, /latest body says (\d+)/),
    capture(retention.whyHard, /makes (\d+) a trap/),
    retentionSeries[retentionSeries.lastIndexOf(retentionDays) + 1] ?? "",
  ];
  if (retentionDecoys.includes("")) {
    throw new Error("could not derive the retention decoys");
  }

  // n09: facts that exist only in inline comments (open correction, resolved extension).
  const handoff = factOf(wiki, "F02");
  const contract = factOf(wiki, "F13");
  const handoffDay = handoff.answer;
  const handoffWrong = capture(handoff.whyHard, /body says (\w+)/);
  const contractDate = contract.answer;
  const contractWrong = capture(contract.whyHard, /ends (\d{4}-\d{2}-\d{2})/);

  // n10: decision four reply levels deep.
  const rotation = factOf(wiki, "F03");
  const rotationLetter = capture(rotation.answer, /Rotation ([A-Z])/);
  const rotationWrong = rotationLetter === "A" ? "B" : "A";
  const rotationDate = capture(rotation.answer, /\d{4}-\d{2}-\d{2}/);
  const rotationHour = Number(capture(rotation.answer, /(\d{1,2}):00 UTC/));

  // n11: near-identical page titles told apart only by the ancestor path; plus a content property.
  const restart = factOf(wiki, "F04");
  const owner = factOf(wiki, "F20");
  const extension = capture(restart.answer, /^\d+/);
  const extensionDecoys = bodyValues(/phone extension \*\*(\d+)\*\*/).filter((value) => value !== extension);
  const tier = capture(owner.answer, /^\d+/);
  const tierWrong = capture(owner.whyHard, /tier (\d+) to/);

  // n12: one cell in a 300 KB table.
  const huge = factOf(wiki, "F05");
  const sku = capture(huge.question, /NM-SKU-\d+/);
  const price = normalise(capture(huge.answer, /[\d.,]+/));

  // n13: a page moved from HR to Engineering whose earlier version had another desk.
  const onboarding = factOf(wiki, "F06");
  const parentName = capture(onboarding.answer, /Parent: ([^;]+)/);
  const parentWords = parentName.split("/").map((part) => part.trim());
  const desk = capture(onboarding.answer, /Desk (\w+)/);
  const deskDecoys = bodyValues(/Laptop pickup: \*\*Desk (\w+)\*\*/).filter((value) => value !== desk);
  const hrParent = page("hr").title.replace(/^atl smoke nm /, "");

  // n14: wide page child count past the default page size.
  const wide = factOf(wiki, "F08");
  const direct = Number(capture(wide.answer, /(\d+) direct/));
  const descendants = Number(capture(wide.answer, /(\d+) descendants/));
  const pageSize = Number(capture(wide.whyHard, /past (\d+)/));

  // n15: cross-product write on the chain root and the Links and Jira page.
  const links = page("links");

  // n16-n19: scrum project NMS (scrum.json is written by seed-scrum.ts).
  const scrumManifest = readManifest("scrum.json");
  const scrumJira = child(scrumManifest, "jira");
  const scrumWiki = child(scrumManifest, "confluence");
  const activeSprint = child(scrumJira, "activeSprint");
  const sprintNumber = capture(field(activeSprint, "name"), /(\d+)$/);
  const sprintGoal = capture(field(activeSprint, "goal"), /^(.+?)(?:\s+[—–-]\s+|$)/);
  const remainingPoints = numberField(activeSprint, "remainingPoints");
  const totalPoints = numberField(activeSprint, "totalPoints");
  const legacyRemainingPoints = numberField(activeSprint, "legacyRemainingPoints");
  const legacyTotalPoints = numberField(activeSprint, "legacyTotalPoints");

  // n17: story in sprints 1-3; the legacy Story Points field disagrees with the estimate field.
  const carryOver = child(scrumJira, "carryOver");
  const carriedKey = field(carryOver, "key");
  const carriedPoints = numberField(carryOver, "points");
  const carriedLegacy = numberField(carryOver, "legacyPoints");
  const carriedDuplicate = list(carryOver, "duplicateKeys")[0];
  const carriedPartial = list(carryOver, "partialKeys")[0];
  if (carriedDuplicate === undefined || carriedPartial === undefined) {
    throw new Error("scrum.json carryOver lacks the duplicate or partial carry-over key");
  }

  // n18: points completed in each closed sprint; committed points (also with the legacy field) are the decoys.
  const closedSprints = asRecords(scrumJira.velocity).map((entry) => ({
    name: field(entry, "sprint"),
    number: capture(field(entry, "sprint"), /(\d+)$/),
    completed: numberField(entry, "completed"),
    committed: numberField(entry, "committed"),
    committedLegacy: numberField(entry, "committedLegacy"),
  }));

  // n19: backlog rows that are not [DUPLICATE]; the decoys are the full backlog and the backlog plus epics.
  const backlog = child(scrumJira, "backlog");
  const backlogKeys = list(backlog, "keys");
  const duplicateKeys = list(backlog, "duplicateKeys");
  const backlogWithDuplicates = numberField(backlog, "withDuplicates");
  const backlogWithEpics = numberField(backlog, "withEpics");

  // n20-n21: second space NMCORP; superseded draft and the same-titled Engineering page are the decoys.
  const corpSpaceName = field(child(scrumWiki, "space"), "name");
  const expense = child(scrumWiki, "expense");
  const expenseDraft = child(scrumWiki, "expenseDraft");
  const expenseReceipt = numberField(expense, "receiptEur");
  const expenseDays = numberField(expense, "days");
  const draftReceipt = numberField(expenseDraft, "receiptEur");
  const draftDays = numberField(expenseDraft, "days");
  const release = child(scrumWiki, "release");
  const corpDay = field(release, "corpDay");
  const engineeringDay = field(release, "engineeringDay");
  const releaseTitle = field(child(child(scrumWiki, "pages"), "release"), "title");

  return [
    read(
      "n01-chain-root",
      "Blocked-by chain, 13 hops",
      `On ${HOST}, ${chainStart} is stuck behind a long chain of issues, each waiting on the next one. Follow the chain all the way to the end: which issue is at the root of it, and what is actually blocking that issue?`,
      [
        {
          label: `root ${chainRoot}`,
          answer: rx(new RegExp(`\\b${chainRoot}\\b`)),
          decoys: [
            {
              name: `${chainNeighbour} as root`,
              match: (text) => new RegExp(`\\b${chainNeighbour}\\b`).test(text) && !text.includes(chainRoot) && /root|end of the chain|ultimate|actual/i.test(text),
            },
            { name: "legal review as blocker", match: (text) => /legal/i.test(text) && /block|root|waiting/i.test(text) },
          ],
        },
        { label: `blocker ${renewal}`, answer: rx(new RegExp(`\\b${renewal}\\b`)) },
      ],
    ),
    read(
      "n02-thread-31st-comment",
      "31st of 36 comments vs early estimate",
      `On ${HOST}, ${thread} is a war room with a long comment thread. What rollback window does the 31st comment state?`,
      [
        {
          label: `${rollbackMinutes} minutes`,
          answer: numberMatcher(rollbackMinutes),
          decoys: [{ name: `${rollbackDecoy} minutes`, match: numberMatcher(rollbackDecoy, "minutes?|mins?|perc") }],
        },
      ],
    ),
    read(
      "n03-thread-vendor",
      "Edited comment contradicts earlier one",
      `On ${HOST}, according to the latest information in the comments on ${thread}, which vendor supplies the HSM?`,
      [
        {
          label: vendorRight,
          answer: rx(new RegExp(escapeRegExp(vendorRight), "i")),
          decoys: [
            {
              name: vendorWrong,
              match: rx(new RegExp(escapeRegExp(vendorWrong), "i")),
            },
          ],
        },
      ],
      /withdr[ae]w|withdrawn/i,
    ),
    read(
      "n04-ratecard-cell",
      "Table cell in a 20 KB description",
      `On ${HOST}, ${rateIssue} has a rate card table in its description. What is the settlement fee in bps for ${merchant}?`,
      [
        { label: `fee ${fee}`, answer: numberMatcher(fee) },
        { label: merchant, answer: rx(new RegExp(merchant, "i")) },
      ],
    ),
    read(
      "n05-payments-worklog",
      "Epic worklog total, mixed units",
      `On ${HOST}, how much time has been logged in total on all the work under the Payments epic ${paymentsEpic}, including its stories' sub-tasks?`,
      [
        {
          label: `total ${Math.floor(paymentMinutes / 60)}h ${paymentMinutes % 60}m`,
          answer: minutesMatcher(paymentMinutes),
          decoys: [480, 120, 600].map((noise) => ({
            name: `total with ${noise} noise minutes`,
            match: minutesMatcher(paymentMinutes + noise),
          })),
        },
      ],
    ),
    read(
      "n06-mobile-status-counts",
      "Epic status counts incl. sub-tasks and re-parented task",
      `On ${HOST}, count every issue under the Mobile epic ${mobileEpic}, sub-tasks included (one task was moved there from another epic). How many are there per status?`,
      [
        {
          label: `total ${mobileTotal}`,
          answer: numberMatcher(String(mobileTotal)),
        },
        ...mobileCounts.map(([status, count]) => ({ label: `${status}=${count}`, answer: statusCount(status, count) })),
      ],
    ),
    read(
      "n07-near-duplicate",
      "Near-identical summaries, in-progress one",
      `On ${HOST}, there are two almost identically named Platform issues about migrating the billing ledger to Postgres. Which one is still being worked on? Give me its key and its planned cutover date.`,
      [
        {
          label: `key ${duplicateRight}`,
          answer: rx(new RegExp(`\\b${duplicateRight}\\b`)),
          decoys: [{ name: `${duplicateWrong} as the live one`, match: rx(new RegExp(`\\b${duplicateWrong}\\b`)) }],
        },
        {
          label: `cutover ${dateRight}`,
          answer: dateMatcher(dateRight),
          decoys: [{ name: `cutover ${dateWrong}`, match: dateMatcher(dateWrong) }],
        },
        { label: "status in progress", answer: rx(/folyamatban|in progress|being worked|ongoing|active/i) },
      ],
      /\b(?:done|kész|closed|completed|finished|retired|cut over|postgres 15)\b/i,
    ),
    read(
      "n08-version-before-march",
      "Value before the March change (version history)",
      `On ${HOST}, the wiki page "${page("retention").title}" in space SZOFTVERFE has been edited many times and its version messages mention a change in March. What was the hot log retention, in days, right before that March change?`,
      [
        {
          label: `${retentionDays} days`,
          answer: numberMatcher(retentionDays),
          decoys: retentionDecoys.map((value) => ({ name: `${value} days`, match: numberMatcher(value, "days?|d|nap") })),
        },
      ],
      /\b(?:from|to|→|->|raised|increased|reduced|reverted|revert|changed)\b|→|->/i,
    ),
    read(
      "n09-inline-comments",
      "Facts only in inline comments",
      `On ${HOST}, on the page "${page("inline").title}": on which weekday does the on-call handoff happen, and until which date was the Northwind vendor contract extended? Take the discussion on the page into account, not just the text.`,
      [
        {
          label: handoffDay,
          answer: rx(new RegExp(`${handoffDay}|csütörtök`, "i")),
          decoys: [{ name: handoffWrong, match: rx(new RegExp(`${handoffWrong}|hétfő`, "i")) }],
        },
        {
          label: `contract ${contractDate}`,
          answer: dateMatcher(contractDate),
          decoys: [{ name: `contract ${contractWrong}`, match: dateMatcher(contractWrong) }],
        },
      ],
      /\b(?:body|text|page says|says)\b/i,
    ),
    read(
      "n10-deep-reply",
      "Decision four replies deep",
      `On ${HOST}, the page "${page("deep").title}" has a long comment discussion about the on-call rotation. What was the final decision, from which date does it start, and at what time is the pager handoff?`,
      [
        {
          label: `rotation ${rotationLetter}`,
          answer: rx(new RegExp(`(?:rotation|option|plan|variant)\\s*${rotationLetter}\\b|follow[- ]the[- ]sun`, "i")),
          decoys: [
            {
              name: `rotation ${rotationWrong} as the decision`,
              match: rx(new RegExp(`(?:rotation|option|plan|variant)\\s*${rotationWrong}\\b|weekly`, "i")),
            },
          ],
        },
        { label: `start ${rotationDate}`, answer: dateMatcher(rotationDate) },
        { label: `handoff ${rotationHour}:00`, answer: rx(new RegExp(`(?<!\\d)0?${rotationHour}[:.]00|(?<!\\d)${rotationHour}\\s*(?:am|a\\.m\\.)`, "i")) },
      ],
      /\b(?:hybrid|feasible|approved|costs|before|lean(?:ed|s)?)\b/i,
    ),
    read(
      "n11-restart-ancestor",
      "Near-duplicate titles, ancestor path + property",
      `On ${HOST}, several wiki pages are titled almost exactly "${normalise(page("restart-eng").title)}". I need the one under Engineering / Mérnökség > Runbooks, not the ones in Security, Finance, HR or Systems. What is the escalation phone extension on it, and what tier does its nm-owner page property have?`,
      [
        {
          label: `extension ${extension}`,
          answer: numberMatcher(extension),
          decoys: extensionDecoys.map((value) => ({ name: `extension ${value}`, match: numberMatcher(value) })),
        },
        {
          label: `tier ${tier}`,
          answer: nearMatcher("tier", Number(tier)),
          decoys: [{ name: `tier ${tierWrong}`, match: nearMatcher("tier", Number(tierWrong)) }],
        },
      ],
      /\b(?:security|finance|pénzügy|hr|systems|ir runbooks|other|others|elsewhere|from|updated)\b/i,
    ),
    read(
      "n12-huge-page-cell",
      "One cell in a 300 KB table",
      `On ${HOST}, the wiki page "${page("huge").title}" has a giant parts table. What is the price of ${sku}?`,
      [
        { label: `price ${price}`, answer: numberMatcher(price) },
        { label: "currency", answer: rx(/EUR|€|euro/i) },
      ],
    ),
    read(
      "n13-moved-page",
      "Moved page: current parent + earlier-version value",
      `On ${HOST}, the wiki page "${page("onboarding").title}" used to be somewhere else. Under which page does it live now, and which desk is given for laptop pickup?`,
      [
        {
          label: `parent ${parentName}`,
          answer: rx(new RegExp(parentWords.map(escapeRegExp).join("|"), "i")),
          decoys: [
            {
              name: `parent ${hrParent}`,
              match: (text) => new RegExp(`${escapeRegExp(hrParent)}|emberi`, "i").test(text) && /parent|under|lives|located|moved to/i.test(text),
            },
          ],
        },
        {
          label: `desk ${desk}`,
          answer: rx(new RegExp(`desk\\s*${desk}\\b`, "i")),
          decoys: deskDecoys.map((value) => ({ name: `desk ${value}`, match: rx(new RegExp(`desk\\s*${value}\\b`, "i")) })),
        },
      ],
      /\b(?:created|used to|was|moved|from|hr)\b/i,
    ),
    read(
      "n14-wide-index",
      "Wide page: children and descendants",
      `On ${HOST}, how many direct child pages does the wiki page "${page("wide").title}" have, and how many pages are below it in total, counting deeper levels?`,
      [
        { label: `${direct} direct children`, answer: nearMatcher("direct|child|children", direct) },
        {
          label: `${descendants} descendants`,
          answer: nearMatcher("descendants?|in total|total|altogether|overall|below|nested|all pages", descendants),
          decoys: [
            { name: `${pageSize} (first page of results)`, match: nearMatcher("child|children|descendants?|total|direct", pageSize) },
          ],
        },
      ],
      /\b(?:page size|per page|limit|first page|default)\b/i,
    ),
    {
      id: "n15-write-root-blocker",
      name: "Write: comment on chain root + wiki page",
      write: true,
      pickTarget: () => Date.now().toString(36),
      prompt: (_arm, target) =>
        `On ${HOST}, ${chainStart} is stuck behind a long chain of issues that block each other. Find the issue at the very end of that chain (the root blocker) and add the comment "${writeMarker(target ?? "?")}" to it. Then add the same text as a footer comment on the Confluence page "${links.title}". Tell me which issue you commented on.`,
      check: async (text, _arm, target) => {
        if (target === undefined) {
          throw new Error("write scenario needs a run token");
        }
        const marker = writeMarker(target);
        const onRoot = markerCount((await atl("issue", "comments", chainRoot, "--all")).stdout, marker);
        const onNeighbour = markerCount((await atl("issue", "comments", chainNeighbour, "--all")).stdout, marker);
        const onStart = markerCount((await atl("issue", "comments", chainStart, "--all")).stdout, marker);
        const onPage = markerCount((await atl("comment", "list", links.id, "--all")).stdout, marker);
        return {
          ...verdict({
            rootComment: onRoot === 1,
            pageComment: onPage === 1,
            notOnNeighbour: onNeighbour === 0,
            notOnStart: onStart === 0,
            namesRoot: new RegExp(`\\b${chainRoot}\\b`).test(text),
          }),
          details: [`read-back token ${target}: ${chainRoot}=${onRoot} ${chainNeighbour}=${onNeighbour} ${chainStart}=${onStart} page ${links.id}=${onPage}`],
        };
      },
    },
    read(
      "n16-current-sprint",
      "Active sprint: name, goal, remaining points",
      `On ${HOST}, in the NMS Scrum project (the NMS board), which sprint is active right now, what is its goal, and how many story points are still remaining in it (not yet done)?`,
      [
        { label: `sprint ${sprintNumber}`, answer: rx(new RegExp(`sprint\\s*${sprintNumber}(?!\\d)`, "i")) },
        { label: "goal", answer: rx(new RegExp(escapeRegExp(sprintGoal), "i")) },
        {
          label: `${remainingPoints} points remaining`,
          answer: pointsMatcher(remainingPoints),
          decoys: [totalPoints, legacyRemainingPoints, legacyTotalPoints].map((value) => ({ name: `${value} points`, match: pointsMatcher(value) })),
        },
      ],
      /\b(?:total|scope|committed|overall|planned|legacy|field|sum)\b/i,
    ),
    read(
      "n17-carry-over",
      "Story carried over from Sprint 1, estimate",
      `On ${HOST}, in the NMS Scrum project one story was started in Sprint 1, carried over into Sprint 2 and is still open in the current sprint. Which issue is it, and what is its story point estimate?`,
      [
        {
          label: `issue ${carriedKey}`,
          answer: rx(new RegExp(`\\b${carriedKey}\\b`)),
          decoys: [carriedDuplicate, carriedPartial].map((key) => ({ name: `${key} as the carried-over story`, match: rx(new RegExp(`\\b${key}\\b`)) })),
        },
        {
          label: `${carriedPoints} points`,
          answer: countMatcher(POINTS_LABEL, carriedPoints),
          decoys: [{ name: `${carriedLegacy} points`, match: countMatcher(POINTS_LABEL, carriedLegacy) }],
        },
      ],
      /\b(?:duplicate|twin|only|two sprints|sprint 2|legacy|field|other|another)\b/i,
    ),
    read(
      "n18-velocity",
      "Velocity of the two closed sprints",
      `On ${HOST}, what was the velocity of the NMS team: how many story points were completed in Sprint 1 and how many in Sprint 2?`,
      closedSprints.map((sprint) => ({
        label: `${sprint.name}: ${sprint.completed}`,
        answer: sprintMatcher(sprint.number, sprint.completed),
        decoys: [sprint.committed, sprint.committedLegacy].map((value) => ({ name: `${sprint.name}: ${value}`, match: sprintMatcher(sprint.number, value) })),
      })),
      /\b(?:committed|commit|planned|scope|legacy|carried|incomplete|total)\b/i,
    ),
    read(
      "n19-backlog-hygiene",
      "Backlog without the [DUPLICATE] decoys",
      `On ${HOST}, how many issues are in the backlog of the NMS board that are real work items, i.e. not duplicates of other issues? List them.`,
      [
        {
          label: `${backlogKeys.length} issues`,
          answer: (text) =>
            countMatcher(BACKLOG_LABEL, backlogKeys.length)(text) ||
            rx(new RegExp(`\\b${NUMBER_WORDS[backlogKeys.length] ?? "-"}\\b`, "i"))(text) ||
            rx(new RegExp(`(?<![\\d.\\-])${backlogKeys.length} of (?:the |all )?\\d+\\b`, "i"))(text),
          decoys: [backlogWithDuplicates, backlogWithEpics].map((value) => ({ name: `${value} issues`, match: countMatcher(BACKLOG_LABEL, value) })),
        },
        ...backlogKeys.map((key) => ({
          label: key,
          answer: rx(new RegExp(`\\b${key}\\b`)),
          decoys:
            key === backlogKeys[0]
              ? [{ name: "a [DUPLICATE] issue as a real backlog item", match: rx(new RegExp(`\\b(?:${duplicateKeys.join("|")})\\b`)) }]
              : [],
        })),
      ],
      /\b(?:duplicate|duplicates|dupe|twin|twins|exclud\w*|epics?|including|holds|in total|left out|leaving|skipped|drop(?:ped)?)\b/i,
    ),
    read(
      "n20-corp-expense",
      "Current vs superseded draft expense policy",
      `On ${HOST}, in the Confluence space "${corpSpaceName}", what does the current Expense Policy say: above which amount are receipts required, and within how many days must an expense be submitted? The space also holds an older draft; go by the policy that is in force.`,
      [
        {
          label: `receipts above ${expenseReceipt} EUR`,
          answer: eurMatcher(expenseReceipt),
          decoys: [{ name: `${draftReceipt} EUR`, match: eurMatcher(draftReceipt) }],
        },
        {
          label: `${expenseDays} days`,
          answer: daysMatcher(expenseDays),
          decoys: [{ name: `${draftDays} days`, match: daysMatcher(draftDays) }],
        },
      ],
    ),
    read(
      "n21-cross-space-release",
      "Same title in two spaces: Corp vs Engineering",
      `On ${HOST}, two Confluence pages are titled "${releaseTitle}", one in the Corp Handbook space and one in the Engineering space (Szoftverfejlesztés). On which weekday do Corp releases need CAB approval, and how does the Engineering release process differ?`,
      [
        {
          label: `Corp: ${corpDay}`,
          answer: roleDayMatcher("corp", "engineering", `${corpDay}|csütörtök`),
        },
        {
          label: `Engineering: ${engineeringDay}`,
          answer: roleDayMatcher("engineering", "corp", `${engineeringDay}|kedd`),
        },
        {
          label: "Engineering: no CAB",
          answer: rx(/\bno\s+(?:CAB|change advisory)|without\s+(?:a\s+)?(?:CAB|change advisory)|(?:CAB|change advisory)[^\n.]{0,40}(?:not|n't)\s+(?:required|needed|necessary)|(?:doesn't|does not|don't|do not)\s+(?:need|require)[^\n.]{0,30}(?:CAB|approval)|no (?:CAB )?approval/i),
        },
      ],
    ),
  ];
}
