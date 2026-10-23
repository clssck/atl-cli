/**
 * Chaos Jira scenarios n22-n25 on the data planted by seed-chaos-jira.ts (eval/.out/nightmare/chaos-jira.json): a
 * moved issue (key changed, old key resolves), an epic whose closed children were not all delivered, a bug that was
 * fixed and then reopened, and an owner/date that changed through a description, a comment and an edited comment.
 * Prompts are natural (no tool or command names); every expected value comes from the manifest.
 */
import { escapeRegExp, HOST, type Scenario } from "../scenarios.ts";
import { child, dateMatcher, field, HEDGE, type Matcher, minutesMatcher, nearMatcher, read, readManifest, rx, SENTENCE } from "./checks.ts";

/** Wording that makes a mention of a closed-but-not-delivered child a contrast ("Guest checkout: Won't Do"). */
const NOT_BUILT =
  /won'?t\s*do|wont\s*do|dropped|abandon|cancel|never\s+built|nothing\s+was\s+built|duplicate|másolat|not\s+(?:built|delivered|shipped|done|implemented|started)|closed\s+without|no\s+work|except|but|only|still|in\s+progress|to\s*do|open|pending|not\s+yet|folyamatban|teendő/i;

/** Wording that makes "fixed" a report of what the history says instead of a claim about the present. */
const HISTORY =
  /reopen|re-open|regress|\bbut\b|however|again|still|then|later|since|yet|comment|history|changelog|claimed|said|says|marked|transition|originally|was\s+(?:fixed|resolved|closed|done|shipped|released|set)|no\s+longer|not\s/i;

/** n23: NOT_BUILT plus wording that reports status counts rather than claiming delivery ("counting by status alone would give 5"). */
const N23_EXCUSE = new RegExp(`${NOT_BUILT.source}|\\bstatus\\b|overstat\\w*|\\bwould\\b|\\bplain\\b|\\bfilter\\b`, NOT_BUILT.flags);

/** Wording that makes the previous owner or date a contrast ("Kovács Anna stays on as reviewer"). */
export const SUPERSEDED =
  /reviewer|legal|former|formerly|previous|moved\s+to|audit|description|obsolete|was\b|no\s+longer|stays|only|instead|handed|replaced|transferred|used\s+to|initially|originally|first|edited|overrid|outdated|stale|not\b|still\s+(?:says|lists|shows|has|names)/i;

