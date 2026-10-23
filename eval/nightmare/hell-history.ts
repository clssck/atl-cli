/**
 * Hell history scenarios n34-n36 on the data planted by seed-hell-history.ts (eval/.out/nightmare/hell-history.json):
 * an issue whose second move into In Progress hides in ~150 changelog entries, worklogs whose start instants fall on
 * different calendar days in different time zones, and a write that logs work at a Budapest wall-clock time. Prompts
 * are natural (no tool or command names); every expected value comes from the manifest. n34 and n35 are judged on their
 * ANSWER lines only (strictRead).
 *
 * The write check is valid for repeated live runs: the marker carries a per-run token, the review transition and the
 * Done duplicate are judged on status changes made since the run started (the token is the run's start time in base
 * 36), and `prepare` moves the target back to Folyamatban before each run so the run has to transition it itself.
 */
import { isRecord } from "../../src/core/guards.ts";
import { atl } from "../lib.ts";
import { HOST, type Scenario, verdict } from "../scenarios.ts";
import {
  child,
  field,
  jiraTime,
  type Matcher,
  minutesIn,
  numberField,
  readManifest,
  restoreStatus,
  runStart,
  rx,
  statusChangesSince,
  strictRead,
} from "./checks.ts";

const REVIEW = /^(?:Ellenőrzés alatt|In Review)$/i;
const SEEDED_STATUS = "Folyamatban";

/** The issue key as a whole token (NMS-7 is not NMS-70, and "NMS-70-ish" is not NMS-70). */
function keyMatcher(key: string): Matcher {
  return rx(new RegExp(`(?<![\\w-])${key}(?![\\w-])`, "i"));
}

/** The priority name as a word of its own anywhere in the value. */
function priorityMention(name: string): Matcher {
  return rx(new RegExp(`\\b${name}\\b`, "i"));
}

/** Every duration in the value equals `expected` minutes (and there is at least one): "8h 15m", "495 min", "8.25 hours". */
function onlyMinutes(expected: number): Matcher {
  return (text) => {
    const found = minutesIn(text);
    return found.length > 0 && found.every((minutes) => Math.abs(minutes - expected) < 1);
  };
}

