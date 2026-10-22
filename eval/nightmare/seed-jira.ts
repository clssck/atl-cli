#!/usr/bin/env bun
/**
 * Corporate-nightmare Jira seed for the KAN trial project.
 *
 * Shells out to the frozen atl binary only (structured argv, never a shell string). Every created issue carries the
 * summary prefix "atl smoke nm ", the label `nightmare` and a stable label `nm-id-<id>`; a re-run finds existing
 * content by that label and only applies what is missing (status, links, comments, worklogs, attachments, ...).
 *
 *   bun eval/nightmare/seed-jira.ts            # seed everything, write eval/.out/nightmare/jira.json
 *   NM_PHASES=create,links bun eval/nightmare/seed-jira.ts   # only some phases (always followed by the manifest)
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-jira.ts      # another binary
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PROJECT = "KAN";
const PREFIX = "atl smoke nm ";
const ROOT_LABEL = "nightmare";
const OUT_DIR = join(import.meta.dir, "..", ".out", "nightmare");
const FILES_DIR = join(OUT_DIR, "files");
const MANIFEST_PATH = join(OUT_DIR, "jira.json");
const PACE_MS = 300;
const MAX_ATTEMPTS = 7;

// ---------------------------------------------------------------------------------------------------------------------
// Process plumbing

type Json = unknown;
type Obj = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function items(value: Json): Obj[] {
  return isRecord(value) ? asArray(value.items).filter(isRecord) : [];
}

interface Finding {
  label: string;
  argv: string[];
  exitCode: number;
  code: string;
  message: string;
  handling: "retried" | "gave-up";
}

const findings: Finding[] = [];
let calls = 0;

function log(message: string): void {
  process.stderr.write(`[nm-jira] ${message}\n`);
}

function failureOf(stdout: string, stderr: string, exitCode: number): { code: string; message: string } {
  for (const line of [stdout.trim(), ...stderr.trim().split("\n").toReversed()]) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value) && value.type === "error") {
        return { code: asString(value.code) || "unknown", message: asString(value.message) || line };
      }
    } catch {
      // Not a JSON diagnostic; keep scanning.
    }
  }
  return { code: `exit_${exitCode}`, message: (stderr.trim() || stdout.trim() || `exit ${exitCode}`).slice(0, 500) };
}

class AtlFailure extends Error {}

interface CallOptions {
  /** After a transient failure of a non-idempotent write: true when the write evidently landed, so no retry. */
  landed?: () => Promise<boolean>;
  /** A write that is a no-op to repeat or a read: pace nothing. */
  read?: boolean;
}

