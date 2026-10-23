/**
 * Confluence "chaos" scenarios n26-n29 (eval/nightmare/seed-chaos-confluence.ts). The pages hide their answer behind
 * macros and history that the default markdown rendering of `atl page get` drops or only marks with a comment: an
 * excerpt-include, an expand macro next to a deprecated section, a page renamed three times, and a Jira issues
 * macro next to a stale hand-written count. Expected values come from the `facts` of
 * eval/.out/nightmare/chaos-confluence.json; a decoy stated without the answer in the same sentence and without a
 * hedge fails.
 */
import { isRecord } from "../../src/core/guards.ts";
import { escapeRegExp, HOST, type Scenario } from "../scenarios.ts";
import { capture, factOf, field, type Matcher, minutesMatcher, nearMatcher, NUMBER_WORDS, read, readFacts, readManifest, rx } from "./checks.ts";

function pageTitle(pages: unknown, key: string): string {
  if (!isRecord(pages)) {
    throw new Error("chaos-confluence.json has no pages object");
  }
  const entry = pages[key];
  if (!isRecord(entry)) {
    throw new Error(`chaos-confluence.json has no page ${key}`);
  }
  return field(entry, "title");
}

function fold(text: string): string {
  return text.normalize("NFD").replaceAll(/\p{M}/gu, "");
}

