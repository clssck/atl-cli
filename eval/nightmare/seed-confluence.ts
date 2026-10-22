#!/usr/bin/env bun
/**
 * Seed a "corporate nightmare" Confluence corpus in SZOFTVERFE (plus a few pages in the personal
 * space) with the frozen atl binary, and write ground truth to eval/.out/nightmare/confluence.json.
 *
 * Usage: bun eval/nightmare/seed-confluence.ts [--dry] [--only=group,group] [--no-huge]
 *   --dry       print the plan (page/comment/fact counts) and send nothing
 *   --only=...  run only the listed page groups (parents are created on demand); comments, properties
 *               and probes run only when their page group is selected
 *   --no-huge   skip the 300 KB page
 *
 * Idempotent: pages are found by exact title (registry built from `space pages --all`), history pages
 * are topped up to their target version, comments carry an `(nm:<tag>)` marker and are found by it.
 * Every created title starts with "atl smoke nm ". The token has no Confluence delete scope, so the
 * owner removes the corpus in the UI by that prefix.
 *
 * Requests are paced; exit 3 (429/5xx/timeout/409) on a write restarts the (idempotent) unit of work
 * after a backoff, on a read retries the read.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

/** The eval binary (built per eval/README.md); `NM_ATL` points at another one. */
const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const SITE_URL = "https://foldvarszki.atlassian.net";
const SPACE = "SZOFTVERFE";
const PERSONAL = "~62a219658783e7006f627f3b";
const HOME_PAGE = "196724";
const PERSONAL_HOME = "163933";
const PREFIX = "atl smoke nm ";
const PACE_MS = 250;
const MAX_ATTEMPTS = 6;
const HUGE_BYTES = 300 * 1024;
const OUT = join(import.meta.dir, "..", ".out", "nightmare");
const BODIES = join(OUT, "bodies-confluence");
const MANIFEST = join(OUT, "confluence.json");
const FENCE = "`".repeat(3);
const ZWSP = "\u200B";
const NBSP = "\u00A0";

// ---------------------------------------------------------------------------
// JSON plumbing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

class Transient extends Error {}
class Failure extends Error {
  readonly code: string;
  readonly argv: readonly string[];
  constructor(message: string, code: string, argv: readonly string[]) {
    super(message);
    this.code = code;
    this.argv = argv;
  }
}

function rec(value: unknown, what: string): Json {
  if (!isRecord(value)) {
    throw new Error(`${what}: expected an object`);
  }
  return value;
}

function str(obj: Json, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`expected string at ${key}`);
  }
  return value;
}

