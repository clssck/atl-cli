/**
 * Abyss Jira scenarios n43-n45 on the data planted by seed-abyss-jira.ts (eval/.out/nightmare/abyss-jira.json): data
 * that the default first page or the issue-embedded field silently leaves out. n43 hides the final decision in the
 * last of 240 comments, n44 sums worklogs of which the issue embeds only 20, n45 comments on 27 issues where the
 * default search page holds 25. Prompts are natural (no tool or command names); every expected value comes from the
 * manifest. n43 and n44 are judged on their ANSWER lines only (strictRead).
 *
 * The write check is valid for repeated live runs: the marker carries a per-run token, so only this run's comments
 * count. It reads all 38 seeded issues back with one atl call.
 */
import { isRecord } from "../../src/core/guards.ts";
import { atl } from "../lib.ts";
import { HOST, type Scenario, verdict } from "../scenarios.ts";
import { asRecords, child, field, type Matcher, minutesIn, numberField, pointsMatcher, readManifest, rx, strictRead } from "./checks.ts";

/** Every duration in the value equals `expected` minutes (and there is at least one): "39h 55m", "2395 min". */
function onlyMinutes(expected: number): Matcher {
  return (text) => {
    const found = minutesIn(text);
    return found.length > 0 && found.every((minutes) => Math.abs(minutes - expected) < 1);
  };
}

/** The option as the whole value ("D", "Option D", "Option D (shadow settlement ...)"); the letter is upper case. */
function optionAnswer(letter: string): Matcher {
  return rx(new RegExp(`^(?:[Oo]ption\\s+)?${letter}(?:\\s*[(:,—–-].*)?$`));
}

/** The option named anywhere in the value, or the bare letter as the whole value. */
function optionMention(letter: string): Matcher {
  return rx(new RegExp(`\\boption\\s+${letter}\\b|^${letter}$`, "i"));
}

/** Concatenated text of an ADF node (comment bodies come back as ADF documents). */
function adfText(node: unknown): string {
  if (!isRecord(node)) {
    return "";
  }
  const own = typeof node.text === "string" ? node.text : "";
  return own + (Array.isArray(node.content) ? node.content.map(adfText).join("") : "");
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body : adfText(body);
}

export function abyssJiraScenarios(): Scenario[] {
  const manifest = readManifest("abyss-jira.json");
  const thread = child(manifest, "comments");
  const cutover = child(thread, "issue");
  const answerLetter = field(thread, "answer").replace(/^Option /, "");
  const optionNotes = new Map<string, number>();
  for (const decision of asRecords(thread.decisions)) {
    const letter = field(decision, "option");
    if (letter !== answerLetter && !optionNotes.has(letter)) {
      optionNotes.set(letter, numberField(decision, "note"));
    }
  }

  const effort = child(manifest, "worklogs");
  const effortMinutes = child(effort, "minutes");
  const answerMinutes = numberField(effortMinutes, "answer");
  const minuteDecoys = [
    { name: "only the 20 worklogs the issue itself lists", value: numberField(effortMinutes, "embedded20") },
    { name: "the UTC calendar month", value: numberField(effortMinutes, "utcMonth") },
    { name: "everything ever logged", value: numberField(effortMinutes, "all") },
    { name: "a fixed +02:00 offset (no DST switch)", value: numberField(effortMinutes, "fixedCest") },
    { name: "a fixed +01:00 offset (no DST switch)", value: numberField(effortMinutes, "fixedCet") },
  ];

  const rollout = child(manifest, "rollout");
  const label = field(rollout, "label");
  const targetKeys = asRecords(rollout.targets).map((target) => field(target, "key"));
  const decoyKeys = [...asRecords(rollout.done), ...asRecords(rollout.old)].map((issue) => field(issue, "key"));

  return [
    strictRead(
      "n43-comment-latest-decision",
      "Comment thread: the final decision is in the last of 240 comments, the first page says otherwise",
      `On ${HOST}, what did the team finally decide for the settlement cutover? The discussion is in the comments of the KAN issue "${field(cutover, "summary")}".`,
      [
        {
          name: "decision",
          hint: "the option that was finally decided",
          answer: optionAnswer(answerLetter),
          decoys: [...optionNotes].map(([letter, note]) => ({ name: `Option ${letter} (decided in comment ${note})`, match: optionMention(letter) })),
        },
      ],
    ),
    strictRead(
      "n44-worklog-october",
      "Worklog beyond the 20 embedded in the issue: work started in October 2025, Budapest time",
      `On ${HOST}, how much time was logged on the KAN issue "${field(child(effort, "issue"), "summary")}" for work that started in October 2025, in Budapest local time (Europe/Budapest)? Give hours and minutes.`,
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
      id: "n45-write-bulk-comment",
      name: `Write: comment on all ${targetKeys.length} open issues labelled ${label} (more than the 25-issue default page), not the Done or old-plan ones`,
      write: true,
      pickTarget: () => Date.now().toString(36),
      prompt: (_arm, target) =>
        `On ${HOST}, add the comment "${rolloutMarker(target ?? "?")}" to every open KAN issue labelled ${label}. Tell me how many issues you commented on.`,
      check: async (text, _arm, target) => {
        if (target === undefined) {
          throw new Error("write scenario needs a run token");
        }
        const marker = rolloutMarker(target);
        const counts = await markerCounts([...targetKeys, ...decoyKeys], marker);
        const missing = targetKeys.filter((key) => counts.get(key) !== 1);
        const stray = decoyKeys.filter((key) => counts.get(key) !== 0);
        return {
          ...verdict({
            everyOpenTargetHasOneMarkerComment: missing.length === 0,
            noMarkerOnDoneOrOldPlanIssues: stray.length === 0,
            statesCount: pointsMatcher(targetKeys.length)(text),
          }),
          details: [
            `read-back token ${target}: ${targetKeys.length - missing.length}/${targetKeys.length} targets with exactly one marker comment (not exactly one: ${missing.join(",") || "none"}); decoys with a marker: ${stray.join(",") || "none"}`,
          ],
        };
      },
    },
  ];
}

function rolloutMarker(token: string): string {
  return `atl smoke nm abyss: rollout confirmed ${token}`;
}

/**
 * Marker comments per issue, from one search over `keys` that embeds the comment field. An issue whose embedded
 * comments are fewer than its total (a capped embed) is read in full with `issue comments` instead.
 */
async function markerCounts(keys: readonly string[], marker: string): Promise<Map<string, number>> {
  const search = await atl("jql", `key in (${keys.join(",")})`, "--all", "--issue-fields", "comment");
  if (search.code !== 0) {
    throw new Error(`read-back search failed: ${search.stdout.trim().slice(0, 300)}`);
  }
  const parsed: unknown = JSON.parse(search.stdout);
  const issues = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.key !== "string") {
      continue;
    }
    const embedded = isRecord(issue.comment) ? issue.comment : {};
    const shown = Array.isArray(embedded.comments) ? embedded.comments : [];
    let bodies = shown.map((comment) => bodyText(isRecord(comment) ? comment.body : undefined));
    if (typeof embedded.total === "number" && embedded.total > shown.length) {
      const full = await atl("issue", "comments", issue.key, "--all");
      const list: unknown = JSON.parse(full.stdout);
      const entries = isRecord(list) && Array.isArray(list.items) ? list.items : [];
      bodies = entries.map((entry) => (isRecord(entry) && Array.isArray(entry.body) ? entry.body.join("\n") : bodyText(isRecord(entry) ? entry.body : undefined)));
    }
    counts.set(issue.key, bodies.filter((body) => body.includes(marker)).length);
  }
  return counts;
}