/** `phrase` as whole words, ignoring case, accents and the amount of whitespace. */
function phraseMatcher(phrase: string): Matcher {
  const pattern = new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(fold(phrase)).replaceAll(/\s+/g, "\\s+")}(?![\\p{L}\\d])`, "iu");
  return (text) => pattern.test(fold(text));
}

/** A shell command ("cachectl drain") with any amount of whitespace between its words. */
function commandMatcher(command: string): Matcher {
  return rx(new RegExp(`${escapeRegExp(command).replaceAll(/\s+/g, "\\s+")}(?![\\w-])`, "i"));
}

/** The phone number ending in `tail` ("+36 1 555 0188"), however it is spaced or dotted. */
function bridgeMatcher(tail: string): Matcher {
  return rx(new RegExp(`555[\\s.\\-]?${tail}(?!\\d)`));
}

/** n29: the stale hand-written count or a total quoted as the page's claim, not as the answer. */
export const N29_EXCUSE = /hand-?(?:written|counted)|manual|page says|page states|claims?|in total|altogether/i;

export function chaosConfluenceScenarios(): Scenario[] {
  const manifest = readManifest("chaos-confluence.json");
  const facts = readFacts(manifest);
  const title = (key: string): string => pageTitle(manifest.pages, key);

  // n26: the card only embeds the "escalation" excerpt of the runbook; summary excerpt, legacy text and archive page are noise.
  const include = factOf(facts, "excerpt-include");
  const escalationMinutes = Number(capture(include.answer, /^(\d+) minutes/));
  const secondary = capture(include.answer, /; (.+)$/);
  const archiveMinutes = Number(capture(include.whyHard, /legacy (\d+) minutes/));
  const archiveSecondary = capture(include.whyHard, /minutes, ([^)]+)\)/);

  // n27: the command in force is inside the expand macro; the visible step 3 sits under the DEPRECATED lozenge.
  const expand = factOf(facts, "expand-status");
  const command = capture(expand.answer, /^(cachectl \w+)/);
  const grace = capture(expand.answer, /grace (\d+)s/);
  const deprecatedCommand = capture(expand.whyHard, /lozenge is "(cachectl \w+)/);
  const forbiddenCommand = capture(expand.whyHard, /warns off "(cachectl \w+)"/);

  // n28: renamed three times; the prompt uses the first title, the bridge number changed with every version.
  const renamed = factOf(facts, "renamed-page");
  const bridge = capture(renamed.answer, /^\+36 1 555 (\d{4})/);
  const currentName = capture(renamed.answer, /; (.+)$/);
  const firstTitle = capture(renamed.question, /"([^"]+)"/);
  const staleBridges = [...new Set([...renamed.whyHard.matchAll(/\+36 1 555 (\d{4})/g)].map((match) => match[1] ?? ""))].filter((tail) => tail !== "" && tail !== bridge);
  if (staleBridges.length < 3) {
    throw new Error("renamed-page fact lists fewer than three superseded bridge numbers");
  }

  // n29: live count from the Jira macro's JQL versus the hand-written counts on the page.
  const jira = factOf(facts, "jira-macro");
  const openCount = Number(capture(jira.answer, /^(\d+)/));
  const staleCount = Number(capture(jira.whyHard, /"(\d+) blockers"/));
  const earlierCount = Number(capture(jira.whyHard, /\((\d+) earlier\)/));
  const allCount = Number(capture(jira.whyHard, /; (\d+) issues carry/));
  const openLabel = "open|blockers?|blocking|unresolved|remaining|outstanding|not done";

  return [
    read(
      "n26-excerpt-include",
      "Card page that only embeds another page's excerpt",
      `On ${HOST}, the wiki page "${title("card")}" in space SZOFTVERFE is the Payments on-call card. After how many minutes without an acknowledgement is the secondary on-call paged, and who is the secondary?`,
      [
        {
          label: `${escalationMinutes} minutes`,
          answer: minutesMatcher(escalationMinutes),
          decoys: [{ name: `${archiveMinutes} minutes (legacy/archive)`, match: minutesMatcher(archiveMinutes) }],
        },
        {
          label: `secondary ${secondary}`,
          answer: phraseMatcher(secondary),
          decoys: [{ name: `secondary ${archiveSecondary}`, match: phraseMatcher(archiveSecondary) }],
        },
      ],
      /archive|legacy|2025|summary excerpt|until|used to|\bwas\b|before|lengthened/i,
    ),
    read(
      "n27-expand-deprecated",
      "Step in force hidden in an expand, deprecated step visible",
      `On ${HOST}, the wiki page "${title("cache")}" in space SZOFTVERFE describes how to flush the EU cache cluster. Which command do I run in step 3 of the procedure that is in force today, and what grace period does it use?`,
      [
        {
          label: command,
          answer: commandMatcher(command),
          decoys: [
            { name: deprecatedCommand, match: commandMatcher(deprecatedCommand) },
            { name: forbiddenCommand, match: commandMatcher(forbiddenCommand) },
          ],
        },
        { label: `grace ${grace}s`, answer: rx(new RegExp(`(?<![\\d.])${grace}\\s*(?:s|secs?|seconds)(?![\\p{L}])`, "iu")) },
      ],
      /deprecated|obsolete|legacy|do not|don't|avoid|warn|forbidden|called out|never/i,
    ),
    read(
      "n28-renamed-page",
      "Page renamed three times, asked by its first title",
      `On ${HOST}, a colleague keeps referring to the wiki page "${firstTitle}" in space SZOFTVERFE. What is the Tier-2 incident bridge number on that page today, and what is the page called now?`,
      [
        {
          label: `bridge ...${bridge}`,
          answer: bridgeMatcher(bridge),
          decoys: staleBridges.map((tail) => ({ name: `bridge ...${tail}`, match: bridgeMatcher(tail) })),
        },
        { label: `current title ${currentName}`, answer: phraseMatcher(currentName) },
      ],
      /\bwas\b|used to|history|versions?|copy|copied|handbook/i,
    ),
    read(
      "n29-jira-macro-live-count",
      "Blockers live in a Jira macro; page count is stale",
      `On ${HOST}, the wiki page "${title("readiness")}" in space SZOFTVERFE tracks what still stands in the way of the NMS 1.1 release. How many issues are open for 1.1 right now?`,
      [
        {
          label: `${openCount} open`,
          answer: rx(new RegExp(`(?<![\\d.\\-])${openCount}(?!\\d)|\\b${NUMBER_WORDS[openCount] ?? "(?!)"}\\b`, "i")),
          decoys: [
            { name: `${staleCount} (hand-written count)`, match: nearMatcher(openLabel, staleCount) },
            { name: `${earlierCount} (earlier count)`, match: nearMatcher(openLabel, earlierCount) },
            { name: `${allCount} (all issues of 1.1)`, match: nearMatcher(openLabel, allCount) },
          ],
        },
      ],
      N29_EXCUSE,
    ),
  ];
}
