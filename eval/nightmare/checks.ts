/** Shared answer checks for the nightmare scenarios: manifest readers, matchers, decoy judging. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";
import { atl, OUT } from "../lib.ts";
import { type Check, escapeRegExp, type Scenario, verdict } from "../scenarios.ts";

export const NIGHTMARE = join(OUT, "nightmare");

export type Matcher = (text: string) => boolean;

export interface Decoy {
  name: string;
  match: Matcher;
}

export interface Expectation {
  label: string;
  answer: Matcher;
  decoys?: Decoy[];
}

export interface Fact {
  question: string;
  answer: string;
  whyHard: string;
}

// ---------------------------------------------------------------------------
// Manifest access
// ---------------------------------------------------------------------------

export function field(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") {
    throw new Error(`nightmare manifest field ${name} is not a string`);
  }
  return value;
}

export function readManifest(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(NIGHTMARE, file), "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${file} is not an object`);
  }
  return parsed;
}

export function readFacts(manifest: Record<string, unknown>): Map<string, Fact> {
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

export function factOf(facts: Map<string, Fact>, id: string): Fact {
  const fact = facts.get(id);
  if (fact === undefined) {
    throw new Error(`nightmare manifest has no fact ${id}`);
  }
  return fact;
}

/** First capture group (or the whole match) of `pattern` in `source`; throws when the manifest drifted. */
export function capture(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  const value = match?.[1] ?? match?.[0];
  if (value === undefined) {
    throw new Error(`nightmare manifest text ${JSON.stringify(source.slice(0, 80))} does not match ${String(pattern)}`);
  }
  return value;
}

export function captureAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

