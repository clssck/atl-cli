/**
 * Macro-eval scenarios: natural-language prompts (no tool or command names; the site host appears
 * once) with answer checks derived from eval/.out/manifest.json.
 */
import { isRecord } from "../src/core/guards.ts";
import { atl, needle, type Manifest } from "./lib.ts";

/** `atl-pre` is the atl arm with the skill text preloaded into the system prompt instead of a skill file. */
export const ARMS = ["atl", "atl-pre", "mcp"] as const;
export type Arm = (typeof ARMS)[number];

export function isArm(value: unknown): value is Arm {
  return ARMS.some((arm) => arm === value);
}

export interface Check {
  success: boolean;
  details: string[];
}

export interface Scenario {
  id: string;
  name: string;
  write: boolean;
  /** `target` is only set for write scenarios: what this run must change (s8: the issue to comment on and move). */
  prompt(arm: Arm, target: string | undefined): string;
  /** Write scenarios only: picks the run's target; without it the runner picks an unused Teendő issue (s8). */
  pickTarget?: () => string;
  /**
   * Write scenarios with one shared target: restores its seeded state before each live run, so the run has to make the
   * change itself. Never called by rejudge, which skips these scenarios (their verdict depends on the live run window).
   */
  prepare?: () => Promise<void>;
  /** Judge the final assistant text; write scenarios also read the target back with atl. */
  check(finalText: string, arm: Arm, target?: string): Check | Promise<Check>;
}

export const HOST = "foldvarszki.atlassian.net";
export const WRITE_FROM = "Teendő";
export const WRITE_TO = "Ellenőrzés alatt";

function str(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("manifest field is not a string");
  }
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("manifest field is not a string array");
  }
  return value;
}

function counts(value: unknown): [string, number][] {
  if (!isRecord(value)) {
    throw new Error("manifest field is not an object");
  }
  return Object.entries(value).map(([key, count]) => {
    if (typeof count !== "number") {
      throw new Error("manifest count is not a number");
    }
    return [key, count];
  });
}

export function verdict(details: Record<string, boolean>): Check {
  return {
    success: Object.values(details).every(Boolean),
    details: Object.entries(details).map(([label, ok]) => `${ok ? "ok" : "FAIL"} ${label}`),
  };
}

export function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** `count` next to `label` in either order ("Teendő: 7", "7 in Teendő", "Teendő (7)", "| Teendő | 7 |"). */
export function countNear(text: string, label: string, count: number): boolean {
  const word = escapeRegExp(label);
  return new RegExp(
    `${word}[^\\n\\d]{0,24}\\b${count}\\b|\\b${count}\\b[^\\n\\d]{0,24}${word}`,
    "i",
  ).test(text);
}

/** Comments in an atl `{items}` list whose body contains `marker`; bodies are a string or a string[] of lines. */
export function markerCount(stdout: string, marker: string): number {
  const parsed: unknown = JSON.parse(stdout);
  const items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return items.filter((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const body = Array.isArray(item.body) ? item.body.join("\n") : item.body;
    return typeof body === "string" && body.includes(marker);
  }).length;
}

/** Candidate write targets: top-level-ish tasks currently planned as Teendő, in manifest order. */
export function writeCandidates(manifest: Manifest): string[] {
  return manifest.jira.issues
    .filter(
      (issue) =>
        issue.status === WRITE_FROM &&
        issue.parent !== "KAN-6" &&
        issue.type !== "Eposz" &&
        issue.type !== "Subtask",
    )
    .map((issue) => issue.key);
}