export function chaosJiraScenarios(): Scenario[] {
  const manifest = readManifest("chaos-jira.json");
  const moved = child(manifest, "moved");
  const children = child(manifest, "children");

  const oldKey = field(moved, "oldKey");
  const newKey = field(moved, "key");
  const sprintName = field(moved, "sprint");
  const sprintNumber = /(\d+)$/.exec(sprintName)?.[1];
  const totalSeconds = moved.totalSeconds;
  if (sprintNumber === undefined || typeof totalSeconds !== "number") {
    throw new Error("chaos-jira.json moved block is incomplete");
  }
  const bugKey = field(child(manifest, "bug"), "key");

  const childKey = (tag: string): string => field(child(children, tag), "key");
  const delivered = ["saved-cards", "apple-pay", "address-autocomplete"];
  const titles: Record<string, string> = {
    "saved-cards": "saved\\s+cards?",
    "apple-pay": "apple\\s*pay",
    "address-autocomplete": "address\\s+auto-?\\s*(?:complete|suggest)",
    "guest-checkout": "guest\\s+checkout",
    "card-tokenisation": "card\\s+tokeni[sz]ation",
    "three-d-secure": "3-?d\\s*secure|three-?d",
    "confirmation-email": "(?:order\\s+)?confirmation\\s+e-?mail",
  };
  const mention = (tag: string): string => `${titles[tag] ?? ""}|${escapeRegExp(childKey(tag))}`;
  /** Whether `tag` is named in a sentence together with a word that claims it is finished. */
  const claimed = (tag: string): Matcher =>
    rx(new RegExp(`(?:${mention(tag)})[^\\n]{0,80}?(?:deliver|ship|releas|launch|live|complete|\\bdone\\b|finish|kész)|(?:deliver|ship|releas|launch|complete|\\bdone\\b|finish|kész)[^\\n]{0,80}?(?:${mention(tag)})`, "i"));
  const deliveredLabel = "deliver(?:ed|y)?|shipped|released|completed|actually (?:done|built)|built and shipped|finished|live";
  const threeWords = rx(new RegExp(`\\bthree\\b[^\\n]{0,80}(?:${deliveredLabel})|(?:${deliveredLabel})[^\\n]{0,40}\\bthree\\b`, "i"));
  const threeDigit = rx(new RegExp(`(?<![\\d.\\-])3(?!\\d)[^\\n\\d]{0,60}(?:${deliveredLabel})`, "i"));
  const countThree = (text: string): boolean => nearMatcher(deliveredLabel, 3)(text) || threeWords(text) || threeDigit(text);

  const TOTAL = /\b(?:total|in all|altogether|overall|combined|sum)\b/i;

  return [
    read(
      "n22-moved-issue",
      "Moved KAN issue: current key, sprint, total time",
      `On ${HOST}, support has an old bookmark to ${oldKey}, the ticket about the invoice export timing out for accounts with thousands of invoices. What is that ticket called today (its current key), which sprint is it planned for, and how much time has been logged on it in total?`,
      [
        {
          label: `current key ${newKey}`,
          answer: rx(new RegExp(`(?<![\\w-])${escapeRegExp(newKey)}(?!\\d)`)),
        },
        {
          label: sprintName,
          answer: rx(new RegExp(`sprint\\s*${sprintNumber}(?!\\d)`, "i")),
          decoys: [{ name: "Sprint 3 (the active sprint)", match: rx(/sprint\s*3(?!\d)/i) }],
        },
        {
          label: "3h 30m logged in total",
          answer: (text) => minutesMatcher(totalSeconds / 60)(text) || rx(/\b3\s*h(?:ours?)?\s*(?:and\s*)?30\s*m|\b3[.,]5\s*h|\b210\s*min/i)(text),
          // A single worklog listed as part of the breakdown is fine; stating it as the total is the trap.
          decoys: [
            { name: "2h (first worklog only)", match: (text) => minutesMatcher(120)(text) && TOTAL.test(text) },
            { name: "1h 30m (second worklog only)", match: (text) => minutesMatcher(90)(text) && TOTAL.test(text) },
          ],
        },
      ],
      /only|first|second|individual|each|worklog|separate|alone/i,
    ),
    read(
      "n23-epic-delivered",
      "Epic children actually delivered vs closed as Won't Do / duplicate",
      `On ${HOST}, the NMS epic "Checkout v2" has a number of child issues, several of them closed. A stakeholder asks what has actually been delivered from it so far. Which child issues were really delivered, and how many?`,
      [
        ...delivered.map((tag) => ({ label: `delivered ${tag}`, answer: rx(new RegExp(mention(tag), "i")) })),
        { label: "3 delivered", answer: countThree, decoys: [{ name: "5 (everything closed in status Done)", match: nearMatcher(`${deliveredLabel}|done|closed|resolved|kész`, 5) }] },
        ...["guest-checkout", "card-tokenisation", "three-d-secure", "confirmation-email"].map((tag) => ({
          label: `${tag} not claimed as delivered`,
          answer: (text: string): boolean => !text.split(SENTENCE).some((sentence) => claimed(tag)(sentence) && !N23_EXCUSE.test(sentence) && !HEDGE.test(sentence)),
        })),
      ],
      N23_EXCUSE,
    ),
    read(
      "n24-reopened-regression",
      "Bug fixed, shipped, then reopened",
      `On ${HOST}, in the NMS project there is a bug about customers being charged twice when a card payment is retried. Was it fixed and shipped? I want to tell the customer it is resolved.`,
      [
        {
          label: "not resolved: reopened after a regression",
          answer: rx(/re-?opened|regress|back\s+in\s+(?:progress|development)|not\s+(?:yet\s+|fully\s+|currently\s+)?(?:fixed|resolved|shipped|done)|isn'?t\s+(?:fixed|resolved)|still\s+(?:open|broken|happening|in\s+progress|an\s+issue)|^\s*no\b\s*[,.:!—–-]/im),
          decoys: [
            {
              name: "fixed and shipped / resolved",
              // A sentence or table row about another issue (e.g. a related bug that is Done) is no claim about this one.
              match: (text) =>
                rx(/(?:is|was|has\s+been|been|now|it'?s)\s+(?:fixed|resolved|done|shipped|closed)|fixed\s+(?:and|&)\s+(?:shipped|released)|\b(?:resolved|kész)\b|yes[,.!\s]/i)(text) &&
                !new RegExp(`\\b[A-Z][A-Z0-9]+-(?!${escapeRegExp(bugKey.split("-")[1] ?? "")}\\b)\\d+\\b`).test(text),
            },
          ],
        },
        { label: "currently in progress", answer: rx(/in\s+progress|folyamatban|being\s+worked|work\s+(?:has\s+)?resum|back\s+in\s+(?:development|progress)/i) },
      ],
      new RegExp(`${HISTORY.source}|["“]|\\buntil\\b|\\bbefore\\b|\\bonce\\b|partial|came back|went out`, HISTORY.flags),
    ),
    read(
      "n25-contradicting-sources",
      "Owner and go-live: description vs overriding comment vs edit",
      `On ${HOST}, who owns the data-retention sign-off story in the NMS project right now, and what is the go-live date? The ticket has been through some back and forth.`,
      [
        {
          label: "owner Szabó Béla",
          answer: rx(/Szabó\s+Béla|Béla\s+Szabó|Szabo\s+Bela/i),
          decoys: [{ name: "Kovács Anna as the owner", match: rx(/Kovács|Kovacs/i) }],
        },
        {
          label: "go-live 2026-12-18",
          answer: dateMatcher("2026-12-18"),
          decoys: [
            { name: "2026-12-01 from the description", match: dateMatcher("2026-12-01") },
            { name: "2026-12-15 from the unedited comment", match: dateMatcher("2026-12-15") },
          ],
        },
      ],
      SUPERSEDED,
    ),
  ];
}