/** Values captured from every seeded Confluence body snapshot (decoys that live only in page bodies). */
export function bodyValues(pattern: RegExp): string[] {
  const dir = join(NIGHTMARE, "bodies-confluence");
  return readdirSync(dir).flatMap((name) => {
    const match = pattern.exec(readFileSync(join(dir, name), "utf8"));
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

export function child(parent: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = parent[name];
  if (!isRecord(value)) {
    throw new Error(`scrum manifest field ${name} is not an object`);
  }
  return value;
}

export function asRecords(value: unknown): Record<string, unknown>[] {
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

export function numberField(parent: Record<string, unknown>, name: string): number {
  const value = parent[name];
  if (typeof value !== "number") {
    throw new Error(`scrum manifest field ${name} is not a number`);
  }
  return value;
}

export function list(parent: Record<string, unknown>, name: string): string[] {
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
export function normalise(text: string): string {
  return text
    .replaceAll(/\u200B|\u200C|\u200D|\u2060|\uFEFF/g, "")
    .replaceAll(/[\u00A0\u202F\u2009]/g, " ")
    .replaceAll(/(\d{1,3}(?:\.\d{3})+),(\d{1,2})(?!\d)/g, (_match, whole: string, fraction: string) => `${whole.replaceAll(".", "")}.${fraction}`)
    .replaceAll(/(?<=\d)[, ](?=\d{3}(?!\d))/g, "")
    .replaceAll(/(?<=\d),(?=\d{2}(?!\d))/g, ".");
}

export const SENTENCE = /\n+|(?<=[.!?;])\s+/;

/** Wording that turns a decoy mention into a contrast rather than an answer. */
export const HEDGE =
  /\b(?:not|no longer|never|earlier|early|previous(?:ly)?|prior|former(?:ly)?|original(?:ly)?|initial(?:ly)?|old|older|outdated|out[- ]of[- ]date|stale|superseded|replaced|instead|rather|wrong|incorrect|draft|estimate|decoy|red herring|however|whereas|although|noise|trap|misleading|leaning|rejected|comments?\s*#?\d+|version\s*\d+|v\d+)\b|n't/i;

export function rx(pattern: RegExp): Matcher {
  return (text) => pattern.test(text);
}

/** `value` (already normalised, e.g. "4242.17") as a whole number, optionally followed by a unit. */
export function numberMatcher(value: string, unit?: string): Matcher {
  const body = `(?<![\\d.])${escapeRegExp(value)}(?!\\d|\\.\\d)`;
  return rx(new RegExp(unit === undefined ? body : `${body}\\s*-?\\s*(?:${unit})(?![\\p{L}])`, "iu"));
}

/** `count` within 30 non-digit characters of a label, in either order. */
export function nearMatcher(label: string, count: number): Matcher {
  const number = `(?<![\\d.])${count}(?!\\d)`;
  return rx(new RegExp(`(?:${label})[^\\n\\d]{0,30}${number}|${number}[^\\n\\d]{0,30}(?:${label})`, "i"));
}

export const EN_MONTHS = ["January|Jan", "February|Feb", "March|Mar", "April|Apr", "May", "June|Jun", "July|Jul", "August|Aug", "September|Sept?", "October|Oct", "November|Nov", "December|Dec"];
export const HU_MONTHS = ["január|jan", "február|febr?", "március|márc", "április|ápr", "május|máj", "június|jún", "július|júl", "augusztus|aug", "szeptember|szept?", "október|okt", "november|nov", "december|dec"];

/** An ISO date written as ISO, "14 Feb 2027", "February 14, 2027", "2027. február 14.", or 14/02/2027. */
export function dateMatcher(iso: string): Matcher {
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

export const DURATION_UNIT = "(?:days?|d|nap|hours?|hrs?|h|óra|ó|minutes?|mins?|m|perc)";
export const DURATION_RUN = new RegExp(`(?:\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT}(?![\\p{L}])[\\s,]*(?:and\\s+)?)+`, "giu");
export const DURATION_PART = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT})(?![\\p{L}])`, "giu");
export const DURATION_CLOCK = /(\d+):(\d{2})\s*h(?![\p{L}])/giu;

/**
 * Every duration in `text`, in minutes: "27h 35m", "27 hours 35 minutes", "27.58 hours", "1655 min",
 * "27:35 h". A day counts as 8 and as 24 hours (Jira's working day vs the calendar day).
 */
export function minutesIn(text: string): number[] {
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

export function minutesMatcher(expected: number): Matcher {
  return (text) => minutesIn(text).some((minutes) => Math.abs(minutes - expected) <= 1);
}

/** `value` as a number of its own: not part of a longer number, a decimal or a key such as NMS-44. */
export function pointsMatcher(value: number): Matcher {
  return rx(new RegExp(`(?<![\\d.\\-])${value}(?!\\d|\\.\\d)`));
}

export const POINTS_LABEL = "points?|estimates?|\\bSPs?\\b|pts";
export const BACKLOG_LABEL = "backlog|issues|items|tickets|stories|work items";
export const NUMBER_WORDS: Record<number, string> = { 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven" };

/** Like nearMatcher, but a number glued to a key ("NMS-44") does not count. */
export function countMatcher(label: string, count: number): Matcher {
  const number = `(?<![\\d.\\-])${count}(?!\\d)`;
  return rx(new RegExp(`(?:${label})[^\\n\\d]{0,30}${number}|${number}[^\\n\\d]{0,30}(?:${label})`, "i"));
}

/** `value` next to "Sprint <n>" in either order within one line, without another "sprint" in between. */
export function sprintMatcher(sprint: string, value: number): Matcher {
  const label = `sprint\\s*${sprint}(?!\\d)`;
  const number = `(?<![\\d.\\-])${value}(?!\\d)`;
  const gap = String.raw`(?:(?!sprint)[^\n]){0,60}?`;
  return rx(new RegExp(`${label}${gap}${number}|${number}${gap}${label}`, "i"));
}

/** `value` EUR as "25 EUR", "25 euros" or "€25". */
export function eurMatcher(value: number): Matcher {
  return rx(new RegExp(`(?<![\\d.\\-])${value}(?!\\d|\\.\\d)\\s*(?:EUR|euros?|€)|€\\s*${value}(?!\\d)`, "i"));
}

export function daysMatcher(value: number): Matcher {
  return rx(new RegExp(`(?<![\\d.\\-])${value}(?!\\d|\\.\\d)\\s*-?\\s*(?:(?:calendar\\s+|business\\s+|working\\s+)?days?|nap)(?![\\p{L}])`, "iu"));
}

/**
 * `day` stated for `role` and not for `other`: "Corp: Thursday", "Corp releases need CAB on Thursdays",
 * "Thursdays (Corp); ..." (the reverse order stops at a ';' or table pipe).
 */
export function roleDayMatcher(role: string, other: string, day: string): Matcher {
  const forward = `${role}(?:(?!${other})[^\\n.]){0,60}?(?:${day})`;
  const reverse = `(?:${day})[^\\n.;|]{0,30}?${role}`;
  return rx(new RegExp(`${forward}|${reverse}`, "i"));
}

/**
 * Apply the expectations: each answer must appear somewhere; each decoy must not be stated in a
 * sentence (or line) that lacks the answer and carries no hedge (HEDGE or the scenario `excuse`).
 */
export function judge(raw: string, expectations: Expectation[], excuse?: RegExp): Check {
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
export const STATUS_ALIASES: Record<string, string> = {
  Teendő: "To Do|To-Do|Todo",
  Folyamatban: "In Progress",
  "Ellenőrzés alatt": "In Review",
  Kész: "Done",
};

export function statusCount(status: string, count: number): Matcher {
  const alias = STATUS_ALIASES[status];
  if (alias === undefined) {
    throw new Error(`no English alias for status ${status}`);
  }
  const label = `${escapeRegExp(status)}|${alias}`;
  const near = nearMatcher(label, count);
  const row = new RegExp(`(?:${label})`, "i");
  // A breakdown row ("| Folyamatban | 1 | 3 | **4** |") states the status total as the row's last number.
  return (text) =>
    near(text) ||
    text.split("\n").some((line) => row.test(line) && line.includes("|") && Number(line.match(/\d+/g)?.at(-1)) === count);
}

export function statusCounts(answer: string): [string, number][] {
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

export function writeMarker(token: string): string {
  return `atl nm eval: root blocker acknowledged ${token}`;
}

export function read(id: string, name: string, prompt: string, expectations: Expectation[], excuse?: RegExp): Scenario {
  return { id, name, write: false, prompt: () => prompt, check: (text) => judge(text, expectations, excuse) };
}

/** One answer slot of a strict scenario: the value on its `ANSWER <name>:` line must match `answer` and no decoy. */
export interface Slot {
  /** Slot name as it appears on the line, e.g. "priority" or "open items". */
  name: string;
  /** What the agent should put on the line, shown in the prompt, e.g. "the priority name". */
  hint: string;
  answer: Matcher;
  decoys?: Decoy[];
}

/** Prompt suffix asking for one `ANSWER <slot>: <value>` line per slot. */
export function answerFormat(slots: readonly Slot[]): string {
  const lines = slots.map((slot) => `ANSWER ${slot.name}: <${slot.hint}>`).join("\n");
  return `\n\nEnd your reply with exactly these lines, one value per line:\n${lines}`;
}

/** Value on the last `ANSWER <name>:` line (markdown emphasis and backticks around it are ignored). */
export function slotValue(text: string, name: string): string | undefined {
  const pattern = new RegExp(`^[\\s>*_\`-]*ANSWER\\s+${escapeRegExp(name)}[*_\`]*\\s*:[\\s*_\`]*(.*?)[\\s*_\`.]*$`, "gim");
  const values = [...text.matchAll(pattern)].map((match) => match[1] ?? "");
  return values.at(-1);
}

/**
 * Strict judging: only the `ANSWER` lines count, so explanations may mention every decoy freely, and a line that
 * hedges between the answer and a decoy fails.
 */
export function judgeSlots(raw: string, slots: readonly Slot[]): Check {
  const text = normalise(raw);
  const details: Record<string, boolean> = {};
  const seen: string[] = [];
  for (const slot of slots) {
    const value = slotValue(text, slot.name);
    seen.push(`${slot.name} = ${value === undefined ? "(no ANSWER line)" : JSON.stringify(value)}`);
    details[`ANSWER ${slot.name}`] = value !== undefined && slot.answer(value);
    for (const decoy of slot.decoys ?? []) {
      details[`ANSWER ${slot.name}: not ${decoy.name}`] = value === undefined || !decoy.match(value);
    }
  }
  const check = verdict(details);
  return { success: check.success, details: [...check.details, ...seen] };
}

export function strictRead(id: string, name: string, prompt: string, slots: readonly Slot[]): Scenario {
  return { id, name, write: false, prompt: () => `${prompt}${answerFormat(slots)}`, check: (text) => judgeSlots(text, slots) };
}

// ---------------------------------------------------------------------------
// Write-scenario read-back

/** Parses Jira's "2026-10-23T10:56:09+0200" (no colon in the offset). */
export function jiraTime(at: string): number {
  return Date.parse(at.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/** Run start time encoded by a write token (`Date.now().toString(36)`), minus a little clock slack. */
export function runStart(token: string): number {
  const millis = Number.parseInt(token, 36);
  if (Number.isNaN(millis)) {
    throw new Error(`write scenario token ${token} is not a base-36 timestamp`);
  }
  return millis - 2000;
}

export async function issueStatus(key: string): Promise<string> {
  const parsed: unknown = JSON.parse((await atl("issue", "get", key)).stdout);
  return isRecord(parsed) && typeof parsed.status === "string" ? parsed.status : "?";
}

export interface StatusChange {
  from: string;
  to: string;
}

/** Status changes of `key` made at or after `since` (epoch ms), oldest first. */
export async function statusChangesSince(key: string, since: number): Promise<StatusChange[]> {
  const parsed: unknown = JSON.parse((await atl("issue", "changelog", key, "--all")).stdout);
  const entries = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.at !== "string" || jiraTime(entry.at) < since || !Array.isArray(entry.changes)) {
      return [];
    }
    return entry.changes.flatMap((change) =>
      isRecord(change) && change.field === "status"
        ? [{ from: typeof change.from === "string" ? change.from : "", to: typeof change.to === "string" ? change.to : "" }]
        : [],
    );
  });
}

/**
 * A write scenario's `prepare`: moves `key` back to its seeded `status` before a live run, so the run has to make the
 * transition itself. Checks judge the transition from the changelog since the run started, never from the current
 * status alone.
 */
export async function restoreStatus(key: string, status: string): Promise<void> {
  if ((await issueStatus(key)) !== status) {
    const moved = await atl("issue", "move", key, status);
    if (moved.code !== 0) {
      throw new Error(`could not restore ${key} to ${status}: ${moved.stdout.trim().slice(0, 300)}`);
    }
  }
}