/** Run atl; exit 3 is retried with exponential backoff, anything else non-zero throws AtlFailure. */
async function atl(label: string, argv: string[], options: CallOptions = {}): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawn([ATL, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    calls += 1;
    if (exitCode === 0) {
      if (!options.read) {
        await Bun.sleep(PACE_MS);
      }
      try {
        return JSON.parse(stdout);
      } catch {
        throw new AtlFailure(`${label}: stdout is not JSON: ${stdout.slice(0, 200)}`);
      }
    }
    const failure = failureOf(stdout, stderr, exitCode);
    const transient = exitCode === 3;
    const retry = transient && attempt < MAX_ATTEMPTS;
    findings.push({
      label,
      argv: argv.map((a) => (a.length > 200 ? `${a.slice(0, 200)}...(${a.length})` : a)),
      exitCode,
      code: failure.code,
      message: failure.message.slice(0, 500),
      handling: retry ? "retried" : "gave-up",
    });
    log(`${label}: exit ${exitCode} ${failure.code} ${retry ? "(retrying)" : "(giving up)"}: ${failure.message.slice(0, 160)}`);
    if (!retry) {
      throw new AtlFailure(`${label}: ${failure.message}`);
    }
    await Bun.sleep(2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
    if (options.landed && (await options.landed())) {
      return {};
    }
  }
}

/** A step whose failure is already recorded in findings must not abort the remaining seed. */
async function soft<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof AtlFailure)) {
      findings.push({
        label,
        argv: [],
        exitCode: -1,
        code: "script",
        message: error instanceof Error ? error.message : String(error),
        handling: "gave-up",
      });
      log(`${label}: script error ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Spec

type IssueType = "Eposz" | "Feladat" | "Story" | "Subtask";
type Status = "Teendő" | "Folyamatban" | "Ellenőrzés alatt" | "Kész";
type Priority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

const TRANSITION_ID: Record<Status, string> = {
  Teendő: "11",
  Folyamatban: "21",
  "Ellenőrzés alatt": "31",
  Kész: "41",
};

const PRIORITIES: Priority[] = ["Highest", "High", "Medium", "Low", "Lowest"];

interface Spec {
  id: string;
  type: IssueType;
  summary: string;
  /** Parent id at creation time. */
  parent?: string;
  /** Final parent id when the issue is re-parented after creation. */
  finalParent?: string;
  /** Final type when the issue is converted after creation (task <-> subtask). */
  finalType?: IssueType;
  /** Convert through `bulk move` instead of `issue convert`. */
  viaBulkMove?: boolean;
  body?: string;
  priority?: Priority | undefined;
  labels?: string[];
  due?: string;
  start?: string;
  flagged?: boolean;
  status?: Status | undefined;
  /** Move to `status` through `bulk transition` (grouped by status) instead of one `issue move` each. */
  viaBulkTransition?: boolean;
}

const specs: Spec[] = [];
const byId = new Map<string, Spec>();

function add(
  id: string,
  type: IssueType,
  summary: string,
  options: Omit<Spec, "id" | "type" | "summary"> = {},
): void {
  const spec: Spec = { id, type, summary, ...options };
  if (byId.has(id)) {
    throw new Error(`duplicate spec id ${id}`);
  }
  specs.push(spec);
  byId.set(id, spec);
}

// ----- content generators ---------------------------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const RATE_CARD_TARGET_MERCHANT = "MERCH-0731";
const RATE_CARD_TARGET_FEE = "19.35";

function rateCardBody(): string {
  const rand = lcg(731);
  const seen = new Set<string>([RATE_CARD_TARGET_FEE]);
  const rows: string[] = [];
  for (let i = 1; i <= 180; i++) {
    const merchant = `MERCH-${String(600 + i).padStart(4, "0")}`;
    let fee = (8 + rand() * 16).toFixed(2);
    while (seen.has(fee)) {
      fee = (8 + rand() * 16).toFixed(2);
    }
    seen.add(fee);
    const scheme = ["Visa", "Mastercard", "Amex", "SZÉP-kártya", "Maestro"][i % 5];
    const region = ["HU", "AT", "SK", "RO", "DE", "PL"][i % 6];
    let notes = "standard interchange++";
    if (i % 7 === 0) {
      notes = "rebate A \\| B applies after 10k tx/month";
    } else if (i % 11 === 0) {
      notes = "`tier=2\\|3` pending review";
    } else if (i % 13 === 0) {
      notes = "ünïcode ✓ árvíztűrő-tükörfúrógép";
    }
    const settlement = merchant === RATE_CARD_TARGET_MERCHANT ? RATE_CARD_TARGET_FEE : fee;
    rows.push(`| ${merchant} | ${region} | ${scheme} | ${settlement} | ${notes} |`);
  }
  const reconNotes = Array.from(
    { length: 6 },
    (_, i) =>
      `Reconciliation note ${i + 1}: the settlement engine rounds half-even per scheme, then re-balances the residual cent onto the largest ledger line. Merchants on the SZÉP-kártya scheme settle T+2, all others T+1.`,
  );
  return [
    "# FY27 payments rate card (excerpt)",
    "",
    "The rate card below is the single source of truth for settlement fees. Values are basis points of gross volume.",
    "",
    ...reconNotes.slice(0, 3),
    "",
    "## Merchant table",
    "",
    "| Merchant | Region | Scheme | Settlement fee (bps) | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Reconciliation notes",
    "",
    ...reconNotes.slice(3),
    "",
    "_End of rate card. Do not copy values from the 2025 card._",
  ].join("\n");
}

const NESTED_LISTS_BODY = [
  "## Nested lists, five levels deep",
  "",
  "- Level 1: access governance",
  "  - Level 2: quarterly review",
  "    - Level 3: evidence collection",
  "      - Level 4: system exports",
  "        - Level 5: sentinel deep-leaf value is `NM-DEEP-LEAF-5521`",
  "",
  "1. First ordered",
  "   1. Second ordered",
  "      - Third bullet inside ordered",
  "        1. Fourth ordered",
  "           - Fifth bullet: **bold** and _italic_ and `code`",
  "",
  "- [ ] open task",
  "- [x] done task",
].join("\n");

const CODE_BODY = [
  "## Code blocks with backticks",
  "",
  "Inline `code with \\` an escaped backtick` and ``double `tick` code``.",
  "",
  "````markdown",
  "```json",
  '{"nested": {"fence": "```", "n": 1}}',
  "```",
  "````",
  "",
  "```sql",
  "SELECT `order`.`id`, COUNT(*) AS n",
  "FROM `payments`.`order` AS `order`",
  "WHERE `order`.`status` IN ('SETTLED', 'REFUNDED') -- pipes | and \"quotes\"",
  "GROUP BY 1;",
  "```",
  "",
  "```bash",
  'for f in $(ls *.log); do echo "`date` $f" | tee -a /tmp/out.txt; done',
  "```",
  "",
  "```json",
  '{"unicode":"árvíztűrő \\u00e9","emoji":"🔥","null":null,"arr":[1,[2,[3,[4]]]]}',
  "```",
].join("\n");

const RTL_ZWJ_BODY = [
  "## Quotes, RTL and zero-width joiners",
  "",
  "> Outer quote",
  ">",
  "> > Inner quote with **bold**",
  "",
  "Arabic: مرحبا بالعالم — تقرير الامتثال الربع سنوي (2026)",
  "",
  "Hebrew: שלום עולם — דוח ציות רבעוני",
  "",
  "Mixed: invoice #4412 مبلغ 1,250.00 USD paid.",
  "",
  "Family emoji with ZWJ: 👨‍👩‍👧‍👦 and 🏳️‍🌈, plus word with zero-width joiners: Z\u200DE\u200DR\u200DO\u200DW\u200DI\u200DD\u200DT\u200DH.",
  "",
  "Zero-width space: a\u200Bb\u200Bc and a byte order mark \uFEFF here.",
].join("\n");

function longLineBody(): string {
  const words = ["settlement", "reconcile", "ledger", "tűzfal", "árvíz", "batch", "ütemezett", "retry"];
  const line = Array.from({ length: 560 }, (_, i) => words[(i * 7) % words.length]).join(" ");
  const rand = lcg(99);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const token = Array.from({ length: 2500 }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
  return [
    "## Very long single lines",
    "",
    line,
    "",
    `Unbroken token (2500 chars, no spaces): ${token}`,
    "",
    "Short tail line after the monsters.",
  ].join("\n");
}

const TABLE_PIPES_BODY = [
  "## Table with awkward cells",
  "",
  "| Field | Example | Note |",
  "| --- | --- | --- |",
  "| regex | `a\\|b\\|c` | escaped pipes inside code |",
  "| shell | `cat f \\| grep x` | pipe in a command |",
  "| text | left \\| right | plain escaped pipe |",
  "| unicode | árvíztűrő ✓ 🔥 | accents and emoji |",
  "| empty |  | empty cell next to it |",
  "| link | [docs](https://example.com/a?b=1&c=2) | link in cell |",
].join("\n");

const HU_BODY = [
  "# Magyar leírás",
  "",
  "Ez egy **félkövér**, _dőlt_ és `kód` formázású szöveg ékezetekkel: árvíztűrő tükörfúrógép, ŐÚÜÖÓÉÁÍ.",
  "",
  "- első pont: „idézőjelek” és »francia« idézet",
  "- második pont: 100% / 50% \\ backslash",
].join("\n");

function threadComment(n: number): string {
  if (n === 12) {
    return "Vendor check: the HSM vendor is Acme Secure (quote Q-2291).";
  }
  if (n === 27) {
    return "Vendor confirmed with procurement (PO 88213).";
  }
  if (n === 31) {
    return "Dry-run finished. Rollback window is 47 minutes per runbook RB-914, step 6.";
  }
  if (n === 4) {
    return "Early estimate: rollback window about 30 minutes (to be confirmed by the dry-run).";
  }
  if (n % 9 === 0) {
    return [`Debug snippet for update ${n}:`, "", "```sql", `SELECT id FROM \`batch\` WHERE run = ${n}; -- a | b`, "```"].join("\n");
  }
  if (n % 10 === 5) {
    return [`Metrics for update ${n}:`, "", "| metric | value |", "| --- | --- |", `| p99 ms | ${100 + n * 3} |`, `| errors \\| 5xx | ${n % 4} |`].join("\n");
  }
  return `Status update ${n}: nothing blocking. Árvíztűrő tükörfúrógép ${n} / 36 reviewed; ${n % 2 === 0 ? "👍" : "🙂"}`;
}

const THREAD_COMMENT_COUNT = 36;
const THREAD_EDIT_COMMENT = 27;
const THREAD_EDIT_BODY =
  "Correction: the vendor is Borealis Cryptography, not Acme Secure (PO 88213 re-issued; Acme withdrew on 2026-10-02).";

function filler(id: string, n: number): string {
  return `Work item ${id} (${n}). Generated for the atl nightmare seed; the content is intentionally plain.`;
}

// ----- the org --------------------------------------------------------------------------------------------------------

const DEPARTMENTS = [
  ["plat", "Platform", "Platformmérnökség / Platform Engineering"],
  ["pay", "Payments", "Fizetések / Payments"],
  ["comp", "Compliance", "Megfelelőség / Compliance"],
  ["mob", "Mobile", "Mobilalkalmazások 📱 / Mobile"],
  ["data", "Data", "Adat és analitika / Data"],
  ["legal", "Legal", "Jogi osztály / Legal"],
] as const;

for (const [slug, tag, name] of DEPARTMENTS) {
  add(`epic-${slug}`, "Eposz", `[${tag}] ${name}`, {
    body: `Department epic for ${tag}. Everything under it was seeded by the nightmare seed.`,
    priority: "Medium",
    labels: [`dept-${slug}`],
  });
}

// Platform: long blocker chain (chain-01 is blocked by chain-02 ... chain-13 is blocked by chain-14)
for (let i = 1; i <= 14; i++) {
  const n = String(i).padStart(2, "0");
  add(`plat-chain-${n}`, "Feladat", `[Platform] Rollout step ${n}: stage ${i} of the gateway migration`, {
    parent: "epic-plat",
    priority: PRIORITIES[i % 5],
    status: i === 14 ? "Folyamatban" : "Teendő",
    body:
      i === 14
        ? "Root blocker: the HSM firmware signing key for cluster fra-3 expired on 2026-09-30. Renewal ticket REN-4471 is waiting for the vendor."
        : i === 7
          ? `${filler(`chain-${n}`, i)} Note: legal review is NOT the blocker here.`
          : filler(`chain-${n}`, i),
  });
}

// Platform: cycle A -> B -> C -> A (blocks)
for (const l of ["a", "b", "c"]) {
  add(`plat-cycle-${l}`, "Feladat", `[Platform] Cycle member ${l.toUpperCase()}: circular deployment dependency`, {
    parent: "epic-plat",
    priority: "High",
    body: `Cycle member ${l.toUpperCase()}. Blocks the next member and is blocked by the previous one.`,
  });
}

// Platform: diamond (top blocked by left+right; both blocked by bottom)
add("plat-diamond-top", "Feladat", "[Platform] Diamond top: ship the new ingress", {
  parent: "epic-plat",
  priority: "Highest",
  body: "Needs both the left and the right branch before it can ship.",
});
add("plat-diamond-left", "Feladat", "[Platform] Diamond left: TLS termination", { parent: "epic-plat", status: "Kész" });
add("plat-diamond-right", "Feladat", "[Platform] Diamond right: rate limiting", { parent: "epic-plat", status: "Folyamatban" });
add("plat-diamond-bottom", "Feladat", "[Platform] Diamond bottom: provision the load balancer", {
  parent: "epic-plat",
  status: "Kész",
});

// Platform: story with five subtasks in varied statuses
add("plat-story-1", "Story", "[Platform] Observability overhaul / megfigyelhetőség", {
  parent: "epic-plat",
  priority: "High",
  status: "Folyamatban",
  body: HU_BODY,
});
const platSubStatuses: Status[] = ["Teendő", "Folyamatban", "Ellenőrzés alatt", "Kész", "Kész"];
platSubStatuses.forEach((status, i) => {
  add(`plat-s1-sub-${i + 1}`, "Subtask", `[Platform] Observability subtask ${i + 1}: ${["dashboards", "alerts", "traces", "log retention", "SLO report"][i]}`, {
    parent: "plat-story-1",
    status,
    priority: PRIORITIES[(i + 1) % 5],
  });
});

// Platform: story whose children arrive through bulk move / convert
add("plat-story-2", "Story", "[Platform] Secrets management consolidation", { parent: "epic-plat", priority: "Medium" });
add("plat-s2-sub-1", "Subtask", "[Platform] Secrets subtask 1: inventory vaults", { parent: "plat-story-2", status: "Kész" });
add("plat-s2-sub-2", "Subtask", "[Platform] Secrets subtask 2: rotate service tokens", { parent: "plat-story-2", status: "Folyamatban" });
for (let i = 1; i <= 3; i++) {
  add(`plat-bulkmove-${i}`, "Feladat", `[Platform] Orphan task ${i} folded into secrets story (bulk move)`, {
    finalType: "Subtask",
    finalParent: "plat-story-2",
    viaBulkMove: true,
    status: i === 1 ? "Kész" : "Teendő",
  });
}
add("plat-convert-up", "Feladat", "[Platform] Task converted into a sub-task of the observability story", {
  parent: "epic-plat",
  finalType: "Subtask",
  finalParent: "plat-story-1",
});
add("plat-convert-down", "Subtask", "[Platform] Sub-task promoted to a standalone task", {
  parent: "plat-story-2",
  finalType: "Feladat",
});

// Platform: near-duplicate pair (one character apart)
add("plat-pg15", "Feladat", "[Platform] Migrate billing ledger to Postgres 15", {
  parent: "epic-plat",
  status: "Kész",
  due: "2026-03-01",
  body: "Cutover for the Postgres 15 migration happened on 2026-03-01. Superseded by the Postgres 16 migration.",
});
add("plat-pg16", "Feladat", "[Platform] Migrate billing ledger to Postgres 16", {
  parent: "epic-plat",
  status: "Folyamatban",
  due: "2027-02-14",
  priority: "High",
  body: "Cutover for the Postgres 16 migration is scheduled for 2027-02-14, owner Nóra.",
});

// Platform: re-parented into Mobile
add("plat-reparent", "Feladat", "[Platform→Mobile] Shared push-notification gateway (re-parented)", {
  parent: "epic-plat",
  finalParent: "epic-mob",
  status: "Ellenőrzés alatt",
});

// Payments
add("pay-bigdesc", "Feladat", "[Payments] Rate card FY27 (20 KB description with a 180-row table)", {
  parent: "epic-pay",
  priority: "High",
  body: rateCardBody(),
});
add(
  "pay-longsum",
  "Feladat",
  `[Payments] ${"Reconcile settlement batches across acquirers, schemes and the ledger with árvíztűrő tükörfúrógép accuracy, ".repeat(3)}`.slice(0, 237),
  { parent: "epic-pay", priority: "Low" },
);
add("pay-empty", "Feladat", "[Payments] Issue with no description at all", { parent: "epic-pay" });
add("pay-quotes", "Feladat", `[Payments] Quotes "double" 'single' \`tick\` \\ back/slash {braces} [brackets] <angle> & ampersand 100%`, {
  parent: "epic-pay",
  body: HU_BODY,
});
add("pay-thread", "Story", "[Payments] HSM rollout war room (36-comment thread)", {
  parent: "epic-pay",
  priority: "Highest",
  status: "Folyamatban",
  body: "War room for the HSM rollout. Read the whole thread before concluding anything.",
});
add("pay-wl-story", "Story", "[Payments] Settlement engine rewrite", {
  parent: "epic-pay",
  priority: "High",
  status: "Folyamatban",
});
for (let i = 1; i <= 4; i++) {
  add(`pay-wl-sub-${i}`, "Subtask", `[Payments] Settlement rewrite subtask ${i}`, {
    parent: "pay-wl-story",
    status: (["Kész", "Kész", "Folyamatban", "Teendő"] as const)[i - 1],
  });
}
for (let i = 1; i <= 3; i++) {
  add(`pay-wl-${i}`, "Feladat", `[Payments] Chargeback tooling task ${i}`, {
    parent: "epic-pay",
    status: (["Ellenőrzés alatt", "Kész", "Teendő"] as const)[i - 1],
  });
}
add("pay-dup-a", "Feladat", "[Payments] Rotate API keys for payments-gw", { parent: "epic-pay", body: "Original request." });
add("pay-dup-b", "Feladat", "[Payments] Rotate API keys for payment-gw", {
  parent: "epic-pay",
  body: "Typo twin of the original request (payment-gw vs payments-gw); closed as duplicate.",
  status: "Kész",
});

// Compliance: ADF stress, one issue per construct
add("comp-adf-lists", "Feladat", "[Compliance] ADF stress: nested lists", { parent: "epic-comp", body: NESTED_LISTS_BODY });
add("comp-adf-code", "Feladat", "[Compliance] ADF stress: code blocks and backticks", { parent: "epic-comp", body: CODE_BODY });
add("comp-adf-rtl", "Feladat", "[Compliance] ADF stress: quotes, RTL text and zero-width joiners", {
  parent: "epic-comp",
  body: RTL_ZWJ_BODY,
});
add("comp-adf-longline", "Feladat", "[Compliance] ADF stress: very long single lines", { parent: "epic-comp", body: longLineBody() });
add("comp-adf-table", "Feladat", "[Compliance] ADF stress: table with pipes in cells", { parent: "epic-comp", body: TABLE_PIPES_BODY });
add("comp-adf-all", "Story", "[Compliance] ADF stress: everything at once 🔥", {
  parent: "epic-comp",
  body: [NESTED_LISTS_BODY, "", CODE_BODY, "", RTL_ZWJ_BODY, "", TABLE_PIPES_BODY].join("\n"),
});
add("comp-access-review", "Feladat", "[Compliance] Quarterly access review", {
  parent: "epic-comp",
  body: "External auditor for this review: Kovács & Partners Kft. Scope: production IAM roles.",
  status: "Ellenőrzés alatt",
});
add("comp-history", "Feladat", "Draft: retention policy review", {
  parent: "epic-comp",
  priority: "Medium",
  body: "Retention policy review with a deliberately busy history.",
});
for (let i = 1; i <= 3; i++) {
  add(`comp-overdue-${i}`, "Feladat", `[Compliance] Overdue control ${i}`, {
    parent: "epic-comp",
    due: `2026-09-0${i * 2}`,
    status: i === 3 ? "Kész" : i === 2 ? "Folyamatban" : "Teendő",
    priority: "High",
  });
}
for (let i = 1; i <= 2; i++) {
  add(`comp-future-${i}`, "Feladat", `[Compliance] Upcoming control ${i}`, { parent: "epic-comp", due: `2027-0${i}-15` });
}

// Mobile
add("mob-story-a", "Story", "[Mobile] iOS release 5.0 🚀", {
  parent: "epic-mob",
  priority: "High",
  status: "Folyamatban",
  body: HU_BODY,
});
const mobSub: Status[] = ["Teendő", "Teendő", "Folyamatban", "Folyamatban", "Folyamatban", "Ellenőrzés alatt", "Kész", "Kész"];
mobSub.forEach((status, i) => {
  add(`mob-a-sub-${i + 1}`, "Subtask", `[Mobile] iOS 5.0 subtask ${i + 1}`, {
    parent: "mob-story-a",
    status,
    viaBulkTransition: status === "Folyamatban",
    priority: PRIORITIES[i % 5],
  });
});
add("mob-story-b", "Story", "[Mobile] Android release 5.0", { parent: "epic-mob", status: "Teendő" });
add("mob-hu-1", "Feladat", "[Mobile] Ékezetes cím: árvíztűrő tükörfúrógép, ŐÚÜÖÓÉÁÍ", { parent: "epic-mob", status: "Kész" });
add("mob-emoji", "Feladat", "[Mobile] 🔥🔥 Crash on launch 💥 (iPhone 15 Pro, iOS 17.4)", { parent: "epic-mob", priority: "Highest" });
add("mob-rtl", "Feladat", "[Mobile] Arabic locale: مرحبا بالعالم layout breaks", { parent: "epic-mob" });
add("mob-slashes", "Feladat", "[Mobile] Deep link scheme app://pay/{id}?ref=a\\b#frag [P1]", { parent: "epic-mob" });
add("mob-cjk", "Feladat", "[Mobile] 日本語ロケール: 支払い画面のレイアウト崩れ", { parent: "epic-mob", status: "Ellenőrzés alatt" });

// Data
add("data-attach", "Feladat", "[Data] Capacity forecast with attachments", {
  parent: "epic-data",
  body: "Attachments: a unicode-named text, two files named report.csv, a 2 MiB trace and a binary sample.",
});
add("data-props", "Feladat", "[Data] Routing config stored in an issue property", {
  parent: "epic-data",
  body: "The routing tiers live in the issue property nm.routing.",
});
add("data-links", "Feladat", "[Data] Dashboard with many web links", { parent: "epic-data", body: "See the web links." });
add("data-labels", "Feladat", "[Data] Odd labels: dots, dashes, unicode", {
  parent: "epic-data",
  labels: ["v1.2.3", "ünïcode-lábel", "a-b_c", "team:data", "ΔΣ-greek", "x.y.z.9"],
});
add("data-flagged", "Feladat", "[Data] Flagged impediment with start date", {
  parent: "epic-data",
  flagged: true,
  start: "2026-10-01",
  due: "2026-12-24",
  status: "Folyamatban",
});
add("data-clone-src", "Feladat", "[Data] Warehouse backfill", { parent: "epic-data", priority: "High" });
add("data-clone-dst", "Feladat", "[Data] Warehouse backfill (clone)", { parent: "epic-data", priority: "High" });
for (let i = 1; i <= 4; i++) {
  add(`orphan-${i}`, "Feladat", `[Orphan] Task without any epic ${i}`, {
    status: (["Teendő", "Folyamatban", "Ellenőrzés alatt", "Kész"] as const)[i - 1],
    priority: PRIORITIES[i],
    labels: i === 1 ? ["Ünnepnap-2026"] : [],
  });
}

// Legal
add("legal-access-review", "Feladat", "[Compliance] Quarterly access review", {
  parent: "epic-legal",
  body: "External auditor for this review: Nagy Ügyvédi Iroda. Scope: contract-management system.",
});
for (let i = 1; i <= 3; i++) {
  add(`legal-x-${i}`, "Feladat", `[Legal] Cross-epic dependency ${i}: blocks a payments item`, {
    parent: "epic-legal",
    status: (["Folyamatban", "Teendő", "Kész"] as const)[i - 1],
  });
}
add("legal-dup-src", "Feladat", "[Legal] Update data processing agreement", { parent: "epic-legal" });
add("legal-dup-dst", "Feladat", "[Legal] Update the data-processing agreement", { parent: "epic-legal", status: "Kész" });
add("legal-rel", "Feladat", "[Legal] GDPR records of processing", { parent: "epic-legal", status: "Ellenőrzés alatt" });
add("legal-every-1", "Feladat", "[Legal] Contract renewal: Teendő", { parent: "epic-legal", status: "Teendő", due: "2026-10-01" });
add("legal-every-2", "Feladat", "[Legal] Contract renewal: Folyamatban", { parent: "epic-legal", status: "Folyamatban", due: "2026-11-30" });
add("legal-every-3", "Feladat", "[Legal] Contract renewal: Ellenőrzés alatt", { parent: "epic-legal", status: "Ellenőrzés alatt" });
add("legal-every-4", "Feladat", "[Legal] Contract renewal: Kész", { parent: "epic-legal", status: "Kész" });
add("legal-long", "Feladat", `[Legal] ${"Negotiate the framework agreement with every subcontractor and their sub-subcontractors, ".repeat(4)}`.slice(0, 237), {
  parent: "epic-legal",
  priority: "Lowest",
});

// ---------------------------------------------------------------------------------------------------------------------
// Relations and activity tables

interface LinkSpec {
  from: string;
  relation: "blocks" | "is blocked by" | "relates to" | "duplicates" | "is duplicated by" | "clones" | "is cloned by";
  to: string;
}

const linkSpecs: LinkSpec[] = [];
function link(from: string, relation: LinkSpec["relation"], to: string): void {
  linkSpecs.push({ from, relation, to });
}

for (let i = 1; i < 14; i++) {
  link(`plat-chain-${String(i).padStart(2, "0")}`, "is blocked by", `plat-chain-${String(i + 1).padStart(2, "0")}`);
}
link("plat-cycle-a", "blocks", "plat-cycle-b");
link("plat-cycle-b", "blocks", "plat-cycle-c");
link("plat-cycle-c", "blocks", "plat-cycle-a");
link("plat-diamond-top", "is blocked by", "plat-diamond-left");
link("plat-diamond-top", "is blocked by", "plat-diamond-right");
link("plat-diamond-left", "is blocked by", "plat-diamond-bottom");
link("plat-diamond-right", "is blocked by", "plat-diamond-bottom");
link("plat-pg16", "relates to", "plat-pg15");
link("pay-dup-b", "duplicates", "pay-dup-a");
link("data-clone-dst", "clones", "data-clone-src");
link("legal-dup-dst", "duplicates", "legal-dup-src");
link("legal-rel", "relates to", "comp-access-review");
link("legal-x-1", "blocks", "pay-wl-1");
link("legal-x-2", "blocks", "pay-thread");
link("legal-x-3", "blocks", "mob-story-a");
link("comp-access-review", "relates to", "legal-access-review");
link("pay-thread", "is blocked by", "plat-chain-14");
link("mob-story-b", "is blocked by", "plat-reparent");

interface RemoteLink {
  issue: string;
  url: string;
  title: string;
  relationship?: string;
  summary?: string;
}

const remoteLinks: RemoteLink[] = [
  { issue: "data-links", url: "https://example.com/runbooks/old-v1", title: "Old runbook (retired)", relationship: "supersedes", summary: "Retired in 2026-Q2" },
  { issue: "data-links", url: "https://example.com/runbooks/current", title: "Current runbook", relationship: "documented in" },
  { issue: "data-links", url: "https://example.com/dash?a=1&b=2#frag", title: "Grafana: ingest lag", relationship: "mentioned in" },
  { issue: "data-links", url: "https://example.com/ünïcode/árvíztűrő", title: "Árvíztűrő dashboard", relationship: "causes" },
  { issue: "data-links", url: "https://example.com/q?x=%E2%9C%93", title: "Status page ✓", summary: "Link with a long summary ".repeat(8) },
  { issue: "data-links", url: "https://foldvarszki.atlassian.net/wiki/spaces/SZOFTVERFE/overview", title: "Confluence space overview", relationship: "documented in" },
  { issue: "pay-thread", url: "https://example.com/runbooks/RB-914", title: "RB-914 rollback runbook", relationship: "documented in" },
  { issue: "pay-thread", url: "https://example.com/vendors/borealis", title: "Borealis Cryptography", relationship: "relates to" },
  { issue: "pay-thread", url: "https://example.com/vendors/acme", title: "Acme Secure (withdrawn)" },
  { issue: "plat-chain-14", url: "https://example.com/ren/REN-4471", title: "REN-4471 renewal", relationship: "blocks" },
  { issue: "comp-access-review", url: "https://example.com/audit/2026-q3", title: "Audit evidence folder" },
];

interface WorklogSpec {
  issue: string;
  time: string;
  started: string;
  comment: string;
}

const worklogSpecs: WorklogSpec[] = [
  { issue: "pay-wl-story", time: "2h 30m", started: "2026-09-14T09:00:00.000+0200", comment: "Design review" },
  { issue: "pay-wl-story", time: "45m", started: "2026-09-15T14:15:00.000+0200", comment: "Pairing session" },
  { issue: "pay-wl-sub-1", time: "4h", started: "2026-09-16T08:30:00.000+0200", comment: "Ledger schema" },
  { issue: "pay-wl-sub-1", time: "1h 15m", started: "2026-09-17T10:00:00.000+0200", comment: "Schema fixes" },
  { issue: "pay-wl-sub-2", time: "6h", started: "2026-09-18T09:00:00.000+0200", comment: "Rounding engine" },
  { issue: "pay-wl-sub-3", time: "20m", started: "2026-10-01T16:40:00.000+0200", comment: "Triage" },
  { issue: "pay-wl-1", time: "3h 10m", started: "2026-10-02T11:00:00.000+0200", comment: "Chargeback form" },
  { issue: "pay-wl-2", time: "5m", started: "2026-10-05T12:00:00.000+0200", comment: "Quick check" },
  { issue: "pay-thread", time: "1h 50m", started: "2026-10-06T13:00:00.000+0200", comment: "Dry-run babysitting" },
  { issue: "pay-thread", time: "7h 5m", started: "2026-10-07T07:30:00.000+0200", comment: "Cutover day" },
  { issue: "pay-bigdesc", time: "35m", started: "2026-10-08T15:30:00.000+0200", comment: "Rate card import" },
  { issue: "mob-a-sub-1", time: "8h", started: "2026-10-09T09:00:00.000+0200", comment: "Noise: mobile worklog" },
  { issue: "plat-story-1", time: "2h", started: "2026-10-10T09:00:00.000+0200", comment: "Noise: platform worklog" },
];

function minutesOf(time: string): number {
  let total = 0;
  for (const part of time.split(" ")) {
    const value = Number.parseInt(part, 10);
    total += part.endsWith("h") ? value * 60 : value;
  }
  return total;
}

/** Status path of an issue with a rich changelog; the issue ends in the last status. */
const HISTORY: Record<string, { path: Status[]; renameAfter?: { step: number; summary: string } }> = {
  "comp-history": {
    path: ["Folyamatban", "Ellenőrzés alatt", "Folyamatban", "Teendő", "Folyamatban", "Ellenőrzés alatt", "Kész", "Folyamatban", "Kész"],
    renameAfter: { step: 1, summary: "Retention policy review (final)" },
  },
  "pay-wl-3": { path: ["Folyamatban", "Teendő", "Folyamatban", "Teendő"] },
  "mob-story-b": { path: ["Folyamatban", "Ellenőrzés alatt", "Teendő"] },
};

interface AttachmentSpec {
  issue: string;
  /** Path relative to FILES_DIR; the basename is the uploaded filename. */
  file: string;
  /** Generator for the content. */
  bytes: () => Uint8Array;
}

function seededBytes(seed: number, size: number): Uint8Array {
  const rand = lcg(seed);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Math.floor(rand() * 256);
  }
  return out;
}

const encoder = new TextEncoder();
const LARGEST_ATTACHMENT = "capacity-trace-2MiB.bin";
const attachmentSpecs: AttachmentSpec[] = [
  { issue: "data-attach", file: "u/jelentés-árvíztűrő-tükörfúrógép-📊.txt", bytes: () => encoder.encode("Éves jelentés: árvíztűrő tükörfúrógép 📊\n".repeat(40)) },
  { issue: "data-attach", file: "a/report.csv", bytes: () => encoder.encode("region,units\nHU,120\nAT,45\n") },
  { issue: "data-attach", file: "b/report.csv", bytes: () => encoder.encode(`region,units\n${"HU,121\nAT,46\nSK,7\n".repeat(30)}`) },
  { issue: "data-attach", file: LARGEST_ATTACHMENT, bytes: () => seededBytes(2, 2 * 1024 * 1024) },
  { issue: "data-attach", file: "binary-sample.bin", bytes: () => seededBytes(3, 64 * 1024) },
  { issue: "data-attach", file: "notes (final) [v2].md", bytes: () => encoder.encode("# Notes\n\nFinal notes, version 2.\n") },
];

const ROUTING_PROPERTY = {
  version: 3,
  tiers: [
    { name: "gold", limits: { rps: 1200, burst: { window_s: 10, rps: 2400 } } },
    { name: "silver", limits: { rps: 400, burst: { window_s: 10, rps: 340 } } },
    { name: "bronze", limits: { rps: 50, burst: { window_s: 5, rps: 80 } } },
  ],
  fallback: { region: "eu-central-1", chain: ["a", ["b", ["c", { d: null }]]] },
};

// ---------------------------------------------------------------------------------------------------------------------
// State: what exists on the site

interface Known {
  key: string;
  summary: string;
  type: string;
  status: string;
  parent: string;
  labels: string[];
  priority: string;
}

const known = new Map<string, Known>();

function keyOf(id: string): string {
  const entry = known.get(id);
  if (!entry) {
    throw new AtlFailure(`no issue known for ${id}`);
  }
  return entry.key;
}

function parseKnown(raw: Obj): { id: string; entry: Known } | null {
  const fields = isRecord(raw.fields) ? raw.fields : {};
  const labels = asArray(fields.labels).map(asString);
  const idLabel = labels.find((l) => l.startsWith("nm-id-"));
  if (!idLabel) {
    return null;
  }
  const status = isRecord(fields.status) ? asString(fields.status.name) : "";
  const type = isRecord(fields.issuetype) ? asString(fields.issuetype.name) : "";
  const parent = isRecord(fields.parent) ? asString(fields.parent.key) : "";
  const priority = isRecord(fields.priority) ? asString(fields.priority.name) : "";
  return {
    id: idLabel.slice("nm-id-".length),
    entry: { key: asString(raw.key), summary: asString(fields.summary), type, status, parent, labels, priority },
  };
}

async function loadKnown(): Promise<void> {
  known.clear();
  let cursor = "";
  for (;;) {
    const argv = [
      "jql",
      `project = ${PROJECT} AND labels = ${ROOT_LABEL} ORDER BY key ASC`,
      "--full",
      "--issue-fields",
      "summary,labels,status,issuetype,parent,priority",
      "--limit",
      "100",
    ];
    if (cursor) {
      argv.push("--cursor", cursor);
    }
    const page = await atl("jql nightmare issues", argv, { read: true });
    for (const raw of items(page)) {
      const parsed = parseKnown(raw);
      if (parsed) {
        known.set(parsed.id, parsed.entry);
      }
    }
    cursor = isRecord(page) ? asString(page.nextCursor) : "";
    if (!cursor) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Phases

async function tempFile(name: string, content: string): Promise<string> {
  const path = join(OUT_DIR, "tmp", name);
  await Bun.write(path, content);
  return path;
}

async function phaseCreate(): Promise<void> {
  for (const spec of specs) {
    if (known.has(spec.id)) {
      continue;
    }
    const summary = `${PREFIX}${spec.summary}`;
    const argv = ["issue", "create", "--project", PROJECT, "--type", spec.type, "--summary", summary];
    if (spec.parent) {
      argv.push("--parent", keyOf(spec.parent));
    }
    if (spec.body) {
      argv.push("--file", await tempFile(`${spec.id}.md`, spec.body));
    }
    const labels = [ROOT_LABEL, `nm-id-${spec.id}`, ...(spec.labels ?? [])];
    argv.push("--set", `labels=${JSON.stringify(labels)}`);
    if (spec.priority && spec.type !== "Subtask") {
      argv.push("--set", `priority=${JSON.stringify({ name: spec.priority })}`);
    }
    if (spec.due) {
      argv.push("--set", `duedate=${spec.due}`);
    }
    if (spec.start) {
      argv.push("--set", `customfield_10015=${spec.start}`);
    }
    if (spec.flagged) {
      argv.push("--set", `customfield_10021=${JSON.stringify([{ value: "Impediment" }])}`);
    }
    const created = await soft(`create ${spec.id}`, () =>
      atl(`create ${spec.id}`, argv, {
        landed: async () => {
          await Bun.sleep(4000);
          await loadKnown();
          return known.has(spec.id);
        },
      }),
    );
    if (created === null) {
      continue;
    }
    if (!known.has(spec.id)) {
      const key = isRecord(created) ? asString(created.key) : "";
      if (!key) {
        findings.push({ label: `create ${spec.id}`, argv: [], exitCode: 0, code: "no_key", message: `create output had no key: ${JSON.stringify(created).slice(0, 200)}`, handling: "gave-up" });
        continue;
      }
      known.set(spec.id, { key, summary, type: spec.type, status: "Teendő", parent: spec.parent ? keyOf(spec.parent) : "", labels, priority: spec.priority ?? "" });
    }
    log(`created ${spec.id} -> ${keyOf(spec.id)}`);
  }
}

async function phaseRestructure(): Promise<void> {
  // Re-parenting through issue edit (parent field).
  for (const spec of specs) {
    const entry = known.get(spec.id);
    if (!entry || !spec.finalParent || spec.finalType || entry.type === "Subtask") {
      continue;
    }
    const target = keyOf(spec.finalParent);
    if (entry.parent !== target) {
      await soft(`reparent ${spec.id}`, async () => {
        await atl(`reparent ${spec.id}`, ["issue", "edit", entry.key, "--set", `parent=${JSON.stringify({ key: target })}`]);
        entry.parent = target;
      });
    }
  }
  // Bulk move: task -> subtask under one parent, one call per parent.
  const bulk = new Map<string, string[]>();
  for (const spec of specs) {
    const entry = known.get(spec.id);
    if (entry && spec.viaBulkMove && spec.finalType && spec.finalParent && entry.type !== spec.finalType) {
      bulk.set(spec.finalParent, [...(bulk.get(spec.finalParent) ?? []), entry.key]);
    }
  }
  for (const [parent, keys] of bulk) {
    await soft(`bulk move ${parent}`, async () => {
      await atl(`bulk move ${parent}`, ["bulk", "move", ...keys, "--project", PROJECT, "--type", "Subtask", "--parent", keyOf(parent)]);
    });
  }
  // Single converts.
  for (const spec of specs) {
    const entry = known.get(spec.id);
    if (!entry || !spec.finalType || spec.viaBulkMove || entry.type === spec.finalType) {
      continue;
    }
    const argv = ["issue", "convert", entry.key, "--type", spec.finalType];
    if (spec.finalType === "Subtask" && spec.finalParent) {
      argv.push("--parent", keyOf(spec.finalParent));
    }
    await soft(`convert ${spec.id}`, () => atl(`convert ${spec.id}`, argv));
  }
  await Bun.sleep(3000);
  await loadKnown();
}

async function phaseBulkEdit(): Promise<void> {
  const platformKeys = specs.filter((s) => s.id.startsWith("plat-chain-")).map((s) => keyOf(s.id));
  const missingLabel = platformKeys.filter((k) => !labelsOf(k).includes("nm-bulk-tagged"));
  if (missingLabel.length > 0) {
    await soft("bulk edit labels", () => atl("bulk edit labels", ["bulk", "edit", ...missingLabel, "--add-labels", "nm-bulk-tagged"]));
  }
  // Priorities: set through bulk edit for the issues whose priority is not what the spec says.
  const wanted = new Map<Priority, string[]>();
  for (const spec of specs) {
    const entry = known.get(spec.id);
    if (entry && spec.priority && entry.priority && entry.priority !== spec.priority) {
      wanted.set(spec.priority, [...(wanted.get(spec.priority) ?? []), entry.key]);
    }
  }
  for (const [priority, keys] of wanted) {
    await soft(`bulk edit priority ${priority}`, () => atl(`bulk edit priority ${priority}`, ["bulk", "edit", ...keys, "--priority", priority]));
  }
  await Bun.sleep(2000);
  await loadKnown();
}

function labelsOf(key: string): string[] {
  for (const entry of known.values()) {
    if (entry.key === key) {
      return entry.labels;
    }
  }
  return [];
}

async function phaseStatus(): Promise<void> {
  // Bulk transitions first: one call per target status for the issues that opted in.
  const groups = new Map<Status, string[]>();
  for (const spec of specs) {
    const entry = known.get(spec.id);
    if (entry && spec.viaBulkTransition && spec.status && entry.status !== spec.status) {
      groups.set(spec.status, [...(groups.get(spec.status) ?? []), entry.key]);
    }
  }
  for (const [status, keys] of groups) {
    await soft(`bulk transition ${status}`, async () => {
      await atl(`bulk transition ${status}`, ["bulk", "transition", ...keys, "--transition", TRANSITION_ID[status]]);
      for (const spec of specs) {
        const entry = known.get(spec.id);
        if (entry && keys.includes(entry.key)) {
          entry.status = status;
        }
      }
    });
  }
  for (const spec of specs) {
    const entry = known.get(spec.id);
    if (!entry || !spec.status || HISTORY[spec.id] || entry.status === spec.status) {
      continue;
    }
    await soft(`move ${spec.id}`, async () => {
      await atl(`move ${spec.id}`, ["issue", "move", entry.key, TRANSITION_ID[spec.status ?? "Teendő"]]);
      entry.status = spec.status ?? entry.status;
    });
  }
}

async function statusChangeCount(key: string): Promise<number> {
  const changelog = await atl(`changelog ${key}`, ["issue", "changelog", key, "--full"], { read: true });
  const text = JSON.stringify(changelog);
  return (text.match(/"field":"status"/g) ?? []).length;
}

async function phaseHistory(): Promise<void> {
  for (const [id, plan] of Object.entries(HISTORY)) {
    const entry = known.get(id);
    if (!entry) {
      continue;
    }
    await soft(`history ${id}`, async () => {
      const done = await statusChangeCount(entry.key);
      for (const [step, status] of plan.path.entries()) {
        if (step < done) {
          continue;
        }
        await atl(`history ${id} step ${step + 1}`, [
          "issue",
          "move",
          entry.key,
          TRANSITION_ID[status],
          "--comment",
          `nm history step ${step + 1}: ${status}`,
        ]);
        if (plan.renameAfter && plan.renameAfter.step === step + 1) {
          await atl(`rename ${id}`, ["issue", "edit", entry.key, "--summary", `${PREFIX}${plan.renameAfter.summary}`]);
        }
      }
      entry.status = plan.path.at(-1) ?? entry.status;
    });
  }
}

const linkCache = new Map<string, Obj[]>();

async function linksOf(key: string): Promise<Obj[]> {
  const cached = linkCache.get(key);
  if (cached) {
    return cached;
  }
  const result = items(await atl(`links ${key}`, ["issue", "links", key], { read: true }));
  linkCache.set(key, result);
  return result;
}

async function phaseLinks(): Promise<void> {
  for (const spec of linkSpecs) {
    const from = keyOf(spec.from);
    const to = keyOf(spec.to);
    const existing = await linksOf(from);
    if (existing.some((l) => asString(l.relation).toLowerCase() === spec.relation && asString(l.key) === to)) {
      continue;
    }
    await soft(`link ${spec.from} ${spec.relation} ${spec.to}`, async () => {
      await atl(`link ${spec.from} ${spec.relation} ${spec.to}`, ["issue", "link", from, spec.relation, to]);
      linkCache.delete(from);
      linkCache.delete(to);
    });
  }
}

async function phaseRemoteLinks(): Promise<void> {
  const perIssue = new Map<string, number>();
  const existingByIssue = new Map<string, string>();
  for (const spec of remoteLinks) {
    const n = (perIssue.get(spec.issue) ?? 0) + 1;
    perIssue.set(spec.issue, n);
    const key = keyOf(spec.issue);
    const globalId = `nm:${spec.issue}:${n}`;
    let existing = existingByIssue.get(spec.issue);
    if (existing === undefined) {
      existing = JSON.stringify(await atl(`remote links ${key}`, ["issue", "links", key, "--remote", "--full"], { read: true }));
      existingByIssue.set(spec.issue, existing);
    }
    if (existing.includes(globalId)) {
      continue;
    }
    const argv = ["issue", "remote-link", "add", key, "--url", spec.url, "--title", spec.title, "--global-id", globalId];
    if (spec.relationship) {
      argv.push("--relationship", spec.relationship);
    }
    if (spec.summary) {
      argv.push("--summary", spec.summary);
    }
    await soft(`remote-link ${spec.issue} ${n}`, () => atl(`remote-link ${spec.issue} ${n}`, argv));
  }
}

async function commentsOf(key: string): Promise<Obj[]> {
  return items(await atl(`comments ${key}`, ["issue", "comments", key, "--all", "--full"], { read: true }));
}

async function phaseComments(): Promise<void> {
  const key = keyOf("pay-thread");
  await soft("thread comments", async () => {
    let existing = await commentsOf(key);
    for (let n = existing.length + 1; n <= THREAD_COMMENT_COUNT; n++) {
      const file = await tempFile(`thread-${n}.md`, threadComment(n));
      const expected = n;
      await atl(`comment ${n}`, ["issue", "comment", key, "--file", file], {
        landed: async () => (await commentsOf(key)).length >= expected,
      });
    }
    existing = await commentsOf(key);
    const target = existing[THREAD_EDIT_COMMENT - 1];
    if (target && !JSON.stringify(target).includes("Correction")) {
      const file = await tempFile("thread-edit.md", THREAD_EDIT_BODY);
      await atl("edit comment 27", ["issue", "comment", key, "--edit", asString(target.id), "--file", file]);
    }
  });
  // Short threads with edits on other issues.
  const small: [string, string[]][] = [
    ["comp-access-review", ["Evidence collected for the access review.", "Auditor asked for the IAM export again."]],
    ["plat-chain-07", ["Is legal blocking this? No, see the chain."]],
    ["pay-dup-b", ["Closing as a duplicate of the payments-gw issue."]],
  ];
  for (const [id, bodies] of small) {
    const issue = keyOf(id);
    await soft(`comments ${id}`, async () => {
      const existing = await commentsOf(issue);
      for (const [n, body] of bodies.entries()) {
        if (n < existing.length) {
          continue;
        }
        await atl(`comment ${id} ${n + 1}`, ["issue", "comment", issue, "--body", body], {
          landed: async () => (await commentsOf(issue)).length > n,
        });
      }
    });
  }
}

async function worklogsOf(key: string): Promise<Obj[]> {
  return items(await atl(`worklogs ${key}`, ["issue", "worklogs", key, "--all", "--full"], { read: true }));
}

async function phaseWorklogs(): Promise<void> {
  const grouped = new Map<string, WorklogSpec[]>();
  for (const w of worklogSpecs) {
    grouped.set(w.issue, [...(grouped.get(w.issue) ?? []), w]);
  }
  for (const [id, entries] of grouped) {
    const key = keyOf(id);
    await soft(`worklogs ${id}`, async () => {
      const have = (await worklogsOf(key)).length;
      for (const [n, w] of entries.entries()) {
        if (n < have) {
          continue;
        }
        await atl(`log ${id} ${n + 1}`, ["issue", "log", key, w.time, "--started", w.started, "--comment", w.comment], {
          landed: async () => (await worklogsOf(key)).length > n,
        });
      }
    });
  }
}

async function phaseWatchersAndProperties(): Promise<void> {
  for (const id of ["pay-thread", "plat-chain-01", "comp-access-review", "mob-story-a", "data-props", "legal-rel"]) {
    await soft(`watch ${id}`, () => atl(`watch ${id}`, ["issue", "watch", keyOf(id)]));
  }
  const routing = await tempFile("routing.json", JSON.stringify(ROUTING_PROPERTY));
  await soft("property routing", () => atl("property routing", ["property", "set", "issue", keyOf("data-props"), "nm.routing", "--file", routing]));
  await soft("property meta", () =>
    atl("property meta", ["property", "set", "issue", keyOf("data-props"), "nm.owner", "--value", JSON.stringify({ team: "data-platform", oncall: ["nóra", "béla"] })]),
  );
  await soft("property pay-thread", () =>
    atl("property pay-thread", ["property", "set", "issue", keyOf("pay-thread"), "nm.war-room", "--value", JSON.stringify({ phase: 3, flags: { freeze: true } })]),
  );
  const thread = await commentsOf(keyOf("pay-thread"));
  const commentId = asString(thread[30]?.id);
  if (commentId) {
    await soft("property comment", () =>
      atl("property comment", ["property", "set", "comment", commentId, "nm.review", "--value", JSON.stringify({ reviewed: true, by: "nm-seed" })]),
    );
  }
  const worklog = (await worklogsOf(keyOf("pay-wl-story")))[0];
  if (worklog) {
    await soft("property worklog", () =>
      atl("property worklog", ["property", "set", "worklog", asString(worklog.id), "nm.audit", "--issue", keyOf("pay-wl-story"), "--value", '"checked"']),
    );
  }
}

async function phaseAttachments(): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true });
  const perIssue = new Map<string, AttachmentSpec[]>();
  for (const a of attachmentSpecs) {
    perIssue.set(a.issue, [...(perIssue.get(a.issue) ?? []), a]);
  }
  for (const [id, entries] of perIssue) {
    const key = keyOf(id);
    const existing = items(await atl(`attachments ${key}`, ["issue", "attachments", key], { read: true })).map((a) => asString(a.filename));
    const remaining = [...existing];
    for (const a of entries) {
      const base = a.file.split("/").pop() ?? a.file;
      const at = remaining.indexOf(base);
      if (at >= 0) {
        remaining.splice(at, 1);
        continue;
      }
      const path = join(FILES_DIR, a.file);
      await Bun.write(path, a.bytes());
      await soft(`attach ${a.file}`, () =>
        atl(`attach ${a.file}`, ["issue", "attachment", "add", key, path], {
          landed: async () => items(await atl(`attachments ${key}`, ["issue", "attachments", key], { read: true })).some((x) => asString(x.filename) === base),
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifest

interface Fact {
  id: string;
  question: string;
  answer: string;
  where: string;
  whyHard: string;
}

async function groupCounts(jql: string): Promise<Record<string, number>> {
  const result = await atl("jql group-by status", ["jql", jql, "--group-by", "status"], { read: true });
  const groups = isRecord(result) && isRecord(result.groups) ? result.groups : {};
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(groups)) {
    counts[name] = typeof value === "number" ? value : 0;
  }
  return counts;
}

async function buildManifest(): Promise<void> {
  const k = keyOf;
  const facts: Fact[] = [];
  const checks: string[] = [];

  // Epic children for the status count and the worklog total.
  const epicMobile = k("epic-mob");
  const mobileCounts = await groupCounts(`project = ${PROJECT} AND labels = ${ROOT_LABEL} AND (parent = ${epicMobile} OR parent in (${specs.filter((s) => s.type !== "Eposz" && (s.finalParent ?? s.parent) === "epic-mob").map((s) => k(s.id)).join(",")}))`);
  const expectedMobile: Record<string, number> = {};
  for (const spec of specs) {
    const parent = spec.finalParent ?? spec.parent;
    const inMobile = parent === "epic-mob" || (parent && (byId.get(parent)?.finalParent ?? byId.get(parent)?.parent) === "epic-mob");
    if (inMobile) {
      const status = spec.status ?? "Teendő";
      expectedMobile[status] = (expectedMobile[status] ?? 0) + 1;
    }
  }
  const liveMobile = JSON.stringify(Object.entries(mobileCounts).toSorted(([a], [b]) => a.localeCompare(b)));
  if (liveMobile !== JSON.stringify(Object.entries(expectedMobile).toSorted(([a], [b]) => a.localeCompare(b)))) {
    checks.push(`mobile status counts differ: live ${liveMobile} vs spec ${JSON.stringify(expectedMobile)}`);
  }

  const paymentIds = new Set(
    specs.filter((s) => s.id.startsWith("pay-") || s.id.startsWith("epic-pay")).map((s) => s.id),
  );
  const paymentMinutes = worklogSpecs.filter((w) => paymentIds.has(w.issue)).reduce((sum, w) => sum + minutesOf(w.time), 0);
  let liveMinutes = 0;
  for (const id of paymentIds) {
    for (const w of await worklogsOf(k(id))) {
      const seconds = typeof w.timeSpentSeconds === "number" ? w.timeSpentSeconds : 0;
      liveMinutes += seconds / 60;
    }
  }
  if (liveMinutes !== paymentMinutes) {
    checks.push(`payments worklog total differs: live ${liveMinutes}m vs spec ${paymentMinutes}m`);
  }

  const chainRoot = k("plat-chain-14");
  const chain = await atl("chain walk", ["issue", "links", k("plat-chain-01"), "--chain", "is blocked by", "--max", "30"], { read: true });
  if (!JSON.stringify(chain).includes(chainRoot)) {
    checks.push(`chain walk from ${k("plat-chain-01")} did not reach ${chainRoot}: ${JSON.stringify(chain).slice(0, 300)}`);
  }
  const history = HISTORY["comp-history"];
  if (!history) {
    throw new Error("comp-history plan missing");
  }
  const intoProgress = history.path.filter((s) => s === "Folyamatban").length;
  const liveChanges = await statusChangeCount(k("comp-history"));
  if (liveChanges !== history.path.length) {
    checks.push(`comp-history status changes: live ${liveChanges} vs spec ${history.path.length}`);
  }
  const changelog = items(await atl("changelog comp-history", ["issue", "changelog", k("comp-history")], { read: true }));
  const lastDone = changelog.findLast((entry) => {
    const text = JSON.stringify(entry);
    return text.includes('"field":"status"') && text.includes('"to":"Done"');
  });
  const lastDoneAt = lastDone ? `${asString(lastDone.at)} by ${asString(lastDone.by)}` : "unknown";
  const attachmentNames = items(await atl("attachments data-attach", ["issue", "attachments", k("data-attach"), "--full"], { read: true }));
  const largest = attachmentNames.reduce<Obj | null>((best, a) => {
    const size = typeof a.size === "number" ? a.size : 0;
    const bestSize = best && typeof best.size === "number" ? best.size : -1;
    return size > bestSize ? a : best;
  }, null);
  if (largest && asString(largest.filename) !== LARGEST_ATTACHMENT) {
    checks.push(`largest attachment is ${asString(largest.filename)}, spec says ${LARGEST_ATTACHMENT}`);
  }

  facts.push(
    {
      id: "chain-root",
      question: `Follow the "is blocked by" links starting at ${k("plat-chain-01")} to the end of the chain. Which issue is the root blocker and what is blocking it?`,
      answer: `${chainRoot} (14th hop): the HSM firmware signing key for cluster fra-3 expired on 2026-09-30; renewal ticket REN-4471`,
      where: `${k("plat-chain-01")} .. ${chainRoot} (13 hops of "is blocked by"); fact in ${chainRoot} description`,
      whyHard: "13 sequential link hops; the intermediate issues look interchangeable and plat-chain-07 explicitly mentions legal review as a red herring",
    },
    {
      id: "thread-31st-comment",
      question: `On ${k("pay-thread")}, what rollback window (minutes) does the 31st comment state?`,
      answer: "47 minutes (runbook RB-914, step 6). Comment 4 says about 30 minutes: that is the superseded early estimate",
      where: `${k("pay-thread")} comment #31 of ${THREAD_COMMENT_COUNT}`,
      whyHard: "needs pagination past 30 comments and a decoy estimate in comment 4",
    },
    {
      id: "thread-edited-vendor",
      question: `Which vendor supplies the HSM according to the latest information on ${k("pay-thread")}?`,
      answer: "Borealis Cryptography. Comment 12 says Acme Secure; comment 27 was edited to correct it",
      where: `${k("pay-thread")} comments 12 and 27 (27 edited via issue comment --edit)`,
      whyHard: "an earlier comment states the opposite; only the edited later comment is correct",
    },
    {
      id: "ratecard-cell",
      question: `In the rate card table in the description of ${k("pay-bigdesc")}, what is the settlement fee (bps) for ${RATE_CARD_TARGET_MERCHANT}?`,
      answer: `${RATE_CARD_TARGET_FEE} bps`,
      where: `${k("pay-bigdesc")} description, table row 131 of 180 (20 KB description)`,
      whyHard: "value only exists deep inside a 20 KB description table that contains escaped pipes in neighbouring cells",
    },
    {
      id: "history-count",
      question: `How many times did ${k("comp-history")} enter the status Folyamatban (In Progress), and what was its original summary?`,
      answer: `${intoProgress} times (changelog names it "In Progress"); original summary "Draft: retention policy review" (renamed to "Retention policy review (final)"; the changelog stores the prefixed summary)`,
      where: `${k("comp-history")} changelog (${history.path.length} status changes, one summary change)`,
      whyHard: "requires the changelog, not the current state; status names are Hungarian",
    },
    {
      id: "history-who-when",
      question: `Who moved ${k("comp-history")} to Kész the last time, and when (changelog)?`,
      answer: `${lastDoneAt} (account 62a219658783e7006f627f3b). It was Done once before, then reopened to In Progress. The changelog uses English status names and records a resolution change`,
      where: `${k("comp-history")} changelog`,
      whyHard: "the issue went to Kész twice with a reopen in between; the last transition is needed",
    },
    {
      id: "payments-worklog-total",
      question: `What is the total time logged on all issues under the Payments epic ${k("epic-pay")} (children and sub-tasks)?`,
      answer: `${Math.floor(paymentMinutes / 60)}h ${paymentMinutes % 60}m (${paymentMinutes} minutes)`,
      where: `worklogs on ${[...new Set(worklogSpecs.filter((w) => paymentIds.has(w.issue)).map((w) => k(w.issue)))].join(", ")}`,
      whyHard: "worklogs spread over stories and sub-tasks with mixed hour/minute units; worklogs on Mobile/Platform issues are noise",
    },
    {
      id: "mobile-status-counts",
      question: `Count the issues under the Mobile epic ${epicMobile} (including sub-tasks and the re-parented task) per status.`,
      answer: JSON.stringify(expectedMobile),
      where: `${epicMobile} children and their sub-tasks`,
      whyHard: "needs two hierarchy levels; one child arrived by re-parenting from the Platform epic; statuses are Hungarian",
    },
    {
      id: "near-duplicate",
      question: `Two issues are called "Migrate billing ledger to Postgres 15/16". Which one is still in progress, what is its key and cutover date?`,
      answer: `${k("plat-pg16")} (Postgres 16), Folyamatban, cutover 2027-02-14; ${k("plat-pg15")} is Kész with cutover 2026-03-01`,
      where: `${k("plat-pg15")} vs ${k("plat-pg16")}`,
      whyHard: "summaries differ by one character",
    },
    {
      id: "same-summary-two-epics",
      question: `Two issues are both titled "Quarterly access review", one under the Compliance epic and one under Legal. Which one names Kovács & Partners Kft. as auditor?`,
      answer: `${k("comp-access-review")} (Compliance epic ${k("epic-comp")}); ${k("legal-access-review")} names Nagy Ügyvédi Iroda`,
      where: `${k("comp-access-review")}, ${k("legal-access-review")}`,
      whyHard: "identical summaries; the answer is in the description and the parent epic",
    },
    {
      id: "cycle",
      question: `${k("plat-cycle-a")} blocks ${k("plat-cycle-b")}. Following "blocks" repeatedly, where do you end up and how many issues are in the loop?`,
      answer: `Back at ${k("plat-cycle-a")}; 3 issues in the cycle (${k("plat-cycle-a")} -> ${k("plat-cycle-b")} -> ${k("plat-cycle-c")} -> ${k("plat-cycle-a")})`,
      where: "three issues linked in a circle",
      whyHard: "naive link-following loops forever",
    },
    {
      id: "diamond",
      question: `How many distinct issues (transitively) block ${k("plat-diamond-top")}, and which of them are not Kész?`,
      answer: `3 (${k("plat-diamond-left")}, ${k("plat-diamond-right")}, ${k("plat-diamond-bottom")}); only ${k("plat-diamond-right")} is not Kész (Folyamatban)`,
      where: `${k("plat-diamond-top")} links`,
      whyHard: "bottom is reachable by two paths; counting it twice gives 4",
    },
    {
      id: "attachment-largest",
      question: `What is the filename of the largest attachment on ${k("data-attach")}, and how many attachments are named report.csv?`,
      answer: `${LARGEST_ATTACHMENT} (2097152 bytes); 2 attachments named report.csv (different content)`,
      where: `${k("data-attach")} attachments`,
      whyHard: "duplicate filenames and a unicode/emoji filename among the attachments",
    },
    {
      id: "nested-property",
      question: `In the issue property nm.routing of ${k("data-props")}, what is the burst rps of the silver tier?`,
      answer: "340 (tiers[1].limits.burst.rps); the plain rps limit is 400",
      where: `${k("data-props")} property nm.routing`,
      whyHard: "nested JSON; two similar numbers per tier",
    },
    {
      id: "remote-link-supersedes",
      question: `Which web link on ${k("data-links")} has the relationship "supersedes", and what is its URL?`,
      answer: '"Old runbook (retired)": https://example.com/runbooks/old-v1',
      where: `${k("data-links")} remote links (6 on the issue)`,
      whyHard: "several web links per issue; relationship only visible on the remote link object",
    },
    {
      id: "reparented",
      question: `Which epic does ${k("plat-reparent")} belong to now, and which epic was it created under?`,
      answer: `Now ${epicMobile} (Mobile); created under ${k("epic-plat")} (Platform)`,
      where: `${k("plat-reparent")} parent and changelog`,
      whyHard: "the summary says Platform→Mobile; the parent field and changelog are the truth",
    },
    {
      id: "converted",
      question: `What issue type is ${k("plat-convert-down")} now, and what was it created as?`,
      answer: "Now Feladat (task); created as Subtask under the secrets story",
      where: k("plat-convert-down"),
      whyHard: "type changed through issue convert; the summary hints at it",
    },
    {
      id: "odd-label",
      question: "Which issue carries the label ünïcode-lábel?",
      answer: k("data-labels"),
      where: `${k("data-labels")} labels`,
      whyHard: "unicode label in JQL needs quoting",
    },
    {
      id: "flagged",
      question: "Which nightmare issue is flagged as Impediment and what is its start date?",
      answer: `${k("data-flagged")}, start date 2026-10-01`,
      where: `${k("data-flagged")} customfield_10021 / customfield_10015`,
      whyHard: "custom fields with opaque ids and localized names",
    },
    {
      id: "overdue",
      question: "As of 2026-10-22, how many nightmare issues have a due date before that day and are not in a done status?",
      answer: `3 (${k("comp-overdue-1")}, ${k("comp-overdue-2")}, ${k("legal-every-1")}); ${k("comp-overdue-3")} is overdue but Kész`,
      where: "duedate field; JQL duedate < 2026-10-22 AND statusCategory != Done AND labels = nightmare",
      whyHard: "issue get does not show the due date; it needs jql --issue-fields duedate or a JQL filter",
    },
    {
      id: "deep-list-leaf",
      question: `What is the deepest leaf value in the nested list of ${k("comp-adf-lists")}?`,
      answer: "NM-DEEP-LEAF-5521 (level 5 of the bullet list)",
      where: `${k("comp-adf-lists")} description`,
      whyHard: "five nesting levels of ADF lists",
    },
  );

  const issues: Record<string, { key: string; summary: string; type: string; status: string }> = {};
  const finalKnown = await (async () => {
    await loadKnown();
    return known;
  })();
  for (const [id, entry] of finalKnown) {
    issues[id] = { key: entry.key, summary: entry.summary, type: entry.type, status: entry.status };
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    site: "foldvarszki.atlassian.net",
    project: PROJECT,
    prefix: PREFIX,
    labels: [ROOT_LABEL],
    issueCount: finalKnown.size,
    expectedIssueCount: specs.length,
    issues,
    facts,
    consistencyChecks: checks,
    findings,
    atlCalls: calls,
  };
  await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest written: ${MANIFEST_PATH} (${finalKnown.size}/${specs.length} issues, ${facts.length} facts, ${checks.length} check failures, ${findings.length} findings)`);
}

// ---------------------------------------------------------------------------------------------------------------------

const PHASES: [string, () => Promise<void>][] = [
  ["create", phaseCreate],
  ["restructure", phaseRestructure],
  ["bulkedit", phaseBulkEdit],
  ["status", phaseStatus],
  ["history", phaseHistory],
  ["links", phaseLinks],
  ["remote", phaseRemoteLinks],
  ["comments", phaseComments],
  ["worklogs", phaseWorklogs],
  ["props", phaseWatchersAndProperties],
  ["attachments", phaseAttachments],
];

async function main(): Promise<void> {
  await mkdir(join(OUT_DIR, "tmp"), { recursive: true });
  const only = process.env.NM_PHASES?.split(",");
  await loadKnown();
  log(`${known.size}/${specs.length} issues already exist`);
  for (const [name, run] of PHASES) {
    if (only && !only.includes(name)) {
      continue;
    }
    log(`phase ${name}`);
    await soft(`phase ${name}`, run);
  }
  await soft("manifest", buildManifest);
}

await main();