function optStr(obj: Json, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function num(obj: Json, key: string): number {
  const value = obj[key];
  if (typeof value !== "number") {
    throw new Error(`expected number at ${key}`);
  }
  return value;
}

function items(obj: Json): Json[] {
  const value = obj.items;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function bodyText(obj: Json): string {
  const body = obj.body;
  if (Array.isArray(body)) {
    return body.filter((line): line is string => typeof line === "string").join("\n");
  }
  return typeof body === "string" ? body : "";
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let calls = 0;
const failures: { phase: string; what: string; code: string; message: string; argv: readonly string[] }[] = [];
const observations: { id: string; repro: readonly string[]; expected: string; actual: string }[] = [];

async function spawnAtl(args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([ATL, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function describeFailure(run: Run): { code: string; message: string } {
  for (const text of [run.stderr, run.stdout]) {
    for (const line of text.trim().split("\n").toReversed()) {
      if (!line.startsWith("{")) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed) && typeof parsed.code === "string") {
          return { code: parsed.code, message: (typeof parsed.message === "string" ? parsed.message : parsed.code).slice(0, 400) };
        }
      } catch {
        // not a diagnostic line
      }
    }
  }
  return { code: `exit_${run.exitCode}`, message: (run.stderr.trim() || run.stdout.trim()).slice(0, 400) };
}

/** One atl call. Reads retry on exit 3; a write throws Transient so its caller can re-check state first. */
async function atl(args: readonly string[], write = false): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    await Bun.sleep(PACE_MS);
    const run = await spawnAtl(args);
    calls += 1;
    if (run.exitCode === 0) {
      const text = run.stdout.trim();
      return text === "" ? {} : JSON.parse(text);
    }
    const failure = describeFailure(run);
    if (run.exitCode === 3) {
      log(`exit 3 ${failure.code} on ${args.slice(0, 3).join(" ")} (attempt ${attempt})`);
      if (write) {
        throw new Transient(failure.message);
      }
      if (attempt < MAX_ATTEMPTS) {
        await Bun.sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
    }
    throw new Failure(failure.message, failure.code, args);
  }
}

function log(message: string): void {
  process.stderr.write(`[seed-confluence] ${message}\n`);
}

/** Bodies go through files: argv is safe from shell interpolation, but a body may start with `-`. */
function bodyFile(text: string): string {
  mkdirSync(BODIES, { recursive: true });
  const path = join(BODIES, `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.md`);
  writeFileSync(path, text);
  return path;
}

function bodyArgs(text: string): string[] {
  return text === "" ? ["--body", ""] : ["--file", bodyFile(text)];
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

interface Ctx {
  id(key: string): string;
  url(key: string): string;
}
type Body = string | ((ctx: Ctx) => string);

interface Step {
  body?: Body;
  title?: string;
  message?: string;
  restore?: number;
}

interface PageSpec {
  key: string;
  group: string;
  title: string;
  /** key of the parent spec, or "home" / "phome" for the two external homepages; absent for blog posts */
  parent?: string;
  moveTo?: string;
  space?: string;
  type?: "page" | "blogpost";
  /** specs whose ids the body links to; created first */
  links?: string[];
  /** steps[0] creates the page (version 1); steps[n] produces version n+1 */
  steps: Step[];
}

interface CommentSpec {
  tag: string;
  page: string;
  kind: "footer" | "inline";
  parent?: string;
  select?: string;
  match?: number;
  text: string;
  edits?: string[];
  /** final resolution of a top-level inline comment */
  final?: "resolved" | "reopened";
}

interface PropSpec {
  page: string;
  key: string;
  /** successive values; the last one is current */
  values: unknown[];
}

interface Fact {
  id: string;
  question: string;
  answer: string;
  where: string[];
  whyHard: string;
}

const specs: PageSpec[] = [];
const commentSpecs: CommentSpec[] = [];
const propSpecs: PropSpec[] = [];
const facts: Fact[] = [];

function page(spec: PageSpec): void {
  specs.push(spec);
}

function simple(key: string, group: string, title: string, parent: string, body: Body): void {
  specs.push({ key, group, title: PREFIX + title, parent, steps: [{ body }] });
}

const PEOPLE = ["Ágnes Kovács", "Bence Tóth", "Csilla Nagy", "Dávid Szabó", "Eszter Varga", "Ferenc Kiss", "Gréta Molnár"];
const HU_WORDS = [
  "Alma", "Barack", "Cseresznye", "Dió", "Eper", "Füge", "Galagonya", "Hagyma", "Ibolya", "Jázmin",
  "Körte", "Lencse", "Mák", "Narancs", "Őszibarack", "Paprika", "Retek", "Szilva", "Tök", "Ürömfű",
  "Vaníliás", "Zab", "Árpa", "Búza", "Cékla", "Dinnye", "Eperfa", "Fenyő", "Gesztenye", "Hárs",
  "Iszalag", "Jegenye", "Kökény", "Levendula", "Menta", "Nárcisz", "Orgona", "Pálma", "Rozmaring", "Tulipán",
];

/** Small deterministic generator so bodies are identical on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function nn(n: number): string {
  return String(n).padStart(2, "0");
}

function pageLink(c: Ctx, key: string, label: string): string {
  return `[${label}](${c.url(key)})`;
}

// ---------------------------------------------------------------------------
// Structure: root, departments, containers
// ---------------------------------------------------------------------------

page({
  key: "root",
  group: "core",
  title: `${PREFIX}Corporate Wiki`,
  parent: "home",
  steps: [{ body: "# Corporate Wiki\n\nRoot of the nightmare corpus." }],
});

const DEPTS: [string, string, string][] = [
  ["hr", "Emberi Erőforrások (HR)", "People operations: hiring, onboarding, leave, performance."],
  ["legal", "Jogi osztály – Legal", "Contracts, data protection agreements, compliance."],
  ["eng", "Engineering / Mérnökség", "Platform, runbooks, on-call, architecture archive."],
  ["fin", "Pénzügy – Finance", "Budgets, procurement, expenses."],
  ["sec", "Biztonság (Security)", "Incident response, vendor management, access reviews."],
];
for (const [key, title, blurb] of DEPTS) {
  simple(key, "core", title, "root", `# ${title}\n\n${blurb}\n\n| Owner | Contact |\n|---|---|\n| ${PEOPLE[DEPTS.findIndex((d) => d[0] === key)] ?? "n/a"} | ${key}@example.invalid |`);
}

// HR
simple("hr-leave", "core", "Szabadságpolitika 2026", "hr", `# Szabadságpolitika 2026\n\nAnnual leave: **25 days** (+1 per 5 years of service).\n\n| Category | Days |\n|---|---|\n| Annual | 25 |\n| Sick (paid) | 15 |\n| Parental | 168 |`);
simple("hr-parental", "core", "Parental Leave Policy", "hr", "# Parental Leave Policy\n\nSee [Szabadságpolitika](#). Paternity leave is 10 working days.");
simple("hr-itsupport", "core", "IT Support", "hr", "# IT Support\n\nHelpdesk: +36 1 555 0100.");
simple("hr-perf", "core", "Teljesítményértékelés", "hr", "# Teljesítményértékelés\n\nÉves értékelés: november. Félévi: május.");
page({
  key: "onboarding",
  group: "core",
  title: `${PREFIX}Új belépők – Onboarding`,
  parent: "hr",
  moveTo: "eng",
  steps: [
    { body: "# Új belépők – Onboarding\n\nLaptop pickup: **Desk 4B**, first floor.\n\n- [ ] Badge\n- [ ] Laptop\n- [ ] VPN token" },
    { title: `${PREFIX}Onboarding Checklist`, message: "Rename to English title" },
    { body: "# Onboarding Checklist\n\nLaptop pickup: **Desk 9C**, second floor (moved in October).\n\n- [ ] Badge\n- [ ] Laptop\n- [ ] VPN token\n- [ ] Security training", message: "Desk moved" },
  ],
});

// Legal
simple("legal-dpa", "core", "Data Processing Agreements", "legal", "# Data Processing Agreements\n\nStandard DPA template v4. Sub-processor list reviewed quarterly.");
simple("legal-templates", "core", "Szerződéssablonok", "legal", "# Szerződéssablonok\n\nNDA, MSA, SOW sablonok.");
page({
  key: "vendor-questionnaire",
  group: "core",
  title: `${PREFIX}Vendor Security Questionnaire`,
  parent: "legal",
  moveTo: "sec-vendor",
  steps: [{ body: "# Vendor Security Questionnaire\n\nSent to every vendor before contract signature. Passing score: **80 of 100**." }],
});

// Engineering
simple("eng-runbooks", "core", "Runbooks", "eng", "# Runbooks\n\nOperational procedures.");
simple("eng-deploy", "core", "Deploy Process", "eng", "# Deploy Process\n\nTrain leaves Tuesday 10:00 CET. Rollback window: 20 minutes.");
simple("eng-oncall", "core", "On-call Rotation", "eng", "# On-call Rotation\n\nWeekly rotation, six engineers.");
simple("eng-archive", "core", "Architecture Archive", "eng", "# Architecture Archive\n\nThe archive is nested deeply on purpose; start at Level 01.");
simple("eng-dupes", "core", "Systems", "eng", "# Systems\n\nInventory of internal systems.");

// Finance
simple("fin-budget", "core", "Budget 2026 Q1", "fin", "# Budget 2026 Q1\n\n| Item | EUR |\n|---|---|\n| Cloud | 120 000 |\n| Licences | 48 500 |");
simple("fin-expense", "core", "Expense Policy", "fin", "# Expense Policy\n\nReceipts needed above 25 EUR.");
simple("fin-drafts", "core", "Drafts", "fin", "# Drafts\n\nWork in progress.");
simple("fin-policies", "core", "Policies", "fin", "# Policies\n\nApproved policies.");
simple("fin-systems", "core", "Finance Systems", "fin", "# Finance Systems\n\nERP and reporting.");
page({
  key: "procurement",
  group: "core",
  title: `${PREFIX}Procurement Thresholds`,
  parent: "fin-drafts",
  moveTo: "fin-policies",
  steps: [
    { body: "# Procurement Thresholds\n\nDraft: purchases above **5 000 EUR** need two quotes." },
    { body: "# Procurement Thresholds\n\nPurchases above **10 000 EUR** need two quotes.", message: "Raise threshold" },
  ],
});

// Security
simple("sec-ir", "core", "Incident Response", "sec", "# Incident Response\n\nSeverity levels SEV1-SEV4.");
simple("sec-ir-runbooks", "core", "IR Runbooks", "sec-ir", "# IR Runbooks\n\nProcedures used during incidents.");
simple("sec-vendor", "core", "Vendor Management", "sec", "# Vendor Management\n\nVendor register and reviews.");
simple("sec-access", "core", "Access Reviews", "sec", "# Access Reviews\n\nQuarterly; owners attest in the portal.");

// ---------------------------------------------------------------------------
// Near-duplicate titles (Unicode lookalikes the API allows)
// ---------------------------------------------------------------------------

const RESTART = [
  { key: "restart-sec", title: "Restart Procedure", parent: "sec-ir-runbooks", ext: "4410", where: "Security > Incident Response > IR Runbooks" },
  { key: "restart-eng", title: `Restart${NBSP}Procedure`, parent: "eng-runbooks", ext: "7731", where: "Engineering / Mérnökség > Runbooks" },
  { key: "restart-fin", title: `Restart${ZWSP}Procedure`, parent: "fin-systems", ext: "2095", where: "Pénzügy – Finance > Finance Systems" },
  { key: "restart-hr", title: "Rest\u0430rt Procedure", parent: "hr-itsupport", ext: "5586", where: "HR > IT Support" },
  { key: "restart-sys", title: "Restart Procedure 2", parent: "eng-dupes", ext: "9902", where: "Engineering / Mérnökség > Systems" },
];
for (const r of RESTART) {
  simple(r.key, "dupes", r.title, r.parent, `# Restart Procedure\n\nStop the service, wait 30 seconds, start it again.\n\nEscalation: phone extension **${r.ext}**.`);
}
propSpecs.push(
  { page: "restart-eng", key: "nm-owner", values: [{ owner: "platform", tier: 2 }, { owner: "platform", tier: 3 }] },
  { page: "restart-sec", key: "nm-owner", values: [{ owner: "security", tier: 1 }] },
);

// ---------------------------------------------------------------------------
// Wide branch: 40 direct children, three grandchildren
// ---------------------------------------------------------------------------

simple("wide", "wide", "Wide Index", "root", "# Wide Index\n\nThis page has many children. The list is deliberately not repeated here.");
for (let i = 1; i <= 40; i++) {
  simple(`wide-${nn(i)}`, "wide", `Wide Item ${nn(i)} – ${HU_WORDS[i - 1] ?? "x"}`, "wide", `# Wide Item ${nn(i)}\n\nItem ${i} of 40: ${HU_WORDS[i - 1] ?? "x"}.`);
}
simple("wide-07-a", "wide", "Wide Item 07 sub A", "wide-07", "# Sub A\n\nGrandchild of item 07.");
simple("wide-07-b", "wide", "Wide Item 07 sub B", "wide-07", "# Sub B\n\nGrandchild of item 07.");
simple("wide-33-a", "wide", "Wide Item 33 sub A", "wide-33", "# Sub A\n\nGrandchild of item 33.");

// ---------------------------------------------------------------------------
// Ten-level chain
// ---------------------------------------------------------------------------

const LEVELS = ["Platform", "Region", "Cluster", "Namespace", "Service", "Environment", "Config", "Secrets", "Rotation", "Leaf"];
LEVELS.forEach((name, i) => {
  const parent = i === 0 ? "eng-archive" : `chain-${nn(i)}`;
  const body =
    i === LEVELS.length - 1
      ? "# Archive Level 10: Leaf\n\nRegion code: **EU-CENTRAL-7**. Secret rotation interval: every **41 days**."
      : `# Archive Level ${nn(i + 1)}: ${name}\n\nNothing here. Keep descending.`;
  simple(`chain-${nn(i + 1)}`, "chain", `Archive L${nn(i + 1)} ${name}`, parent, body);
});

// ---------------------------------------------------------------------------
// Special titles
// ---------------------------------------------------------------------------

simple("special", "special", "Special Titles", "root", "# Special Titles\n\nTitles with punctuation, scripts and look-alikes.");
const longTitle = `${"Extraordinarily long title segment ".repeat(8)}end`.slice(0, 255 - PREFIX.length);
const SPECIAL_TITLES: [string, string, string][] = [
  ["sp-emoji", "🚀 Launch Plan 🔥", "Emoji in the title."],
  ["sp-hu", "Árvíztűrő tükörfúrógép – Őszi Üzemeltetés", "Hungarian accents: ő, ű, á, é, í, ó, ö, ü."],
  ["sp-rtl", "תוכנית עבודה — خطة العمل", "Right-to-left title."],
  ["sp-long", longTitle, "Title of the maximum length."],
  ["sp-slash", "2026/Q1 Budget \\ Backslash", "Slash and backslash."],
  ["sp-html", "<script>alert(1)</script> & [brackets] {braces}", "Markup in the title is data."],
  ["sp-quotes", "'single' and “smart” quotes", "Quote variants."],
  ["sp-cql", 'title = "x" OR space = SECRET', "A title that looks like CQL."],
  ["sp-pct", "100%25 %2F encoded", "Percent sequences."],
  ["sp-id", "1572892", "A title that looks like a page id."],
  ["sp-url", "https://example.com/wiki/spaces/X/pages/123", "A title that looks like a URL."],
  ["sp-dots", "..hidden/./title..", "Dots and slashes."],
  ["sp-tilde", "~tilde ^caret |pipe| *star*", "Markdown/CQL metacharacters."],
];
for (const [key, title, body] of SPECIAL_TITLES) {
  simple(key, "special", title, "special", `# Special title\n\n${body}`);
}

// Residue of capability probes, kept in the plan so a fresh run reproduces them exactly.
page({
  key: "kw-and-or-not-2",
  group: "special",
  title: `${PREFIX}AND OR NOT 2`,
  parent: "root",
  moveTo: "qa",
  steps: [{ body: "variant probe" }, { body: "# AND OR NOT 2\n\nMoved under the Q&A page to test ancestors.", message: "Real body" }],
});
specs.push({
  key: "kw",
  group: "special",
  title: `${PREFIX}AND OR NOT`,
  parent: "root",
  steps: [
    { body: "probe" },
    { body: "The retention period is 30 days. Escalate to the duty manager after hours. Second mention: retention period.", message: "v2" },
    { restore: 1, message: "restore v1" },
    { body: "# AND OR NOT\n\nA page titled like CQL keywords. Variants of this title exist with a non-breaking space, a zero-width space, an accented A and a Cyrillic T.", message: "Real body" },
  ],
});
for (const [key, title] of [
  ["kw-nbsp", `AND${NBSP}OR NOT`],
  ["kw-zw", `AND OR NOT${ZWSP}`],
  ["kw-accent", "ÀND OR NOT"],
  ["kw-cyr", "AND OR NO\u0422"],
] as const) {
  specs.push({
    key,
    group: "special",
    title: PREFIX + title,
    parent: "root",
    steps: [{ body: "variant probe" }, { body: "# Look-alike title\n\nVisually the same as the AND OR NOT page.", message: "Real body" }],
  });
}
specs.push({
  key: "qa",
  group: "special",
  title: `${PREFIX}Q&A: What/Why? #1 100% + "quotes"`,
  parent: "root",
  steps: [{ body: "probe" }, { body: "# Q&A\n\nPunctuation-heavy title: & ? # % + / \".", message: "Real body" }],
});
specs.push({
  key: "empty",
  group: "body",
  title: `${PREFIX}Empty page`,
  parent: "body",
  steps: [{ body: "" }],
});
specs.push({
  key: "copy-probe",
  group: "history",
  title: `${PREFIX}Copy probe`,
  parent: "root",
  steps: [{ body: "probe" }, { body: "# Copy probe\n\nResidue of a `page copy` probe.", message: "Real body" }],
});

// ---------------------------------------------------------------------------
// Body stress
// ---------------------------------------------------------------------------

simple("body", "body", "Body Stress", "root", "# Body Stress\n\nPages that stress markdown to ADF conversion.");

const REGIONS = ["Frankfurt", "Budapest", "Dublin", "Paris", "Milan", "Madrid", "Vienna", "Prague", "Warsaw", "Oslo", "Zurich", "Lisbon"];
function wideTable(): string {
  const rnd = lcg(7);
  const header = ["Region", "P50 ms", "P90 ms", "P99 ms", "Errors %", "Req/s", "CPU %", "Mem GB", "Nodes", "Zone", "Owner", "Pager", "Notes", "Link"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map((_, i) => (i === 0 || i >= 10 ? "---" : "---:")).join("|")}|`];
  REGIONS.forEach((region, r) => {
    const p50 = 20 + Math.floor(rnd() * 30);
    const p99 = region === "Frankfurt" ? 187 : 120 + Math.floor(rnd() * 400);
    const cells = [
      `**${region}**`,
      String(p50),
      String(p50 * 2),
      String(p99),
      (rnd() * 2).toFixed(2),
      String(1000 + Math.floor(rnd() * 9000)),
      String(20 + Math.floor(rnd() * 60)),
      (8 + rnd() * 24).toFixed(1),
      String(3 + (r % 5)),
      r % 3 === 0 ? "" : `eu-${(r % 3) + 1}`,
      r % 4 === 0 ? "〃" : (PEOPLE[r % PEOPLE.length] ?? ""),
      r % 2 === 0 ? "—" : "yes",
      r === 3 ? "uses a \\| b \\| c routing, `code | span`" : r === 5 ? "see *notes*, **bold**, ~~old~~" : "",
      `[dash](${SITE_URL}/browse/KAN-${r + 1})`,
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  });
  return lines.join("\n");
}
simple("wide-table", "body", "Wide Table", "body", `# Wide Table\n\nLatency by region (14 columns).\n\n${wideTable()}`);
simple("table-only", "body", "Table Only", "body", "| Metric | Value | Unit |\n|---|---:|---|\n| Uptime | 99.95 | % |\n| Tickets closed | 1 284 | count |\n| Mean time to restore | 37 | min |\n| Budget burn | 61 | % |");
simple("nested-lists", "body", "Nested Lists", "body", [
  "# Nested Lists",
  "",
  "- level 1 a",
  "  - level 2 a",
  "    1. ordered 3 a",
  "    2. ordered 3 b",
  "       - level 4 bullet",
  "         1. level 5 ordered",
  "            - level 6: the vault passphrase hint is **blue heron**",
  "- level 1 b",
  "  1. mixed ordered",
  "  2. mixed ordered two",
].join("\n"));
simple("code-blocks", "body", "Code Blocks", "body", [
  "# Code Blocks",
  "",
  "Inline: use `kubectl get pods` or ``a `tick` inside``.",
  "",
  `${FENCE}bash`,
  "kubectl rollout undo deployment/ledger-api --to-revision=41",
  FENCE,
  "",
  "````md",
  `${FENCE}js`,
  "console.log(`nested ${fence}`)",
  FENCE,
  "````",
  "",
  FENCE,
  "no language, | pipes | and <tags> & entities",
  FENCE,
].join("\n"));
simple("task-list", "body", "Task List", "body", [
  "# Task List",
  "",
  "- [x] Rotate keys",
  "- [ ] Update runbook",
  "  - [x] Draft",
  "  - [ ] Review",
  "- [ ] Archive old tickets",
  "- [x] Notify finance",
].join("\n"));
simple("quotes-headings", "body", "Quotes and Headings", "body", [
  "# Heading 1",
  "## Heading 2",
  "### Heading 3",
  "#### Heading 4",
  "##### Heading 5",
  "###### Heading 6",
  "",
  "> quote level 1",
  "> > quote level 2",
  "> > > quote level 3 with **bold** and a [link](https://example.com)",
  "",
  "---",
  "",
  "Closing paragraph.",
].join("\n"));
simple("bidi", "body", "Bidi and Zero-Width", "body", [
  "# Bidi and Zero-Width",
  "",
  "Mixed: invoice שלום 4471 مرحبا 88 end.",
  "",
  `Client code (contains a zero-width space between the dash and the digits): ACME-${ZWSP}7731`,
  "",
  "RTL paragraph: هذا نص عربي مع English داخله و 123 رقم.",
].join("\n"));
simple("special-md", "body", "Special Markdown", "body", [
  "# Special Markdown",
  "",
  "Literal asterisks: \\*not italic\\* and \\_not italic\\_. Path: C:\\\\Temp\\\\x.",
  "",
  "Raw HTML: <b>bold?</b> <script>alert(1)</script> &amp; &lt;escaped&gt;",
  "",
  "Emoji: 🚀 🔥 ✅ ❌ 👩‍💻. Strike: ~~gone~~. Image: ![alt text](https://example.com/x.png)",
  "",
  "Line one  ",
  "line two after a hard break.",
].join("\n"));
page({
  key: "links",
  group: "body",
  title: `${PREFIX}Links and Jira`,
  parent: "body",
  links: ["wide", "chain-10", "wide-table"],
  steps: [
    {
      body: (c) =>
        [
          "# Links and Jira",
          "",
          `Internal links: ${pageLink(c, "wide", "Wide Index")}, ${pageLink(c, "chain-10", "Archive leaf")}, ${pageLink(c, "wide-table", "Wide Table")}.`,
          "",
          `Rollout Plan: blocked by [KAN-7](${SITE_URL}/browse/KAN-7). Related work: KAN-12 and KAN-20 (bare keys).`,
          "",
          "| Topic | Issue |",
          "|---|---|",
          "| Migration | KAN-7 |",
          "| Reconciliation cache | KAN-12 |",
        ].join("\n"),
    },
  ],
});

function hugeBody(): string {
  const rnd = lcg(99);
  const lines = ["# Huge Page", "", "Parts inventory (generated, about 300 KB of markdown).", "", "| SKU | Description | Price | Stock | Note |", "|---|---|---:|---|---|"];
  let bytes = lines.join("\n").length;
  for (let i = 1; bytes < HUGE_BYTES; i++) {
    const sku = `NM-SKU-${String(i).padStart(5, "0")}`;
    const price = i === 1337 ? "4,242.17 EUR" : `${(1 + rnd() * 900).toFixed(2)} EUR`;
    const line = `| ${sku} | Widget ${i} with a deliberately wordy description for padding purposes | ${price} | ${rnd() < 0.8 ? "in stock" : "backorder"} | batch ${Math.floor(rnd() * 90)} |`;
    lines.push(line);
    bytes += line.length + 1;
  }
  return lines.join("\n");
}
if (!process.argv.includes("--no-huge")) {
  specs.push({ key: "huge", group: "body", title: `${PREFIX}Huge Page 300KB`, parent: "body", steps: [{ body: hugeBody() }] });
}

// ---------------------------------------------------------------------------
// History lab
// ---------------------------------------------------------------------------

simple("history", "history", "History Lab", "root", "# History Lab\n\nPages with many versions, renames, restores and copies.");

const RETENTION: [number, string][] = [
  [30, "Initial policy"], [30, "Fix typo"], [30, "Add owner"], [30, "Clarify cold tier"], [30, "Reformat table"],
  [30, "Add link to KAN-7"], [30, "Fix heading"], [30, "Add glossary"], [30, "Reword intro"], [30, "Review 2025-12: no change"],
  [45, "January change: hot retention 30 -> 45 days (KAN-12)"], [45, "Fix typo"], [45, "Add on-call contact"],
  [60, "February change: hot retention 45 -> 60 days"], [45, "Revert February change (legal objected)"],
  [45, "Reformat table"], [45, "Add exceptions section"], [45, "Clarify exceptions"], [45, "Quarterly review: no change"],
  [45, "Add cold-tier cost note"], [120, "March change: hot retention 45 -> 120 days (KAN-20)"], [120, "Fix typo"],
  [120, "Add GDPR note"], [100, "April hotfix: 120 -> 100 days (cost)"], [100, "Typo"], [90, "May change: 100 -> 90 days"],
  [90, "Add appendix"], [150, "June change: 90 -> 150 days (audit requirement)"],
];
const retentionBody = (days: number, revision: number): string =>
  `# Log Retention Policy\n\nApplication logs are kept for **${days} days** in hot storage.\n\n| Tier | Retention |\n|---|---|\n| Hot | ${days} days |\n| Cold | 400 days |\n\nOwner: Platform team. Revision ${revision}.`;
page({
  key: "retention",
  group: "history",
  title: `${PREFIX}Log Retention Policy`,
  parent: "history",
  steps: RETENTION.map(([days, message], i) => (i === 0 ? { body: retentionBody(days, 1) } : { body: retentionBody(days, i + 1), message })),
});
propSpecs.push({ page: "retention", key: "nm-classification", values: [{ level: "internal", review: "2026-Q1" }, { level: "internal", review: "2026-Q2" }] });

const CONTACT: [string, string, string][] = [];
const phoneFor = (v: number): string => (v <= 5 ? "0101" : v <= 10 ? "0102" : v <= 14 ? "0101" : v <= 20 ? "0103" : "0102");
for (let v = 1; v <= 26; v++) {
  const title = v < 6 ? "Oncall Contacts (draft)" : v < 19 ? "Incident Contact Sheet" : "Incident Contact Sheet 2026";
  CONTACT.push([title, phoneFor(v), v === 1 ? "" : v === 6 ? "Rename and new primary number" : v === 11 ? "Revert to the original number" : v === 19 ? "Rename for 2026" : `Edit ${v}`]);
}
page({
  key: "contacts",
  group: "history",
  title: `${PREFIX}${CONTACT[0]?.[0] ?? ""}`,
  parent: "history",
  steps: CONTACT.map(([title, phone, message], v) => {
    const step: Step = { body: `# Incident Contact Sheet\n\nPrimary on-call: **+36 30 555 ${phone}**.\n\nSheet revision ${v + 1}.` };
    if (v === 5 || v === 18) {
      step.title = PREFIX + title;
    }
    if (message !== "") {
      step.message = message;
    }
    return step;
  }),
});

const goals = (deals: number): string => `# Quarterly Goals\n\nTarget: **${deals} deals** this quarter.`;
page({
  key: "goals",
  group: "history",
  title: `${PREFIX}Quarterly Goals`,
  parent: "history",
  steps: [
    { body: goals(10) },
    { body: goals(12), message: "Raise to 12" },
    { body: goals(15), message: "Raise to 15" },
    { body: goals(8), message: "Cut to 8" },
    { body: goals(20), message: "Stretch goal" },
    { restore: 2, message: "Restore version 2 (stretch goal withdrawn)" },
  ],
});

// ---------------------------------------------------------------------------
// Blog posts
// ---------------------------------------------------------------------------

const BLOGS: [string, string, string][] = [
  ["blog-rn", "Release Notes 2026.03", "# Release Notes 2026.03\n\nHighlights: ledger export, new SSO flow.\n\nUpgrade window: Saturday 02:00 CET."],
  ["blog-rn-hotfix", "Release Notes 2026.03 (hotfix)", "# Release Notes 2026.03 (hotfix)\n\nHotfix 2026.03.1 fixes the SSO redirect loop."],
  ["blog-rn-march", "Release Notes March 2026", "# Release Notes March 2026\n\nSame content as 2026.03, different title."],
  ["blog-hu", "Hírlevél – 2026. március", "# Hírlevél\n\nA márciusi kiadás összefoglalója."],
  ["blog-pir", `Post-incident review: cache stampede`, "# Post-incident review: cache stampede\n\nCorrected rollback window: **25 minutes** (the wiki page says 15, which was wrong)."],
];
for (const [key, title, body] of BLOGS) {
  specs.push({ key, group: "blogs", title: PREFIX + title, type: "blogpost", steps: [{ body }] });
}
specs.push({
  key: "blog-probe",
  group: "blogs",
  title: `${PREFIX}Blog probe`,
  type: "blogpost",
  steps: [{ body: "blog" }, { body: "# Blog probe\n\nResidue of the blog capability probe.", message: "Real body" }],
});
simple("pir-page", "history", "Post-incident review: cache stampede", "history", "# Post-incident review: cache stampede\n\nRoot cause: cache stampede after a deploy.\n\nRollback window: **15 minutes**.");

// ---------------------------------------------------------------------------
// Personal space
// ---------------------------------------------------------------------------

specs.push({
  key: "p-goals",
  group: "personal",
  title: `${PREFIX}Quarterly Goals`,
  space: PERSONAL,
  parent: "phome",
  steps: [{ body: "# Quarterly Goals (personal)\n\nPersonal target: **3 certifications**." }],
});
specs.push({
  key: "p-scratch",
  group: "personal",
  title: `${PREFIX}Personal Scratchpad`,
  space: PERSONAL,
  parent: "phome",
  steps: [{ body: "# Scratchpad\n\nNotes that must not be confused with the wiki." }],
});
specs.push({
  key: "restricted",
  group: "personal",
  title: `${PREFIX}Restricted Notes`,
  space: PERSONAL,
  parent: "phome",
  steps: [{ body: "# Restricted Notes\n\nA page whose edit restriction was set through the CLI." }],
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

simple("commentlab", "comments", "Comment Lab", "root", "# Comment Lab\n\nPages with heavy comment activity.");
simple("storm", "comments", "Comment Storm", "commentlab", "# Comment Storm\n\nRelease train R-47 status thread. Freeze window starts soon. Rollback owner is on call.");
simple("deep", "comments", "Deep Thread", "commentlab", "# Deep Thread\n\nRotation decision thread.");
simple("inline", "comments", "Inline Notes", "commentlab", "# Inline Notes\n\nThe on-call handoff happens every Monday at 09:00 CET. The vendor contract with Northwind ends 2026-12-31. Access reviews run quarterly. The escalation ladder has three tiers. Backups are verified weekly.");

const TOPICS = ["deploy queue", "flaky test", "dashboard", "cache warmup", "feature flag", "schema change", "alert noise", "capacity", "cost report", "vendor ticket"];
for (let i = 1; i <= 55; i++) {
  const base = `Status ${i}: ${TOPICS[i % TOPICS.length] ?? ""} looks ${i % 3 === 0 ? "stable" : i % 3 === 1 ? "slow" : "green"} (build ${1000 + i * 7}).`;
  commentSpecs.push({
    tag: `s${nn(i)}`,
    page: "storm",
    kind: "footer",
    text: i === 12 ? "Freeze begins 2026-11-10." : i === 37 ? "Heads up: the freeze was moved and now starts 2026-11-17." : base,
    ...(i === 12 ? { edits: ["Freeze begins 2026-11-12.", "Freeze begins 2026-11-13 (final)."] } : {}),
  });
}
commentSpecs.push(
  { tag: "s05r1", page: "storm", kind: "footer", parent: "s05", text: "Reply: confirmed on my side." },
  { tag: "s20r1", page: "storm", kind: "footer", parent: "s20", text: "Reply: who owns the follow-up?" },
  { tag: "s20r2", page: "storm", kind: "footer", parent: "s20r1", text: "Reply to reply: the follow-up owner is Dávid Szabó." },
  { tag: "s44r1", page: "storm", kind: "footer", parent: "s44", text: "Reply: ticket opened." },
  { tag: "si1", page: "storm", kind: "inline", select: "Release train R-47", text: "Inline: R-47 ships on a Wednesday, not a Tuesday.", final: "resolved" },
  { tag: "si2", page: "storm", kind: "inline", select: "Rollback owner", text: "Inline: the rollback owner is Eszter Varga." },
);
commentSpecs.push(
  { tag: "d0", page: "deep", kind: "footer", text: "Which on-call rotation do we adopt for Q4: A (weekly) or B (follow-the-sun)?" },
  { tag: "d1", page: "deep", kind: "footer", parent: "d0", text: "Leaning A, B needs APAC hires." },
  { tag: "d2", page: "deep", kind: "footer", parent: "d1", text: "APAC hires were approved in October, so B is feasible." },
  { tag: "d3", page: "deep", kind: "footer", parent: "d2", text: "B costs about 18% more; we need finance sign-off." },
  { tag: "d4", page: "deep", kind: "footer", parent: "d3", text: "FINAL DECISION (Finance and Engineering VP): rotation B, starting 2026-12-01, pager handoff at 06:00 UTC." },
  { tag: "d5", page: "deep", kind: "footer", parent: "d4", text: "Noted, I will update the schedule." },
  { tag: "d6", page: "deep", kind: "footer", parent: "d5", text: "Thanks!" },
  { tag: "d2b", page: "deep", kind: "footer", parent: "d1", text: "What about a hybrid of A and B?" },
  { tag: "d2b1", page: "deep", kind: "footer", parent: "d2b", text: "Hybrid was rejected last year." },
  { tag: "d7", page: "deep", kind: "footer", text: "Unrelated: the page title has a typo." },
);
commentSpecs.push(
  { tag: "n1", page: "inline", kind: "inline", select: "every Monday at 09:00 CET", text: "Correction: since the October reorg the handoff is on **Thursday** at 09:00 CET." },
  { tag: "n2", page: "inline", kind: "inline", select: "contract with Northwind ends 2026-12-31", text: "Resolved: the contract was extended to 2027-06-30.", final: "resolved" },
  { tag: "n3", page: "inline", kind: "inline", select: "three tiers", text: "Actually four tiers since September." },
  { tag: "n3r1", page: "inline", kind: "inline", parent: "n3", text: "Confirmed, tier 4 is the CTO." },
  { tag: "n4", page: "inline", kind: "inline", select: "verified weekly", text: "Not weekly, only monthly.", final: "reopened" },
  { tag: "n5", page: "inline", kind: "inline", select: "Access reviews run quarterly", text: "Access reviews should be every 3 months.", edits: ["Access reviews should be every 2 months."] },
  { tag: "nf1", page: "inline", kind: "footer", text: "Footer note: see the inline comments for corrections." },
);
commentSpecs.push(
  { tag: "bc1", page: "blog-rn", kind: "footer", text: "Hotfix 2026.03.1 supersedes this release." },
  { tag: "bc2", page: "blog-rn", kind: "footer", parent: "bc1", text: "Agreed, upgrade window moved to Sunday 03:00 CET." },
);

// ---------------------------------------------------------------------------
// Planted facts
// ---------------------------------------------------------------------------

facts.push(
  { id: "F01", question: "What was the hot log retention in days immediately before the March change (see version messages of the Log Retention Policy page)?", answer: "45", where: ["retention"], whyHard: "Value flips back and forth (30, 45, 60, 45, 120, 100, 90, 150); the latest body says 150; needs page versions and page get --version 20 (a February revert makes 60 a trap)." },
  { id: "F02", question: "On which weekday does the on-call handoff happen according to the Inline Notes page (including inline comments)?", answer: "Thursday", where: ["inline"], whyHard: "The body says Monday; the correction exists only in an open inline comment." },
  { id: "F03", question: "What was the final rotation decision on the Deep Thread page and its start date?", answer: "Rotation B starting 2026-12-01 (pager handoff 06:00 UTC)", where: ["deep"], whyHard: "Only in the reply four levels below the top comment (d0 > d1 > d2 > d3 > d4); comment list --replies nests one level." },
  { id: "F04", question: "What is the escalation phone extension in the Restart Procedure page under Engineering / Mérnökség > Runbooks?", answer: "7731", where: ["restart-eng"], whyHard: "Five near-identical titles (NBSP, zero-width space, Cyrillic a, suffix 2); only the ancestor path disambiguates." },
  { id: "F05", question: "What is the price of NM-SKU-01337 on the Huge Page 300KB page?", answer: "4,242.17 EUR", where: ["huge"], whyHard: "A single table cell in a ~300 KB page with 2000+ rows; needs --grep or --output rather than reading the body." },
  { id: "F06", question: "Under which page does the Onboarding Checklist page live now, and what was its desk for laptop pickup?", answer: "Parent: Engineering / Mérnökség; Desk 9C", where: ["onboarding", "eng"], whyHard: "Created under HR with another title, renamed and moved to Engineering; the move is not visible in the title or body." },
  { id: "F07", question: "According to the blog post (not the wiki page), what is the corrected rollback window for the cache stampede incident?", answer: "25 minutes", where: ["blog-pir", "pir-page"], whyHard: "A page and a blog post share the title; the page says 15 minutes." },
  { id: "F08", question: "How many direct children does the Wide Index page have, and how many descendants in total?", answer: "40 direct children; 43 descendants", where: ["wide"], whyHard: "Needs pagination past 25; tree depth and --limit defaults cut counts short." },
  { id: "F09", question: "What is the region code on the level 10 page of the Architecture Archive chain?", answer: "EU-CENTRAL-7", where: ["chain-10", "eng-archive"], whyHard: "Ten levels deep; page tree is capped at depth 5, so descent needs repeated children calls or ancestors." },
  { id: "F10", question: "What was the primary on-call number on the contact sheet in the version just before it was first renamed from 'Oncall Contacts (draft)'?", answer: "+36 30 555 0101", where: ["contacts"], whyHard: "26 versions; the number changes, reverts and changes again; current title differs from the original." },
  { id: "F11", question: "What is the deal target on Quarterly Goals now, and which version number is the current head?", answer: "12 deals; version 6", where: ["goals"], whyHard: "The page was restored to version 2, which creates version 6; the latest edit before it said 20." },
  { id: "F12", question: "What is the 'Mean time to restore' on the table-only page?", answer: "37 min", where: ["table-only"], whyHard: "The page body is only a table." },
  { id: "F13", question: "To which date was the Northwind vendor contract extended (Inline Notes page)?", answer: "2027-06-30", where: ["inline"], whyHard: "Only in a resolved inline comment; the body says it ends 2026-12-31 and resolved comments are filtered by default in some views." },
  { id: "F14", question: "How many top-level footer comments does the Comment Storm page have?", answer: "55", where: ["storm"], whyHard: "More than one page of results; replies and inline comments must not be counted." },
  { id: "F15", question: "Which Jira issue blocks the Rollout Plan (Links and Jira page) and what is its summary?", answer: "KAN-7: atl smoke eval Kubernetes platform migration", where: ["links"], whyHard: "Cross-product: the key is on the wiki page, the summary in Jira." },
  { id: "F16", question: "What is the exact client code on the Bidi and Zero-Width page?", answer: `ACME-${ZWSP}7731 (contains U+200B after the dash; 10 characters)`, where: ["bidi"], whyHard: "Invisible character: a naive copy or match on ACME-7731 fails." },
  { id: "F17", question: "What is the personal-space page 'atl smoke nm Quarterly Goals' target (not the wiki one)?", answer: "3 certifications", where: ["p-goals", "goals"], whyHard: "Same title in two spaces; the wiki page says 12 deals." },
  { id: "F18", question: "What retention does the 'Log Retention Policy (staging copy)' page prescribe?", answer: "200 days", where: ["retention-copy", "retention"], whyHard: "Copied from the original (150 days) and then edited; two other pages share the base title." },
  { id: "F19", question: "What is the current text of comment s12 on Comment Storm (freeze start)?", answer: "Freeze begins 2026-11-13 (final).", where: ["storm"], whyHard: "The comment was edited twice; comment s37 gives a different date for a moved freeze; the answer to 'latest statement' is s37 (2026-11-17), the answer for s12 is the edited text." },
  { id: "F20", question: "What is the nm-owner property tier on the NBSP Restart Procedure page?", answer: "3", where: ["restart-eng"], whyHard: "Content property updated from tier 2 to 3; only reachable via page properties." },
  { id: "F21", question: "Which Inline Notes comment was resolved and then reopened, and what does it say?", answer: "Not weekly, only monthly. (backups verification)", where: ["inline"], whyHard: "Resolution state reopened differs from open; needs comment list --kind inline --resolution reopened." },
  { id: "F22", question: "Where is the 'Procurement Thresholds' page now and what is the two-quote threshold?", answer: "Under Policies (Finance); 10 000 EUR", where: ["procurement", "fin-policies"], whyHard: "Created under Drafts and moved; version 1 says 5 000 EUR." },
);

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Known {
  id: string;
  parentId: string | undefined;
}
interface State {
  id: string;
  title: string;
  space: string;
  type: "page" | "blogpost";
  parentId: string | undefined;
  version: number;
}

const registry = new Map<string, Map<string, Known>>();
const states = new Map<string, Promise<State>>();
const done = new Map<string, State>();
const specByKey = new Map(specs.map((s) => [s.key, s]));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
const selected = (group: string): boolean => only === undefined || only.includes(group);

const regKey = (space: string, type: string): string => `${space}|${type}`;

async function loadRegistry(): Promise<void> {
  for (const [space, type] of [[SPACE, "page"], [SPACE, "blogpost"], [PERSONAL, "page"]] as const) {
    const res = rec(await atl(["space", "pages", space, "--type", type, "--all", "--fields", "id,title,parentId"]), "space pages");
    const map = new Map<string, Known>();
    for (const item of items(res)) {
      const title = str(item, "title");
      if (title.startsWith(PREFIX)) {
        map.set(title, { id: str(item, "id"), parentId: optStr(item, "parentId") });
      }
    }
    registry.set(regKey(space, type), map);
  }
}

function aliases(spec: PageSpec): string[] {
  return [...new Set([spec.title, ...spec.steps.flatMap((s) => (s.title === undefined ? [] : [s.title]))])];
}

function idOf(key: string): string {
  const state = done.get(key);
  if (state === undefined) {
    throw new Error(`page ${key} not realized before use`);
  }
  return state.id;
}

function ctx(): Ctx {
  return {
    id: idOf,
    url: (key) => `${SITE_URL}/wiki/spaces/${done.get(key)?.space ?? SPACE}/pages/${idOf(key)}`,
  };
}

function resolveBody(body: Body | undefined): string | undefined {
  return typeof body === "function" ? body(ctx()) : body;
}

async function parentIdOf(key: string): Promise<string> {
  if (key === "home") {
    return HOME_PAGE;
  }
  if (key === "phome") {
    return PERSONAL_HOME;
  }
  return (await ensure(key)).id;
}

function ensure(key: string): Promise<State> {
  const existing = states.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const spec = specByKey.get(key);
  if (spec === undefined) {
    throw new Error(`unknown page key ${key}`);
  }
  const promise = realizeWithRetry(spec);
  states.set(key, promise);
  return promise;
}

async function backoff(attempt: number): Promise<void> {
  await Bun.sleep(2000 * 2 ** attempt);
  await loadRegistry();
}

async function realizeWithRetry(spec: PageSpec): Promise<State> {
  for (let attempt = 1; ; attempt++) {
    try {
      const state = await realize(spec);
      done.set(spec.key, state);
      return state;
    } catch (error) {
      if (error instanceof Transient && attempt < MAX_ATTEMPTS) {
        log(`transient on ${spec.key}; restarting its steps`);
        await backoff(attempt);
        continue;
      }
      if (error instanceof Failure) {
        failures.push({ phase: "page", what: spec.key, code: error.code, message: error.message, argv: error.argv.map((a) => (a.length > 120 ? `${a.slice(0, 120)}...` : a)) });
      }
      throw error;
    }
  }
}

async function realize(spec: PageSpec): Promise<State> {
  const space = spec.space ?? SPACE;
  const type = spec.type ?? "page";
  const typeArgs = type === "blogpost" ? ["--type", "blogpost"] : [];
  for (const dep of spec.links ?? []) {
    await ensure(dep);
  }
  const parentId = spec.parent === undefined ? undefined : await parentIdOf(spec.parent);
  const known = registry.get(regKey(space, type));
  const foundTitle = aliases(spec).find((t) => known?.has(t));
  const found = foundTitle === undefined ? undefined : known?.get(foundTitle);
  let state: State;
  if (found === undefined || foundTitle === undefined) {
    const first = spec.steps[0];
    const created = rec(
      await atl(
        ["page", "create", "--space", space, "--title", spec.title, ...(parentId === undefined ? [] : ["--parent", parentId]), ...typeArgs, ...bodyArgs(resolveBody(first?.body) ?? "")],
        true,
      ),
      "page create",
    );
    state = { id: str(created, "id"), title: spec.title, space, type, parentId, version: 1 };
    known?.set(spec.title, { id: state.id, parentId });
    log(`created ${spec.key} ${state.id}`);
  } else {
    const version =
      spec.steps.length > 1 ? num(rec(await atl(["page", "get", found.id, "--fields", "version", ...typeArgs]), "page get"), "version") : 1;
    state = { id: found.id, title: foundTitle, space, type, parentId: found.parentId, version };
  }
  for (let v = state.version; v < spec.steps.length; v++) {
    const step = spec.steps[v];
    if (step === undefined) {
      break;
    }
    const message = step.message === undefined ? [] : ["--message", step.message];
    let result: Json;
    if (step.restore !== undefined) {
      result = rec(await atl(["page", "restore", state.id, "--version", String(step.restore), ...message, ...typeArgs], true), "page restore");
    } else {
      const body = resolveBody(step.body);
      result = rec(
        await atl(["page", "update", state.id, ...(body === undefined ? [] : bodyArgs(body)), ...(step.title === undefined ? [] : ["--title", step.title]), ...message, ...typeArgs], true),
        "page update",
      );
      if (step.title !== undefined) {
        known?.delete(state.title);
        known?.set(step.title, { id: state.id, parentId: state.parentId });
        state.title = step.title;
      }
    }
    state.version = num(result, "version");
    if (state.version !== v + 1) {
      observations.push({ id: `version-${spec.key}`, repro: ["page", "update", state.id], expected: `version ${v + 1}`, actual: `version ${state.version}` });
    }
  }
  if (spec.moveTo !== undefined) {
    const target = await parentIdOf(spec.moveTo);
    if (state.parentId !== target) {
      await atl(["page", "move", state.id, "--to", target, ...typeArgs], true);
      state.parentId = target;
      known?.set(state.title, { id: state.id, parentId: target });
      log(`moved ${spec.key} under ${spec.moveTo}`);
    }
  }
  return state;
}

// --- comments ---------------------------------------------------------------

const TAG = /\(nm:([A-Za-z0-9._-]+)\)/;
const tagged = (tag: string, text: string): string => `${text} (nm:${tag})`;

interface FoundComment {
  id: string;
  kind: "footer" | "inline";
  resolution: string | undefined;
}

async function loadComments(pageId: string, type: "page" | "blogpost", specsOnPage: CommentSpec[]): Promise<Map<string, FoundComment>> {
  const found = new Map<string, FoundComment>();
  const withChildren = new Set(specsOnPage.flatMap((s) => (s.parent === undefined ? [] : [s.parent])));
  const typeArgs = type === "blogpost" ? ["--type", "blogpost"] : [];
  const listed = rec(await atl(["comment", "list", pageId, "--kind", "all", "--all", "--fields", "id,kind,resolutionStatus,body", ...typeArgs]), "comment list");
  const descend = async (id: string, inline: boolean): Promise<void> => {
    const replies = rec(await atl(["comment", "replies", id, ...(inline ? ["--kind", "inline"] : []), "--all", "--fields", "id,body"]), "comment replies");
    for (const reply of items(replies)) {
      const tag = TAG.exec(bodyText(reply))?.[1];
      if (tag !== undefined) {
        found.set(tag, { id: str(reply, "id"), kind: inline ? "inline" : "footer", resolution: undefined });
        if (withChildren.has(tag)) {
          await descend(str(reply, "id"), inline);
        }
      }
    }
  };
  for (const item of items(listed)) {
    const tag = TAG.exec(bodyText(item))?.[1];
    if (tag === undefined) {
      continue;
    }
    const inline = optStr(item, "kind") === "inline";
    found.set(tag, { id: str(item, "id"), kind: inline ? "inline" : "footer", resolution: optStr(item, "resolutionStatus") });
    if (withChildren.has(tag)) {
      await descend(str(item, "id"), inline);
    }
  }
  return found;
}

const commentIds = new Map<string, FoundComment>();

async function seedComments(pageKey: string): Promise<void> {
  const state = await ensure(pageKey);
  const mine = commentSpecs.filter((c) => c.page === pageKey);
  if (mine.length === 0) {
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const found = await loadComments(state.id, state.type, mine);
      const targetArgs = state.type === "blogpost" ? ["--target-type", "blogpost"] : [];
      for (const spec of mine) {
        let comment = found.get(spec.tag);
        const inline = spec.kind === "inline";
        if (comment === undefined) {
          const parent = spec.parent === undefined ? undefined : found.get(spec.parent);
          if (spec.parent !== undefined && parent === undefined) {
            throw new Error(`parent comment ${spec.parent} missing for ${spec.tag}`);
          }
          const args =
            parent === undefined
              ? ["comment", "add", state.id, ...(inline ? ["--kind", "inline", "--select", spec.select ?? "", ...(spec.match === undefined ? [] : ["--match", String(spec.match)])] : []), ...targetArgs]
              : ["comment", "add", "--reply-to", parent.id, ...(inline ? ["--kind", "inline"] : [])];
          const created = rec(await atl([...args, ...bodyArgs(tagged(spec.tag, spec.text)), "--fields", "id,parentCommentId,resolutionStatus"], true), "comment add");
          comment = { id: str(created, "id"), kind: spec.kind, resolution: optStr(created, "resolutionStatus") };
          found.set(spec.tag, comment);
          const reportedParent = optStr(created, "parentCommentId");
          if (parent !== undefined && reportedParent !== undefined && reportedParent !== parent.id) {
            observations.push({
              id: "comment-add-parent",
              repro: ["comment", "add", "--reply-to", parent.id, "--body", "..."],
              expected: `parentCommentId ${parent.id}`,
              actual: `parentCommentId ${reportedParent} (comment get ${comment.id} reports ${parent.id})`,
            });
          }
          log(`comment ${spec.tag} -> ${comment.id}`);
        }
        const inlineArgs = inline ? ["--kind", "inline"] : [];
        if (spec.edits !== undefined) {
          const current = num(rec(await atl(["comment", "get", comment.id, ...inlineArgs, "--fields", "version"]), "comment get"), "version");
          for (let v = current; v <= spec.edits.length; v++) {
            const text = spec.edits[v - 1] ?? "";
            await atl(["comment", "update", comment.id, ...inlineArgs, ...bodyArgs(tagged(spec.tag, text))], true);
          }
        }
        if (spec.final !== undefined && comment.resolution !== spec.final) {
          if (comment.resolution !== "resolved") {
            await atl(["comment", "update", comment.id, "--kind", "inline", "--resolve"], true);
          }
          if (spec.final === "reopened") {
            await atl(["comment", "update", comment.id, "--kind", "inline", "--reopen"], true);
          }
          comment.resolution = spec.final;
        }
        commentIds.set(spec.tag, comment);
      }
      return;
    } catch (error) {
      if (error instanceof Transient && attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      if (error instanceof Failure) {
        failures.push({ phase: "comments", what: pageKey, code: error.code, message: error.message, argv: error.argv.slice(0, 8) });
      }
      throw error;
    }
  }
}

// --- properties and capability probes --------------------------------------

const propIds = new Map<string, { id: string; version: number; value: unknown }>();

async function seedProps(spec: PropSpec): Promise<void> {
  const state = await ensure(spec.page);
  const res = rec(await atl(["api", "GET", `/wiki/api/v2/pages/${state.id}/properties`, "--query", `key=${spec.key}`]), "properties");
  const existing = Array.isArray(res.results) ? res.results.find(isRecord) : undefined;
  let id = existing === undefined ? undefined : str(existing, "id");
  let version = existing === undefined ? 0 : num(rec(existing.version, "version"), "number");
  for (let v = version; v < spec.values.length; v++) {
    const bodyPath = join(BODIES, `prop-${createHash("sha1").update(JSON.stringify([state.id, spec.key, v])).digest("hex").slice(0, 12)}.json`);
    mkdirSync(BODIES, { recursive: true });
    writeFileSync(bodyPath, JSON.stringify({ key: spec.key, value: spec.values[v], ...(id === undefined ? {} : { version: { number: v + 1 } }) }));
    const out =
      id === undefined
        ? rec(await atl(["api", "POST", `/wiki/api/v2/pages/${state.id}/properties`, "--body-file", bodyPath, "--yes"], true), "property create")
        : rec(await atl(["api", "PUT", `/wiki/api/v2/pages/${state.id}/properties/${id}`, "--body-file", bodyPath, "--yes"], true), "property update");
    id = str(out, "id");
    version = v + 1;
  }
  if (id !== undefined) {
    propIds.set(`${spec.page}:${spec.key}`, { id, version, value: spec.values[version - 1] });
  }
}

const capabilities: { probe: string; ok: boolean; detail: string }[] = [];

async function probeCapabilities(): Promise<void> {
  const target = await ensure("retention");
  const labels = rec(await atl(["page", "labels", target.id]), "labels");
  if (JSON.stringify(labels).includes("nm-label")) {
    capabilities.push({ probe: "label write (REST v1 /content/{id}/label)", ok: true, detail: "label nm-label present" });
  } else {
    const bodyPath = join(BODIES, "label.json");
    mkdirSync(BODIES, { recursive: true });
    writeFileSync(bodyPath, JSON.stringify([{ prefix: "global", name: "nm-label" }]));
    try {
      await atl(["api", "POST", `/wiki/rest/api/content/${target.id}/label`, "--body-file", bodyPath, "--yes"], true);
      capabilities.push({ probe: "label write (REST v1 /content/{id}/label)", ok: true, detail: "label added" });
    } catch (error) {
      capabilities.push({ probe: "label write (REST v1 /content/{id}/label)", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const restricted = await ensure("restricted");
  const restriction = rec(await atl(["page", "restriction", restricted.id]), "restriction");
  const alreadyRestricted = JSON.stringify(restriction).includes("restricted");
  if (alreadyRestricted) {
    capabilities.push({ probe: "page restrict --state edit-restricted", ok: true, detail: JSON.stringify(restriction).slice(0, 200) });
  } else {
    try {
      const out = await atl(["page", "restrict", restricted.id, "--state", "edit-restricted", "--yes"], true);
      capabilities.push({ probe: "page restrict --state edit-restricted", ok: true, detail: JSON.stringify(out).slice(0, 200) });
    } catch (error) {
      capabilities.push({ probe: "page restrict --state edit-restricted", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

// --- copies -----------------------------------------------------------------

interface CopySpec {
  key: string;
  title: string;
  space: string;
  parent: string;
  /** body and message of the one edit applied after the copy (version 2), if any */
  edit?: { body: string; message: string };
}

/** Copies are made by `page copy` from the finished retention page, so the copy carries version 28's body. */
const COPIES: CopySpec[] = [
  { key: "retention-copy", title: `${PREFIX}Log Retention Policy (staging copy)`, space: SPACE, parent: "eng", edit: { body: retentionBody(200, 29), message: "Staging keeps 200 days" } },
  { key: "retention-copy-plain", title: `${PREFIX}Log Retention Policy (copy)`, space: SPACE, parent: "history" },
  { key: "p-retention", title: `${PREFIX}Log Retention Policy`, space: PERSONAL, parent: "p-scratch", edit: { body: retentionBody(180, 29), message: "Personal notes: 180 days" } },
];

async function seedCopies(): Promise<void> {
  const source = await ensure("retention");
  for (const copy of COPIES) {
    const known = registry.get(regKey(copy.space, "page"));
    const parentId = await parentIdOf(copy.parent);
    let found = known?.get(copy.title);
    if (found === undefined) {
      const out = rec(
        await atl(["page", "copy", source.id, "--title", copy.title, "--to-parent", parentId, ...(copy.space === SPACE ? [] : ["--to-space", copy.space])], true),
        "page copy",
      );
      found = { id: str(out, "id"), parentId };
      known?.set(copy.title, found);
      log(`copied retention -> ${copy.key} ${found.id}`);
    }
    let version = num(rec(await atl(["page", "get", found.id, "--fields", "version"]), "page get"), "version");
    if (copy.edit !== undefined && version < 2) {
      version = num(rec(await atl(["page", "update", found.id, ...bodyArgs(copy.edit.body), "--message", copy.edit.message], true), "page update"), "version");
    }
    done.set(copy.key, { id: found.id, title: copy.title, space: copy.space, type: "page", parentId: found.parentId, version });
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const CLI_FINDINGS: { id: string; repro: string[]; expected: string; actual: string }[] = [
  {
    id: "comment-add-reply-parent",
    repro: ["comment", "add", "--reply-to", "<reply at depth>=2>", "--body", "x", "--fields", "id,parentCommentId"],
    expected: "parentCommentId is the comment replied to",
    actual: "parentCommentId is the thread's top-level comment; `comment get <new id>` reports the true parent (seen 4 times on the Deep Thread page)",
  },
  {
    id: "comment-list-replies-one-level",
    repro: ["comment", "list", "<Deep Thread id>", "--replies"],
    expected: "replies nested to the depth of the thread, or an indication that deeper replies exist",
    actual: "only direct replies of each top-level comment; the 4 deeper levels are invisible and not flagged (need `comment replies <id>` recursively)",
  },
  {
    id: "exit3-timeout-not-retry-safe",
    repro: ["page", "create", "--space", "SZOFTVERFE", "--title", "<any>", "--file", "<large body>"],
    expected: "exit 3 (documented 'safe to retry') leaves nothing created",
    actual: "a create that timed out (exit 3) had been applied server-side; a blind retry returns HTTP 400 'already exists' (and a comment retry would duplicate)",
  },
  {
    id: "page-properties-no-write-and-ids",
    repro: ["page", "properties", "<id>", "--key", "nm-owner"],
    expected: "a way to set a property, and the property id/version needed to update it",
    actual: "list only; compact items hide id and version (only --full shows them); creating/updating needed `atl api POST/PUT /wiki/api/v2/pages/{id}/properties`",
  },
  {
    id: "page-restrict-404-hint",
    repro: ["page", "restrict", "<id>", "--state", "edit-restricted", "--yes"],
    expected: "an error naming the missing permission/scope",
    actual: "HTTP 404 'User must have permissions to update restrictions' with the hint 'check the id, key, or URL'; the id is fine, the token lacks the restriction scope",
  },
];

function writeManifest(): void {
  mkdirSync(OUT, { recursive: true });
  const pages: Record<string, Json> = {};
  for (const [key, state] of done) {
    const spec = specByKey.get(key);
    pages[key] = {
      id: state.id,
      title: state.title,
      space: state.space,
      type: state.type,
      version: state.version,
      ...(spec?.parent === undefined ? {} : { parentKey: spec.moveTo ?? spec.parent }),
      ...(spec?.moveTo === undefined ? {} : { createdUnder: spec.parent ?? "" }),
    };
  }
  const nmPages = [...registry.entries()].map(([k, m]) => [k, m.size] as const);
  const manifest = {
    generatedAt: new Date().toISOString(),
    site: SITE_URL,
    prefix: PREFIX,
    root: done.get("root")?.id,
    pages,
    comments: Object.fromEntries([...commentIds].map(([tag, c]) => [tag, { id: c.id, kind: c.kind, ...(c.resolution === undefined ? {} : { resolution: c.resolution }) }])),
    properties: Object.fromEntries(propIds),
    registryCounts: Object.fromEntries(nmPages),
    capabilities,
    observations,
    failures,
    facts: facts.map((f) => ({
      ...f,
      where: f.where.map((k) => ({ key: k, id: done.get(k)?.id, title: done.get(k)?.title })),
    })),
    atlCalls: calls,
    cliFindings: CLI_FINDINGS,
    notes: {
      probeResidue:
        "Pages AND OR NOT (and its variants, Q&A, Copy probe, Blog probe, Empty page) were created by capability probes before the script existed. The plan reproduces them exactly. The page AND OR NOT also carries 4 untagged probe comments (footer, 2 replies, 1 resolved inline plus its reply) that are not part of any fact.",
      commentMarker: "Every seeded comment body ends with ' (nm:<tag>)' (the idempotency marker); fact answers do not include it.",
      impossible:
        "No Confluence delete scope, no label write (401), no restriction write (404), no attachments, no space creation; see capabilities for what was attempted. Version timestamps cannot be backdated, so 'March' facts live in version messages.",
    },
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  log(`manifest written: ${MANIFEST}`);
}

const INDEX: [string, string][] = [
  ["hr", "Emberi Erőforrások (HR)"],
  ["legal", "Jogi osztály – Legal"],
  ["eng", "Engineering / Mérnökség"],
  ["fin", "Pénzügy – Finance"],
  ["sec", "Biztonság (Security)"],
  ["wide", "Wide Index"],
  ["special", "Special Titles"],
  ["body", "Body Stress"],
  ["history", "History Lab"],
  ["commentlab", "Comment Lab"],
];

/** The root links to its children, so its index is a second version written once they all exist. */
async function indexRoot(): Promise<void> {
  const root = done.get("root");
  if (root === undefined || !INDEX.every(([key]) => done.has(key))) {
    return;
  }
  const version = num(rec(await atl(["page", "get", root.id, "--fields", "version"]), "page get"), "version");
  if (version < 2) {
    const c = ctx();
    const body = ["# Corporate Wiki", "", "Root of the nightmare corpus. Sections:", "", ...INDEX.map(([key, label]) => `- ${pageLink(c, key, label)}`)].join("\n");
    root.version = num(rec(await atl(["page", "update", root.id, ...bodyArgs(body), "--message", "Add index"], true), "page update"), "version");
  } else {
    root.version = version;
  }
}

async function main(): Promise<number> {
  if (process.argv.includes("--dry")) {
    process.stdout.write(`${JSON.stringify({ pages: specs.length, comments: commentSpecs.length, props: propSpecs.length, facts: facts.length })}\n`);
    return 0;
  }
  await loadRegistry();
  const commentPages = [...new Set(commentSpecs.map((c) => c.page))];
  for (const spec of specs) {
    if (!selected(spec.group)) {
      continue;
    }
    try {
      await ensure(spec.key);
    } catch (error) {
      log(`page ${spec.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await indexRoot();
  for (const key of commentPages) {
    if (selected(specByKey.get(key)?.group ?? "")) {
      try {
        await seedComments(key);
      } catch (error) {
        log(`comments on ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const prop of propSpecs) {
    if (selected(specByKey.get(prop.page)?.group ?? "")) {
      try {
        await seedProps(prop);
      } catch (error) {
        failures.push({ phase: "props", what: prop.page, code: error instanceof Failure ? error.code : "script", message: String(error), argv: [] });
      }
    }
  }
  if (selected("history")) {
    try {
      await seedCopies();
    } catch (error) {
      failures.push({ phase: "copy", what: "retention", code: error instanceof Failure ? error.code : "script", message: String(error), argv: [] });
    }
  }
  if (selected("history") && selected("personal")) {
    await probeCapabilities();
  }
  writeManifest();
  log(`done: ${done.size} pages realized, ${commentIds.size} comments, ${failures.length} failures, ${calls} atl calls`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
