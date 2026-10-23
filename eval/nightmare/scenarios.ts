/**
 * Macro-eval scenarios on the corporate-nightmare dataset (eval/nightmare/seed-*.ts). Prompts are
 * natural-language (no tool or command names; the site host appears once); every expected value is
 * derived from the `facts` of eval/.out/nightmare/{jira,confluence}.json (n01-n15), the verified values of
 * scrum.json (n16-n21) and chaos-{jira,confluence,multi}.json (n22-n33, eval/nightmare/chaos-*.ts) at load time. Checks
 * normalise formatting (thousand separators, decimal commas, date styles, duration units) and
 * reject the planted decoys: a decoy value stated without the answer next to it and without a
 * hedge ("earlier", "not", "comment 4 says", ...) fails.
 */
import { isRecord } from "../../src/core/guards.ts";
import { atl } from "../lib.ts";
import { escapeRegExp, HOST, markerCount, type Scenario, verdict } from "../scenarios.ts";
import {
  asRecords,
  BACKLOG_LABEL,
  bodyValues,
  capture,
  captureAll,
  child,
  dateMatcher,
  daysMatcher,
  eurMatcher,
  factOf,
  field,
  list,
  minutesMatcher,
  nearMatcher,
  normalise,
  NUMBER_WORDS,
  numberField,
  numberMatcher,
  POINTS_LABEL,
  pointsMatcher,
  read,
  readFacts,
  readManifest,
  roleDayMatcher,
  rx,
  sprintMatcher,
  statusCount,
  statusCounts,
  writeMarker,
} from "./checks.ts";
import { abyssConfluenceScenarios } from "./abyss-confluence.ts";
import { abyssJiraScenarios } from "./abyss-jira.ts";
import { chaosConfluenceScenarios } from "./chaos-confluence.ts";
import { chaosMultiScenarios } from "./chaos-multi.ts";
import { chaosJiraScenarios } from "./chaos-jira.ts";
import { hellConfluenceScenarios } from "./hell-confluence.ts";
import { hellHistoryScenarios } from "./hell-history.ts";
import { hellLedgerScenarios } from "./hell-ledger.ts";

/** n09: the page body's own statement is a contrast to the inline-comment fact ("the body says Monday"). */
const N09_EXCUSE = /\b(?:body|text|page says|says)\b/i;

/** n11: a decoy extension quoted while describing one of the other near-duplicate pages (list lines name its parent or space; a table row lists one lookalike). */
export const N11_EXCUSE =
  /\b(?:security|finance|pénzügy|hr|systems|ir runbooks|other|others|elsewhere|from|updated|second|another|engineering|mérnökség)\b|\bno\s+`?nm-owner|^\s*\|/i;

/** n13: the old parent named as history ("created under HR"). */
const N13_EXCUSE = /\b(?:created|used to|was|moved|from|hr)\b/i;

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
      /withdr[ae]w|withdrawn|\b(?:first|correction|corrected|quote)\b/i,
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
      /\b(?:done|kész|closed|completed|finished|retired|cut over|postgres 15|took place|happened|went live|was)\b/i,
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
      /\b(?:from|to|→|->|raised|increased|reduced|reverted|revert|changed|current|currently|now|today|later|cop(?:y|ies))\b|→|->/i,
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
      N09_EXCUSE,
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
      N11_EXCUSE,
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
      N13_EXCUSE,
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
      /\b(?:total|scope|committed|overall|planned|legacy|field|sum|would)\b/i,
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
          answer: nearMatcher(POINTS_LABEL, carriedPoints),
          decoys: [{ name: `${carriedLegacy} points`, match: nearMatcher(POINTS_LABEL, carriedLegacy) }],
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
            nearMatcher(BACKLOG_LABEL, backlogKeys.length)(text) ||
            rx(new RegExp(`\\b${NUMBER_WORDS[backlogKeys.length] ?? "-"}\\b`, "i"))(text) ||
            rx(new RegExp(`(?<![\\d.\\-])${backlogKeys.length} of (?:the |all )?\\d+\\b`, "i"))(text),
          decoys: [backlogWithDuplicates, backlogWithEpics].map((value) => ({ name: `${value} issues`, match: nearMatcher(BACKLOG_LABEL, value) })),
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
      /\b(?:duplicate|duplicates|dupe|twin|twins|exclud\w*|epics?|including|holds|in total|left out|leaving|skipped|drop(?:ped)?|point(?:s|ing)?\s+to|linked)\b|\bbacklog\s+(?:has|holds|contains)\b/i,
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
    ...chaosJiraScenarios(),
    ...chaosConfluenceScenarios(),
    ...chaosMultiScenarios(),
    ...hellHistoryScenarios(),
    ...hellLedgerScenarios(),
    ...hellConfluenceScenarios(),
    ...abyssJiraScenarios(),
    ...abyssConfluenceScenarios(),
  ];
}
