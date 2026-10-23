/**
 * Chaos multi scenarios n30-n33 on the data planted by seed-chaos-multi.ts (eval/.out/nightmare/chaos-multi.json):
 * a three-source release date, an aggregation over a page table and JQL counts, and two writes with a decoy target
 * (an archived runbook copy, a [DUPLICATE] issue). Prompts are natural (no tool or command names); every expected
 * value comes from the manifest.
 *
 * The write checks are valid for repeated live runs: markers carry a per-run token, and the target's move to In
 * Progress and the decoy's status are judged only on changes made since the run started (the token is the run's start
 * time in base 36). n33's `prepare` moves the target back to Teendő before each run, so every run has to transition it.
 */
import { atl } from "../lib.ts";
import { HOST, markerCount, type Scenario, verdict } from "../scenarios.ts";
import {
  asRecords,
  child,
  countMatcher,
  dateMatcher,
  field,
  type Matcher,
  numberField,
  read,
  readManifest,
  restoreStatus,
  runStart,
  rx,
  statusChangesSince,
} from "./checks.ts";

const IN_PROGRESS = /^(?:Folyamatban|In Progress)$/i;
/** Seeded status of the Apple Pay follow-up; n33's `prepare` moves it back here before every live run. */
const APPLE_SEEDED_STATUS = "Teendő";

/** Wording that makes a decoy date a contrast ("Jira shows 2027-03-01, but the calendar says ..."). */
const DATE_CONTRAST = /placeholder|jira|promis|pilot|\bcab\b|freeze|approval|planned|originally|committed|calendar|version date|told/i;

/** Wording that makes a runner-up owner a contrast ("Péter Vass has the next most"). */
const OWNER_CONTRAST = /fewer|less|behind|runner|second|ahead|than|only|but|next|total|including|done|single|largest|biggest|team/i;

function strip(text: string): string {
  return text.normalize("NFD").replaceAll(/\p{M}/gu, "");
}

/** "Dóra Lengyel" in either order, with or without accents. */
function personMatcher(name: string): Matcher {
  const [given, family] = strip(name).split(" ");
  if (given === undefined || family === undefined) {
    throw new Error(`chaos-multi.json owner ${name} is not "Given Family"`);
  }
  const pattern = new RegExp(`${given}\\s+${family}|${family}\\s+${given}`, "i");
  return (text) => pattern.test(strip(text));
}

/** Wording that makes the runner-up owner the answer rather than a mention. */
const SUPERLATIVE = /\b(?:most|highest|largest|biggest|top|winner|responsible|owns)\b/i;