export function hellHistoryScenarios(): Scenario[] {
  const manifest = readManifest("hell-history.json");
  const ledger = child(manifest, "changelog");
  const ledgerTarget = field(child(ledger, "target"), "key");
  const ledgerDecoy = field(child(ledger, "decoy"), "key");
  const ledgerAnswer = field(ledger, "answer");
  const priorityDecoys = child(ledger, "decoys");
  const vault = child(manifest, "worklogs");
  const vaultMinutes = child(vault, "minutes");
  const review = child(manifest, "review");
  const reviewKey = field(child(review, "target"), "key");
  const duplicateKey = field(child(review, "duplicate"), "key");
  const reviewStarted = Date.parse(field(review, "started"));
  const reviewSeconds = numberField(review, "seconds");

  const answerMinutes = numberField(vaultMinutes, "answer");
  const minuteDecoys = [
    { name: "parent only, without the sub-task", value: numberField(vaultMinutes, "parentOnly") },
    { name: "the UTC calendar date", value: numberField(vaultMinutes, "utcDate") },
    { name: "the Budapest calendar date", value: numberField(vaultMinutes, "budapestDate") },
    { name: "everything logged", value: numberField(vaultMinutes, "all") },
  ];

  return [
    strictRead(
      "n34-changelog-second-entry",
      "History replay: priority when the issue entered In Progress the second time (150-entry changelog)",
      `On ${HOST}, the NMS issue "${field(child(ledger, "target"), "summary")}" has been moved into In Progress more than once. What was its priority at the moment it entered In Progress for the second time?`,
      [
        {
          name: "issue",
          hint: "the issue key",
          answer: rx(new RegExp(`^(?:https?://\\S*/browse/)?${ledgerTarget}$`, "i")),
          decoys: [{ name: `${ledgerDecoy} (the archived copy)`, match: keyMatcher(ledgerDecoy) }],
        },
        {
          name: "priority",
          hint: "the priority name",
          answer: rx(new RegExp(`^(?:priority\\s*[:=-]?\\s*)?${ledgerAnswer}(?:\\s+priority)?$`, "i")),
          decoys: [
            { name: `${field(priorityDecoys, "nextEntry")} (the change right after that move)`, match: priorityMention(field(priorityDecoys, "nextEntry")) },
            { name: `${field(priorityDecoys, "firstEntry")} (at the first move)`, match: priorityMention(field(priorityDecoys, "firstEntry")) },
            { name: `${field(priorityDecoys, "thirdEntry")} (at the third move)`, match: priorityMention(field(priorityDecoys, "thirdEntry")) },
            { name: `${field(priorityDecoys, "current")} (the current priority)`, match: priorityMention(field(priorityDecoys, "current")) },
          ],
        },
      ],
    ),
    strictRead(
      "n35-dst-worklogs",
      "Worklog instants across DST: work started on 26 Oct 2025 New York time, parent plus sub-task",
      `On ${HOST}, how much work was logged on the KAN issue "${field(child(vault, "parent"), "summary")}" and its sub-tasks for work that started on 26 October 2025, New York local time (America/New_York)? Give hours and minutes.`,
      [
        {
          name: "time logged",
          hint: "hours and minutes",
          answer: onlyMinutes(answerMinutes),
          decoys: minuteDecoys.map((decoy) => ({ name: `${decoy.value} min (${decoy.name})`, match: (text: string) => minutesIn(text).some((minutes) => Math.abs(minutes - decoy.value) < 1) })),
        },
      ],
    ),
    {
      id: "n36-write-review-worklog",
      name: "Write: send to review + worklog at a Budapest wall-clock time, not the Done duplicate",
      write: true,
      pickTarget: () => Date.now().toString(36),
      prepare: () => restoreStatus(reviewKey, SEEDED_STATUS),
      prompt: (_arm, target) =>
        `On ${HOST}, send the KAN chargeback export issue to review, and log 1h 30m of work on it that started on 20 October 2025 at 09:00 Budapest time, with the worklog comment "${reviewMarker(target ?? "?")}". Tell me the issue key.`,
      check: async (text, _arm, target) => {
        if (target === undefined) {
          throw new Error("write scenario needs a run token");
        }
        const marker = reviewMarker(target);
        const since = runStart(target);
        const targetMoves = await statusChangesSince(reviewKey, since);
        const onTarget = await markerWorklogs(reviewKey, marker);
        const onDuplicate = await markerWorklogs(duplicateKey, marker);
        const duplicateMoves = (await statusChangesSince(duplicateKey, since)).length;
        const [logged] = onTarget;
        return {
          ...verdict({
            movedToReviewThisRun: targetMoves.some((change) => REVIEW.test(change.to)),
            oneMarkerWorklog: onTarget.length === 1,
            ninetyMinutes: logged?.seconds === reviewSeconds,
            startedAt0900Budapest: logged?.started === reviewStarted,
            noWorklogOnDuplicate: onDuplicate.length === 0,
            duplicateNotMoved: duplicateMoves === 0,
            namesTarget: keyMatcher(reviewKey)(text),
          }),
          details: [
            `read-back token ${target}: ${reviewKey} status changes since start=${targetMoves.map((change) => `${change.from}->${change.to}`).join(",") || "none"} marker worklogs=${onTarget.length} seconds=${logged?.seconds ?? "?"} started=${logged === undefined ? "?" : new Date(logged.started).toISOString()}; ${duplicateKey} marker worklogs=${onDuplicate.length} status changes since start=${duplicateMoves}`,
          ],
        };
      },
    },
  ];
}

function reviewMarker(token: string): string {
  return `atl smoke nm hell: chargeback export reviewed ${token}`;
}

interface MarkerWorklog {
  started: number;
  seconds: number;
}

/** Worklogs on `key` whose comment contains `marker` (comments are a string or a list of lines). */
async function markerWorklogs(key: string, marker: string): Promise<MarkerWorklog[]> {
  const parsed: unknown = JSON.parse((await atl("issue", "worklogs", key, "--all")).stdout);
  const entries = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.started !== "string") {
      return [];
    }
    const comment = Array.isArray(entry.comment) ? entry.comment.join("\n") : entry.comment;
    if (typeof comment !== "string" || !comment.includes(marker)) {
      return [];
    }
    return [{ started: jiraTime(entry.started), seconds: typeof entry.seconds === "number" ? entry.seconds : -1 }];
  });
}
