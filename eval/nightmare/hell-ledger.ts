/**
 * Hell scenarios n37, n38 and n42 on the KAN data planted by seed-hell-ledger.ts (eval/.out/nightmare/hell-ledger.json):
 * a ledger sum over more than one result page with corrected and pending amounts, the direction of Duplicate links
 * against stale descriptions, and a date that lives only in an ADF date node inside an expand. Prompts are natural (no
 * tool or command names); every expected value comes from the manifest. Only the ANSWER lines are judged.
 */
import { HOST, type Scenario } from "../scenarios.ts";
import { asRecords, child, dateMatcher, field, type Matcher, numberField, readManifest, rx, type Slot, strictRead } from "./checks.ts";

const COUNT = /^\s*(\d+)(?:\s*(?:issues?|tickets?|items?))?\s*$/i;
const EUR = /^\s*(?:(?:EUR|€)\s*)?(\d+)(?:\.00?)?\s*(?:EUR|euros?|€)?\s*$/i;
const TODO_VALUE = /^(?:Teendő|To[ -]?Do)(?:\s*\((?:Teendő|To[ -]?Do)\))?$/iu;

/** Value that is exactly one integer (optionally followed by a unit word); "112 or 122" has none. */
function parsed(pattern: RegExp, value: string): number | undefined {
  const digits = pattern.exec(value)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

function countIs(expected: number): Matcher {
  return (value) => parsed(COUNT, value) === expected;
}

function eurIs(expected: number): Matcher {
  return (value) => parsed(EUR, value) === expected;
}

/** The key as a whole token: not part of a longer number or a longer project key. */
function keyMatcher(key: string): Matcher {
  return rx(new RegExp(`(?<![A-Za-z\\d-])${key}(?!\\d)`));
}

function wordMatcher(pattern: string): Matcher {
  return rx(new RegExp(`(?<![\\p{L}])(?:${pattern})(?![\\p{L}])`, "iu"));
}

export function hellLedgerScenarios(): Scenario[] {
  const manifest = readManifest("hell-ledger.json");
  const ledger = child(manifest, "ledger");
  const duplicates = child(manifest, "duplicates");
  const goLive = child(manifest, "goLive");

  const count = numberField(ledger, "count");
  const sum = numberField(ledger, "sum");
  const label = field(ledger, "label");
  const countDecoys = asRecords(ledger.countDecoys).map((decoy) => ({ name: `${numberField(decoy, "value")} (${field(decoy, "name")})`, match: countIs(numberField(decoy, "value")) }));
  const sumDecoys = asRecords(ledger.sumDecoys).map((decoy) => ({ name: `${numberField(decoy, "value")} (${field(decoy, "name")})`, match: eurIs(numberField(decoy, "value")) }));

  const surviving = child(duplicates, "surviving");
  const survivingKey = field(surviving, "key");
  const survivingStatus = field(surviving, "status");
  if (survivingStatus !== "Teendő") {
    throw new Error(`hell-ledger.json: the surviving duplicate target is ${survivingStatus}, the matchers expect Teendő`);
  }
  const otherKeys = asRecords(duplicates.others).map((other) => field(other, "key"));

  const goLiveDate = field(goLive, "date");
  const decoyDates = asRecords(goLive.decoyDates).map((decoy) => ({ name: `${field(decoy, "date")} (${field(decoy, "name")})`, match: dateMatcher(field(decoy, "date")) }));

  const ledgerSlots: Slot[] = [
    { name: "count", hint: "number of issues", answer: countIs(count), decoys: countDecoys },
    { name: "sum EUR", hint: "sum of the current amounts in EUR, digits only", answer: eurIs(sum), decoys: sumDecoys },
  ];
  const duplicateSlots: Slot[] = [
    {
      name: "issue",
      hint: "issue key",
      answer: keyMatcher(survivingKey),
      decoys: otherKeys.map((key) => ({ name: `${key} (a duplicate or the related issue)`, match: keyMatcher(key) })),
    },
    {
      name: "status",
      hint: "status name",
      answer: rx(TODO_VALUE),
      decoys: [
        { name: "Kész / Done (status of the duplicates)", match: wordMatcher("Kész|Done") },
        { name: "Folyamatban / In Progress (status of the related issue)", match: wordMatcher("Folyamatban|In[ -]Progress") },
      ],
    },
  ];
  const goLiveSlots: Slot[] = [{ name: "go-live date", hint: "date as YYYY-MM-DD", answer: dateMatcher(goLiveDate), decoys: decoyDates }];

  return [
    strictRead(
      "n37-ledger-sum",
      "Ledger sum over more than one page: corrected and pending amounts, boundary dates, look-alike label",
      `On ${HOST}, KAN issues labelled ${label} each carry an amount in their description. How many of them are not done and are due in November 2026, and what is the sum of their current amounts in EUR?`,
      ledgerSlots,
    ),
    strictRead(
      "n38-duplicate-direction",
      "Duplicate links: the surviving issue and its status, against stale descriptions",
      `On ${HOST}, several KAN issues whose summaries start with "atl smoke nm hell Card token rotation" were closed as duplicates of one surviving issue. Which issue is the one the others duplicate, and what is its current status?`,
      duplicateSlots,
    ),
    strictRead(
      "n42-adf-date-reschedule",
      "ADF description: the rescheduled date sits in an expand, the visible date is superseded",
      `On ${HOST}, what is the current go-live date of the KAN issue "${field(goLive, "summary")}"?`,
      goLiveSlots,
    ),
  ];
}
