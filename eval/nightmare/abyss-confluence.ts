/**
 * Abyss Confluence scenarios n46-n47 on the data planted by seed-abyss-confluence.ts
 * (eval/.out/nightmare/abyss-confluence.json): a register page with 130 child pages (the default children listing
 * returns 25) and a four-hop chain from an incident review through a Jira epic and a web link to a contract table with
 * three decoy amounts. Prompts are natural (no tool or command names); every expected value comes from the manifest.
 * Only the ANSWER lines are judged and every answer matcher judges the whole value.
 */
import { escapeRegExp, HOST, type Scenario } from "../scenarios.ts";
import { asRecords, child, field, type Matcher, numberField, pointsMatcher, readManifest, rx, type Slot, strictRead } from "./checks.ts";

const COUNT_WORDS: Record<number, string> = { 7: "seven", 13: "thirteen", 26: "twenty-six", 33: "thirty-three" };

/** `count` as a digit or a word, optionally followed by merchant wording; the whole value. */
function wholeCount(count: number): Matcher {
  const word = COUNT_WORDS[count];
  const number = word === undefined ? `${count}` : `(?:${count}|${escapeRegExp(word)})`;
  return rx(new RegExp(`^${number}(?:\\s+(?:(?:risk\\s+)?tier[- ]3\\s+)?(?:merchants?|pages?|children))?$`, "i"));
}

function mentionsCount(count: number): Matcher {
  const word = COUNT_WORDS[count];
  return rx(new RegExp(`(?<![\\d.])${count}(?!\\d)${word === undefined ? "" : `|\\b${escapeRegExp(word)}\\b`}`, "i"));
}

/** Merchant `number` as "127", "Merchant 127" or "Merchant 127 – <company> (tier 3)" (site prefix optional); the whole value. */
function wholeMerchant(number: number, company: string): Matcher {
  const name = escapeRegExp(company).replaceAll(" ", "\\s+");
  return rx(new RegExp(`^(?:(?:merchant\\s+)?#?0*${number}|(?:atl\\s+smoke\\s+nm\\s+abyss\\s+)?(?:merchant\\s+)?0*${number}\\s*[–-]\\s*${name}(?:\\s*\\(tier\\s*3\\))?)$`, "i"));
}

function mentionsMerchant(number: number): Matcher {
  return rx(new RegExp(`(?<![\\d.])0*${number}(?!\\d)`));
}

/** `value` EUR as a bare number, "1850", "EUR 1850", "1850 EUR", "€1850", optionally ".00" and "/h" or "per hour". */
function wholeEur(value: number): Matcher {
  return rx(new RegExp(`^(?:EUR\\s*|€\\s*)?${value}(?:\\.00)?\\s*(?:EUR|euros?|€)?(?:\\s*(?:/|per\\s+)\\s*(?:h|hours?|hr))?$`, "i"));
}

export function abyssConfluenceScenarios(): Scenario[] {
  const manifest = readManifest("abyss-confluence.json");
  const space = field(manifest, "space");
  const pages = child(manifest, "pages");
  const answers = child(manifest, "answers");

  const registerPage = child(pages, "register");
  const register = child(answers, "register");
  const tier3 = numberField(register, "tier3");
  const highest = child(register, "highest");
  const highestNumber = numberField(highest, "number");
  const windows = asRecords(register.windows);
  if (windows.length === 0) {
    throw new Error("abyss-confluence.json has no register windows");
  }
  const registerSlots: Slot[] = [
    {
      name: "tier-3 count",
      hint: "number of tier-3 merchants",
      answer: wholeCount(tier3),
      decoys: windows.map((window) => ({
        name: `${numberField(window, "tier3")} (tier 3 among the first ${numberField(window, "limit")} children)`,
        match: mentionsCount(numberField(window, "tier3")),
      })),
    },
    {
      name: "highest tier-3 merchant",
      hint: "the merchant number (or full title) of the tier-3 merchant with the highest number",
      answer: wholeMerchant(highestNumber, field(highest, "company")),
      decoys: windows.map((window) => ({
        name: `${numberField(window, "highest")} (highest tier 3 among the first ${numberField(window, "limit")} children)`,
        match: mentionsMerchant(numberField(window, "highest")),
      })),
    },
  ];

  const reviewPage = child(pages, "review");
  const penalty = child(answers, "penalty");
  const value = numberField(penalty, "value");
  const penaltySlots: Slot[] = [
    {
      name: "penalty EUR",
      hint: "the penalty per hour of outage in EUR, as a number",
      answer: wholeEur(value),
      decoys: [
        { name: `${numberField(penalty, "sibling")} (sibling contract Paynetics)`, match: pointsMatcher(numberField(penalty, "sibling")) },
        { name: `${numberField(penalty, "firstVersion")} (version 1 of the contract)`, match: pointsMatcher(numberField(penalty, "firstVersion")) },
        { name: `${numberField(penalty, "estimate")} (estimate on the review page)`, match: pointsMatcher(numberField(penalty, "estimate")) },
      ],
    },
  ];

  return [
    strictRead(
      "n46-register-children",
      "Register page with 130 child pages: the default children listing holds 25",
      `On ${HOST}, the Confluence page "${field(registerPage, "title")}" (space ${space}) is a register with one child page per merchant; the title of each child carries the merchant's risk tier. How many merchants in the register are risk tier 3, and which tier-3 merchant has the highest merchant number?`,
      registerSlots,
    ),
    strictRead(
      "n47-four-hop-penalty",
      "Review page -> Jira epic -> root-cause child -> web link -> contract (decoy sibling, old version, own estimate)",
      `On ${HOST}, per the vendor contract behind the root cause of incident 4471 (see the Confluence page "${field(reviewPage, "title")}"), what is the penalty per hour of outage?`,
      penaltySlots,
    ),
  ];
}