export function chaosMultiScenarios(): Scenario[] {
  const manifest = readManifest("chaos-multi.json");
  const pages = child(manifest, "pages");
  const release = child(manifest, "release");
  const oncall = child(manifest, "oncall");
  const apple = child(manifest, "apple");
  const runbooks = child(manifest, "runbooks");

  const postmortem = child(pages, "postmortem");
  const calendar = child(pages, "calendar");
  const ownersPage = child(pages, "oncall");
  const runbook = child(pages, "runbook");
  const runbookOld = child(pages, "runbookOld");

  const releaseDate = field(release, "date");
  const decoyDates = [
    { name: `${field(release, "promisedDate")} (the 1.1 promise)`, date: field(release, "promisedDate") },
    { name: `${field(release, "pilotDate")} (the older linked pilot issue, version 1.0)`, date: field(release, "pilotDate") },
    { name: `${field(release, "jiraPlaceholderDate")} (placeholder date of the Jira version)`, date: field(release, "jiraPlaceholderDate") },
    { name: `${field(release, "cab")} (CAB date)`, date: field(release, "cab") },
  ];

  const winner = field(oncall, "winner");
  const winnerOpen = numberField(oncall, "winnerOpen");
  const winnerMatches = personMatcher(winner);
  const decoyOwners = asRecords(oncall.owners)
    .map((owner) => field(owner, "name"))
    .filter((name) => name !== winner);
  const winnerCount = (text: string): boolean =>
    countMatcher("open|issues?|tickets?", winnerOpen)(text) ||
    rx(new RegExp(`${strip(winner).split(" ").join("[^\\n\\d]{0,40}")}[^\\n\\d]{0,40}(?<![\\d.\\-])${winnerOpen}(?!\\d)`, "i"))(strip(text));

  const wikiSpace = field(postmortem, "space");
  const runbookId = field(runbook, "id");
  const runbookOldId = field(runbookOld, "id");
  const otherRunbooks = [field(runbooks, "onCall"), field(runbooks, "onCallArchive")];

  const appleKey = field(apple, "key");
  const duplicateKey = field(apple, "duplicate");
  const existingChild = field(apple, "existingChild");

  return [
    read(
      "n30-multi-hop-release",
      "Three hops: postmortem -> bug -> fix issue version -> calendar date",
      `On ${HOST}, the postmortem page "${field(postmortem, "title")}" in space ${wikiSpace} names the bug behind the October settlement-file incident. A customer asks on which date the fix for that bug ships. Use the release calendar in the Corp Handbook space (${field(calendar, "space")}) for the date.`,
      [
        {
          label: `release date ${releaseDate}`,
          answer: dateMatcher(releaseDate),
          decoys: decoyDates.map((decoy) => ({ name: decoy.name, match: dateMatcher(decoy.date) })),
        },
      ],
      new RegExp(`${DATE_CONTRAST.source}|promise|\\b1\\.1\\b`, DATE_CONTRAST.flags),
    ),
    read(
      "n31-multi-oncall-open-issues",
      "Aggregation: on-call owner table x open NMS issues per team label",
      `On ${HOST}, the Confluence page "${field(ownersPage, "title")}" in space ${wikiSpace} lists the on-call owner of each team and the Jira label that team's issues carry. Which on-call owner is responsible for the most open issues in the NMS project across all the teams they cover, and how many open issues is that?`,
      [
        {
          label: `owner ${winner}`,
          answer: winnerMatches,
          decoys: decoyOwners.map((name) => ({
            name: `${name} as the owner with the most`,
            match: (text) => personMatcher(name)(text) && SUPERLATIVE.test(text),
          })),
        },
        { label: `${winnerOpen} open issues`, answer: winnerCount },
      ],
      OWNER_CONTRAST,
    ),
    {
      id: "n32-write-runbook-comment",
      name: "Write: comment on the current runbook, not the archived copy",
      write: true,
      pickTarget: () => Date.now().toString(36),
      prompt: (_arm, target) =>
        `On ${HOST}, in the Confluence space ${wikiSpace}, add the comment "${runbookMarker(target ?? "?")}" to the payments refund runbook. Tell me the title and id of the page you commented on.`,
      check: async (text, _arm, target) => {
        if (target === undefined) {
          throw new Error("write scenario needs a run token");
        }
        const marker = runbookMarker(target);
        const onCurrent = await commentCount(runbookId, marker);
        const onOld = await commentCount(runbookOldId, marker);
        const onOthers = await Promise.all(otherRunbooks.map((id) => commentCount(id, marker)));
        return {
          ...verdict({
            commentOnCurrent: onCurrent === 1,
            notOnOldCopy: onOld === 0,
            notOnOnCallRunbooks: onOthers.every((count) => count === 0),
            namesCurrentPage: new RegExp(`(?<!\\d)${runbookId}(?!\\d)`).test(text),
          }),
          details: [`read-back token ${target}: current ${runbookId}=${onCurrent} old ${runbookOldId}=${onOld} other runbooks=${onOthers.join(",")}`],
        };
      },
    },
    {
      id: "n33-write-apple-pay-followup",
      name: "Write: move + comment on the Apple Pay follow-up, not its [DUPLICATE]",
      write: true,
      pickTarget: () => Date.now().toString(36),
      prepare: () => restoreStatus(appleKey, APPLE_SEEDED_STATUS),
      prompt: (_arm, target) =>
        `On ${HOST}, in the NMS project, start work on the Apple Pay follow-up: move it to "In Progress" and add the comment "${appleMarker(target ?? "?")}". Tell me which issue you updated.`,
      check: async (text, _arm, target) => {
        if (target === undefined) {
          throw new Error("write scenario needs a run token");
        }
        const marker = appleMarker(target);
        const since = runStart(target);
        const targetMoves = await statusChangesSince(appleKey, since);
        const onTarget = await issueMarkers(appleKey, marker);
        const onDuplicate = await issueMarkers(duplicateKey, marker);
        const onChild = await issueMarkers(existingChild, marker);
        const duplicateMoves = (await statusChangesSince(duplicateKey, since)).length;
        return {
          ...verdict({
            targetMovedToInProgressThisRun: targetMoves.some((change) => IN_PROGRESS.test(change.to)),
            commentOnTarget: onTarget === 1,
            noCommentOnDuplicate: onDuplicate === 0,
            duplicateNotMoved: duplicateMoves === 0,
            noCommentOnDoneChild: onChild === 0,
            namesTarget: new RegExp(`(?<![\\w-])${appleKey}(?!\\d)`).test(text),
          }),
          details: [
            `read-back token ${target}: ${appleKey} status changes since start=${targetMoves.map((change) => `${change.from}->${change.to}`).join(",") || "none"} comments=${onTarget}; ${duplicateKey} comments=${onDuplicate} status changes since start=${duplicateMoves}; ${existingChild} comments=${onChild}`,
          ],
        };
      },
    },
  ];
}

function runbookMarker(token: string): string {
  return `atl smoke nm chaos multi: refund runbook reviewed ${token}`;
}

function appleMarker(token: string): string {
  return `atl smoke nm chaos multi: certificate renewal confirmed ${token}`;
}

/** Footer and inline comments on a page whose body contains `marker`. */
async function commentCount(pageId: string, marker: string): Promise<number> {
  return markerCount((await atl("comment", "list", pageId, "--kind", "all", "--all")).stdout, marker);
}

async function issueMarkers(key: string, marker: string): Promise<number> {
  return markerCount((await atl("issue", "comments", key, "--all")).stdout, marker);
}