export function buildScenarios(manifest: Manifest): Scenario[] {
  const quartz = needle(manifest, "quartz-rollout-budget");
  const chain = needle(manifest, "four-issue-blocks-chain");
  const handbook = needle(manifest, "handbook-cold-storage-retention");
  const lantern = needle(manifest, "quartz-lantern-grandchild");
  const epic = needle(manifest, "mixed-status-epic");
  const latency = needle(manifest, "latency-budget-comments");
  const chainKeys = strings(chain.keys);
  const statusCounts = counts(epic.statusCounts);

  return [
    {
      id: "s1-needle-quartz",
      name: "Label lookup + description table",
      write: false,
      prompt: () =>
        `On ${HOST}, find the in-progress issue in project KAN that carries the label needle-quartz and is assigned to me. Tell me its key, current status, assignee, and the rollout budget stated in its description.`,
      check: (text) =>
        verdict({
          key: text.includes(str(quartz.key)),
          status: /folyamatban|in progress/i.test(text),
          assignee: /foldvarszki/i.test(text),
          budget: /48[,.\s]?210/.test(text),
        }),
    },
    {
      id: "s2-blocks-chain",
      name: "Blocks chain, 4 hops",
      write: false,
      prompt: () =>
        `On ${HOST}, KAN-154 sits at the end of a chain of issues that block each other. Follow the "blocks" links back to the root of the chain and list the issue keys in order, root first.`,
      check: (text) => {
        // Keys must appear in chain order as a subsequence: a first mention of the tail while
        // restating the question ("back from KAN-154") must not count against the answer.
        let cursor = 0;
        let inOrder = true;
        for (const key of chainKeys) {
          const found = text.indexOf(key, cursor);
          if (found < 0) {
            inOrder = false;
            break;
          }
          cursor = found + key.length;
        }
        return verdict({ allKeys: chainKeys.every((key) => text.includes(key)), order: inOrder });
      },
    },
    {
      id: "s3-rollback-window",
      name: "Old comment (9th newest)",
      write: false,
      prompt: () =>
        `On ${HOST}, how long is the rollback window, according to the comments on KAN-91?`,
      check: (text) => verdict({ answer: /\b37\s*(min|minutes)/i.test(text), key: true }),
    },
    {
      id: "s4-handbook-retention",
      name: "Huge page (246 KB), one table row",
      write: false,
      prompt: () =>
        `On ${HOST}, per the Confluence Platform Handbook, what is the cold storage retention period?`,
      check: (text) => verdict({ answer: /\b410\s*days/i.test(text), page: str(handbook.title).length > 0 }),
    },
    {
      id: "s5-lantern-page",
      name: "Find page by phrase, report parent",
      write: false,
      prompt: () =>
        `On ${HOST}, which Confluence page describes the 'quartz lantern protocol'? Give me its title and the title of its parent page.`,
      check: (text) =>
        verdict({
          title: text.includes("Edge relay handshake"),
          parent: text.includes("Edge network"),
          expectedTitle: str(lantern.title).length > 0,
        }),
    },
    {
      id: "s6-epic-children",
      name: "Epic children count + per-status counts",
      write: false,
      prompt: () =>
        `On ${HOST}, how many child issues does epic KAN-6 have, and how many of them are in each status?`,
      check: (text) =>
        verdict({
          total: new RegExp(`\\b${String(epic.childCount)}\\b`).test(text),
          ...Object.fromEntries(
            statusCounts.map(([status, count]) => [
              `${status}=${count}`,
              countNear(text, status, count),
            ]),
          ),
        }),
    },
    {
      id: "s7-latency-comments",
      name: "Footer comments filtered by topic",
      write: false,
      prompt: () =>
        `On ${HOST}, on the Confluence page "atl smoke eval Architecture: API gateway rate limiting", which of the comments mention the latency budget? Summarize what each of them says.`,
      check: (text) =>
        verdict({
          comment25ms: /\b25\s*ms/i.test(text),
          comment40ms: /\b40\s*ms/i.test(text),
          expectedCount: Number(latency.mentioning) === 2,
        }),
    },
    {
      id: "s8-comment-and-move",
      name: "Write: comment + transition",
      write: true,
      prompt: (arm, target) =>
        `On ${HOST}, add the comment "atl smoke eval: budget confirmed (${arm})" to ${target ?? "?"} and move that issue to "${WRITE_TO}".`,
      check: async (_text, arm, target) => {
        if (target === undefined) {
          throw new Error("write scenario needs a target issue");
        }
        const marker = `atl smoke eval: budget confirmed (${arm})`;
        const issue = await atl("issue", "get", target);
        const issueJson: unknown = JSON.parse(issue.stdout);
        const status = isRecord(issueJson) ? issueJson.status : undefined;
        const matching = markerCount((await atl("issue", "comments", target, "--all")).stdout, marker);
        return {
          ...verdict({ status: status === WRITE_TO, commentPresent: matching >= 1, commentOnce: matching === 1 }),
          details: [`read-back ${target}: status=${String(status)} matching comments=${matching}`],
        };
      },
    },
  ];
}
