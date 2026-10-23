#!/usr/bin/env bun
/**
 * Corporate-nightmare "chaos" Jira seed (idempotent): state that only a careful reader gets right, planted through
 * the atl binary in project NMS (plus one short-lived KAN issue).
 *
 *  - moved:       a KAN issue with a comment and two worklogs is moved to NMS with `atl bulk move`, so its key changes
 *                 (the old key still resolves) and it is planned into the future sprint "NMS Sprint 4". A reader that
 *                 trusts the old key sees neither the new key, the sprint nor the full logged time.
 *  - delivered:   the epic "Checkout v2" has seven children. Five are in statusCategory done, but only three were
 *                 delivered (resolution Kész); one is resolution "Won't Do", one "Másolat" (duplicate). Counting
 *                 Done-status issues gives 5, the true answer is 3.
 *  - reopened:    a bug is fixed (Kész, comment "fixed"), then reopened with a regression comment and put back in
 *                 progress. The "fixed in" comment is still there; the current state is in progress.
 *  - contradicts: the description names one owner and go-live date, a later comment overrides both, the comment was
 *                 edited once more (date changed again), and a third comment calls the description obsolete.
 *
 * Why NMS sprints: open chaos issues sit in the future sprint "NMS Sprint 4", never in the active sprint and never in
 * the sprint-less backlog, so the facts of the existing scrum scenarios (n16-n19: active-sprint points, velocity,
 * backlog size) stay valid; seed-scrum.ts keeps verifying them. No chaos issue carries fixVersion 1.1.
 *
 * Idempotent: content is found by the exact summary prefix `atl smoke nm chaos ` (JQL over KAN and NMS); every step
 * checks live state first, a re-run creates nothing. Everything planted is read back; any divergence exits 1.
 *
 *   bun eval/nightmare/seed-chaos-jira.ts
 *   NM_ATL=/path/to/atl bun eval/nightmare/seed-chaos-jira.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/core/guards.ts";

const ATL = process.env.NM_ATL ?? "/tmp/atl-eval/bin/atl";
const PREFIX = "atl smoke nm chaos ";
const SPRINT_ID = 5;
const SPRINT_NAME = "NMS Sprint 4";
const ACTIVE_SPRINT_ID = 4;
const OUT_DIR = join(import.meta.dir, "..", ".out", "nightmare");
const MANIFEST_PATH = join(OUT_DIR, "chaos-jira.json");
const MAX_ATTEMPTS = 5;
const DONE = "Kész";
const TODO = "Teendő";
const IN_PROGRESS = "Folyamatban";

type Obj = Record<string, unknown>;

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let created = 0;
const checks: string[] = [];

function log(message: string): void {
  process.stderr.write(`[nm-chaos-jira] ${message}\n`);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Obj {
  return isRecord(value) ? value : {};
}

function items(value: unknown): Obj[] {
  return asArray(record(value).items).filter(isRecord);
}

/** Comment and description bodies are a string or a list of lines. */
function bodyText(value: unknown): string {
  return typeof value === "string" ? value : asArray(value).map(asString).join("\n");
}

async function spawnAtl(argv: string[]): Promise<Run> {
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawn([ATL, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 3 || attempt >= MAX_ATTEMPTS) {
      return { exitCode, stdout, stderr };
    }
    log(`atl ${argv.join(" ")}: transient, retrying`);
    await Bun.sleep(1500 * 2 ** (attempt - 1));
  }
}

async function atl(argv: string[]): Promise<unknown> {
  const run = await spawnAtl(argv);
  if (run.exitCode !== 0) {
    throw new Error(`atl ${argv.join(" ")} exited ${run.exitCode}: ${(run.stderr.trim() || run.stdout.trim()).slice(0, 300)}`);
  }
  return JSON.parse(run.stdout);
}

function expect(label: string, live: unknown, expected: unknown): void {
  const a = JSON.stringify(live);
  const b = JSON.stringify(expected);
  if (a !== b) {
    checks.push(`${label}: live ${a} vs expected ${b}`);
  }
}

function expectTrue(label: string, ok: boolean): void {
  if (!ok) {
    checks.push(`${label}: expected true`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Live state helpers

interface Found {
  key: string;
  project: string;
}

async function findChaos(): Promise<Map<string, Found>> {
  const result = await atl(["jql", `project in (KAN, NMS) AND summary ~ "atl smoke nm chaos" ORDER BY created ASC`, "--all"]);
  const found = new Map<string, Found>();
  for (const item of items(result)) {
    const summary = asString(item.summary);
    const key = asString(item.key);
    if (summary.startsWith(PREFIX) && !found.has(summary)) {
      found.set(summary, { key, project: key.split("-")[0] ?? "" });
    }
  }
  return found;
}

interface IssueState {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  resolution: string | null;
  type: string;
  parent: string | null;
  sprints: string[];
  description: string;
}

async function state(key: string): Promise<IssueState> {
  const raw = record(await atl(["issue", "get", key, "--issue-fields", "summary,status,resolution,issuetype,parent,customfield_10020,description"]));
  return {
    key: asString(raw.key),
    summary: asString(raw.summary),
    status: asString(raw.status),
    statusCategory: asString(raw.statusCategory),
    resolution: typeof raw.resolution === "string" ? raw.resolution : null,
    type: asString(raw.type),
    parent: isRecord(raw.parent) ? asString(raw.parent.key) : null,
    sprints: asArray(raw.customfield_10020).map((sprint) => asString(record(sprint).name)),
    description: bodyText(raw.description),
  };
}

interface Comment {
  id: string;
  body: string;
}

async function comments(key: string): Promise<Comment[]> {
  return items(await atl(["issue", "comments", key, "--all"])).map((item) => ({ id: asString(item.id), body: bodyText(item.body) }));
}

/** Adds the comment unless one whose body contains `marker` exists; returns the comment. */
async function ensureComment(key: string, marker: string, body: string): Promise<Comment> {
  const existing = (await comments(key)).find((comment) => comment.body.includes(marker));
  if (existing !== undefined) {
    return existing;
  }
  const added = record(await atl(["issue", "comment", key, "--body", body]));
  log(`${key}: comment added (${marker})`);
  created += 1;
  return { id: asString(added.id), body };
}

async function create(args: string[]): Promise<string> {
  const result = record(await atl(["issue", "create", ...args]));
  created += 1;
  return asString(result.key);
}

async function ensureIssue(found: Map<string, Found>, summary: string, args: string[]): Promise<string> {
  const hit = found.get(summary);
  if (hit !== undefined) {
    return hit.key;
  }
  const key = await create(["--summary", summary, ...args]);
  found.set(summary, { key, project: key.split("-")[0] ?? "" });
  log(`created ${key} ${summary}`);
  return key;
}

async function moveTo(key: string, status: string): Promise<void> {
  await atl(["issue", "move", key, status]);
  log(`${key}: moved to ${status}`);
}

/**
 * Moves to Kész (which stamps resolution Kész) and then sets the wanted resolution with `issue update`; the transition
 * screen has no resolution field, and `{"name":"Másolat"}` is rejected (HTTP 400) while `{"id":...}` works.
 */
async function ensureDone(key: string, resolution: string): Promise<void> {
  let current = await state(key);
  if (current.status !== DONE) {
    await moveTo(key, DONE);
    current = await state(key);
  }
  if (current.resolution !== resolution) {
    const id = items(await atl(["resolution", "list"])).find((entry) => asString(entry.name) === resolution)?.id;
    if (id === undefined) {
      throw new Error(`unknown resolution ${resolution}`);
    }
    await atl(["issue", "update", key, "--set", `resolution=${JSON.stringify({ id })}`]);
    log(`${key}: resolution ${current.resolution ?? "none"} -> ${resolution}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Planted data

const MOVED = {
  summary: `${PREFIX}moved: Invoice export times out on large accounts`,
  comment: "Reproduced with account 4411: 6200 invoices, export dies after 30 s.",
  logs: [
    { time: "2h", comment: "Reproduction and profiling" },
    { time: "1h 30m", comment: "Streaming export prototype" },
  ],
  totalSeconds: 12600,
  totalText: "3h 30m",
};

const EPIC_SUMMARY = `${PREFIX}Epic: Checkout v2`;

interface Child {
  tag: string;
  summary: string;
  body: string;
  /** Final state: a resolution for done issues, otherwise the open status. */
  final: { resolution: string } | { status: string };
  comment: string;
}

const CHILDREN: Child[] = [
  {
    tag: "saved-cards",
    summary: `${PREFIX}Checkout v2: saved cards`,
    body: "Let returning customers pay with a stored card.",
    final: { resolution: "Kész" },
    comment: "Built, merged and released to all shops.",
  },
  {
    tag: "apple-pay",
    summary: `${PREFIX}Checkout v2: Apple Pay`,
    body: "Apple Pay button on the payment step.",
    final: { resolution: "Kész" },
    comment: "Live in production since the last release.",
  },
  {
    tag: "address-autocomplete",
    summary: `${PREFIX}Checkout v2: address autocomplete`,
    body: "Suggest addresses while the customer types.",
    final: { resolution: "Kész" },
    comment: "Shipped; the postcode lookup is behind a feature flag that is on.",
  },
  {
    tag: "guest-checkout",
    summary: `${PREFIX}Checkout v2: guest checkout`,
    body: "Guest checkout without account creation.",
    final: { resolution: "Won't Do" },
    comment: "Dropped: legal wants an account for every order. Nothing was built.",
  },
  {
    tag: "card-tokenisation",
    summary: `${PREFIX}Checkout v2: card tokenisation`,
    body: "Tokenise card data before it reaches our servers.",
    final: { resolution: "Másolat" },
    comment: "Duplicate of the saved cards work, closed without any change of its own.",
  },
  {
    tag: "three-d-secure",
    summary: `${PREFIX}Checkout v2: 3-D Secure`,
    body: "Strong customer authentication for card payments.",
    final: { status: IN_PROGRESS },
    comment: "Vendor sandbox access arrived; integration started.",
  },
  {
    tag: "confirmation-email",
    summary: `${PREFIX}Checkout v2: order confirmation email`,
    body: "Redesigned order confirmation email.",
    final: { status: TODO },
    comment: "Waiting for the new template from design.",
  },
];

const BUG = {
  summary: `${PREFIX}Bug: Duplicate charge on payment retry`,
  body: "When a card payment is retried after a gateway timeout the customer is charged twice.",
  fixComment: "Fixed: the retry now reuses the idempotency key. Verified on staging, released with 1.1.",
  reopenComment:
    "Reopening: regression in production. A customer was charged twice again after the 1.1 release (order 8841). The idempotency key is lost when the retry goes through the fallback gateway.",
  fixMarker: "reuses the idempotency key",
  reopenMarker: "Reopening: regression in production",
};

const OWNERSHIP = {
  summary: `${PREFIX}Story: Data-retention sign-off`,
  description: "Sign-off for the new customer data-retention schedule.\n\nOwner: Kovács Anna\nGo-live: 2026-12-01",
  first: "Owner is now Szabó Béla (Anna moved to the audit team). Go-live moves to 2026-12-15.",
  edited: "Owner is now Szabó Béla (Anna moved to the audit team). Go-live moves to 2026-12-18, the 15th clashes with the release freeze.",
  third: "FYI Kovács Anna stays on as legal reviewer only. The owner and the go-live date in the description are obsolete.",
  firstMarker: "Owner is now Szabó Béla",
  thirdMarker: "stays on as legal reviewer only",
  owner: "Szabó Béla",
  previousOwner: "Kovács Anna",
  goLive: "2026-12-18",
  descriptionGoLive: "2026-12-01",
  editedAwayGoLive: "2026-12-15",
};

// ---------------------------------------------------------------------------------------------------------------------
// Seeding

interface Planted {
  moved: { oldKey: string; key: string };
  epic: string;
  children: Map<string, string>;
  bug: string;
  ownership: string;
  commentIds: { owner: string; third: string };
}

async function seedMoved(found: Map<string, Found>): Promise<{ oldKey: string; key: string }> {
  let hit = found.get(MOVED.summary);
  if (hit === undefined) {
    const key = await create([
      "--project", "KAN", "--type", "Feladat", "--summary", MOVED.summary, "--body",
      "Customers with more than 5000 invoices get a gateway timeout on CSV export. Raised on the KAN board before the Billing team moved to the NMS scrum project.",
    ]);
    hit = { key, project: "KAN" };
    found.set(MOVED.summary, hit);
    log(`created ${key} ${MOVED.summary}`);
  }
  let oldKey: string | undefined = hit.project === "KAN" ? hit.key : undefined;
  if (oldKey === undefined) {
    const history = items(await atl(["issue", "changelog", hit.key, "--all"]));
    for (const entry of history) {
      for (const change of asArray(entry.changes).map(record)) {
        if (asString(change.field) === "Key" && asString(change.to) === hit.key) {
          oldKey = asString(change.from);
        }
      }
    }
    if (oldKey === undefined) {
      throw new Error(`${hit.key}: no Key change in the changelog, cannot recover the old key`);
    }
  }
  const key = hit.key;
  await ensureComment(key, "Reproduced with account 4411", `${MOVED.comment} ${oldKey} is the ticket customer support links to.`);
  const logged = new Set(items(await atl(["issue", "worklogs", key])).flatMap((entry) => asArray(entry.comment).map(asString)));
  for (const entry of MOVED.logs) {
    if (!logged.has(entry.comment)) {
      await atl(["issue", "log", key, entry.time, "--comment", entry.comment]);
      log(`${key}: logged ${entry.time}`);
      created += 1;
    }
  }
  let target = key;
  if (hit.project === "KAN") {
    const moved = record(await atl(["bulk", "move", key, "--project", "NMS", "--type", "Feladat"]));
    if (asString(moved.status) !== "COMPLETE") {
      throw new Error(`bulk move of ${key} ended ${JSON.stringify(moved)}`);
    }
    const resolved = record(await atl(["issue", "get", key, "--issue-fields", "summary"]));
    target = asString(resolved.key);
    log(`${key} moved to ${target}`);
    created += 1;
  }
  const current = await state(target);
  if (!current.sprints.includes(SPRINT_NAME)) {
    await atl(["issue", "update", target, "--set", `Sprint=${SPRINT_ID}`]);
    log(`${target}: sprint ${SPRINT_NAME}`);
  }
  return { oldKey, key: target };
}

async function seedEpic(found: Map<string, Found>): Promise<{ epic: string; children: Map<string, string> }> {
  const epic = await ensureIssue(found, EPIC_SUMMARY, ["--project", "NMS", "--type", "Eposz", "--body", "Checkout rewrite. Scope tracked through the child issues."]);
  const children = new Map<string, string>();
  for (const child of CHILDREN) {
    const sprint = "status" in child.final ? ["--set", `Sprint=${SPRINT_ID}`] : [];
    const key = await ensureIssue(found, child.summary, ["--project", "NMS", "--type", "Story", "--parent", epic, "--body", child.body, ...sprint]);
    children.set(child.tag, key);
    await ensureComment(key, child.comment.slice(0, 24), child.comment);
    if ("resolution" in child.final) {
      await ensureDone(key, child.final.resolution);
    } else if ((await state(key)).status !== child.final.status) {
      await moveTo(key, child.final.status);
    }
  }
  return { epic, children };
}

async function seedBug(found: Map<string, Found>): Promise<string> {
  const key = await ensureIssue(found, BUG.summary, ["--project", "NMS", "--type", "Bug", "--body", BUG.body, "--set", `Sprint=${SPRINT_ID}`]);
  const seen = await comments(key);
  const fixed = seen.some((comment) => comment.body.includes(BUG.fixMarker));
  const reopened = seen.some((comment) => comment.body.includes(BUG.reopenMarker));
  if (!fixed) {
    const current = await state(key);
    if (current.status === TODO) {
      await moveTo(key, IN_PROGRESS);
    }
    await moveTo(key, DONE);
    await ensureComment(key, BUG.fixMarker, BUG.fixComment);
  }
  if (!reopened) {
    await moveTo(key, IN_PROGRESS);
    await ensureComment(key, BUG.reopenMarker, BUG.reopenComment);
  }
  const current = await state(key);
  if (current.status !== IN_PROGRESS) {
    await moveTo(key, IN_PROGRESS);
  }
  if ((await state(key)).resolution !== null) {
    await atl(["issue", "update", key, "--set", "resolution=null"]);
    log(`${key}: resolution cleared`);
  }
  return key;
}

async function seedOwnership(found: Map<string, Found>): Promise<{ key: string; owner: string; third: string }> {
  const key = await ensureIssue(found, OWNERSHIP.summary, [
    "--project", "NMS", "--type", "Story", "--body", OWNERSHIP.description, "--set", `Sprint=${SPRINT_ID}`,
  ]);
  const owner = await ensureComment(key, OWNERSHIP.firstMarker, OWNERSHIP.first);
  if (!owner.body.includes(OWNERSHIP.goLive)) {
    await atl(["issue", "comment", key, "--edit", owner.id, "--body", OWNERSHIP.edited]);
    log(`${key}: comment ${owner.id} edited`);
  }
  const third = await ensureComment(key, OWNERSHIP.thirdMarker, OWNERSHIP.third);
  return { key, owner: owner.id, third: third.id };
}

// ---------------------------------------------------------------------------------------------------------------------
// Read-back verification

async function verify(planted: Planted): Promise<Obj> {
  const movedNow = await state(planted.moved.key);
  expect("moved: project", planted.moved.key.startsWith("NMS-"), true);
  expect("moved: summary", movedNow.summary, MOVED.summary);
  expect("moved: sprint", movedNow.sprints, [SPRINT_NAME]);
  expect("moved: status", movedNow.status, TODO);
  const viaOld = record(await atl(["issue", "get", planted.moved.oldKey, "--issue-fields", "summary"]));
  expect("moved: old key resolves to the new key", asString(viaOld.key), planted.moved.key);
  const movedLogs = record(await atl(["issue", "worklogs", planted.moved.key]));
  expect("moved: logged seconds", movedLogs.totalSeconds, MOVED.totalSeconds);
  expectTrue("moved: comment survived the move", (await comments(planted.moved.key)).some((c) => c.body.includes("Reproduced with account 4411")));
  const jqlOld = items(await atl(["jql", "project = KAN AND summary ~ \"atl smoke nm chaos\""]));
  expect("moved: nothing chaos left in KAN", jqlOld.length, 0);

  const epicState = await state(planted.epic);
  expect("epic: type", epicState.type, "Eposz");
  const delivered: string[] = [];
  const wontDo: string[] = [];
  const duplicate: string[] = [];
  const open: string[] = [];
  for (const child of CHILDREN) {
    const key = planted.children.get(child.tag) ?? "";
    const live = await state(key);
    expect(`${child.tag}: parent`, live.parent, planted.epic);
    if ("resolution" in child.final) {
      expect(`${child.tag}: status`, live.status, DONE);
      expect(`${child.tag}: statusCategory`, live.statusCategory, "done");
      expect(`${child.tag}: resolution`, live.resolution, child.final.resolution);
      if (child.final.resolution === "Kész") {
        delivered.push(child.tag);
      } else if (child.final.resolution === "Won't Do") {
        wontDo.push(child.tag);
      } else {
        duplicate.push(child.tag);
      }
    } else {
      expect(`${child.tag}: status`, live.status, child.final.status);
      expect(`${child.tag}: sprint`, live.sprints, [SPRINT_NAME]);
      open.push(child.tag);
    }
  }
  const tree = record(await atl(["jql", `parent = ${planted.epic}`, "--group-by", "statusCategory"]));
  expect("epic: children by status category", record(tree.groups), { done: 5, new: 1, indeterminate: 1 });

  const bug = await state(planted.bug);
  expect("bug: status", bug.status, IN_PROGRESS);
  expect("bug: resolution", bug.resolution, null);
  const bugHistory = items(await atl(["issue", "changelog", planted.bug, "--all"]));
  const statusPath = bugHistory.flatMap((entry) => asArray(entry.changes).map(record).filter((change) => asString(change.field) === "status").map((change) => asString(change.to)));
  expect("bug: status history", statusPath, [IN_PROGRESS, DONE, IN_PROGRESS]);
  const bugComments = await comments(planted.bug);
  expect("bug: comment count", bugComments.length, 2);
  expect("bug: fix comment first", bugComments[0]?.body.includes(BUG.fixMarker), true);
  expect("bug: reopen comment last", bugComments[1]?.body.includes(BUG.reopenMarker), true);

  const owner = await state(planted.ownership);
  expectTrue("ownership: description names the old owner and date", owner.description.includes(OWNERSHIP.previousOwner) && owner.description.includes(OWNERSHIP.descriptionGoLive));
  const ownerComments = await comments(planted.ownership);
  expect("ownership: comment count", ownerComments.length, 2);
  expect("ownership: edited comment", ownerComments[0]?.body, OWNERSHIP.edited);
  expectTrue("ownership: first date edited away", !ownerComments.some((c) => c.body.includes(OWNERSHIP.editedAwayGoLive)));
  expect("ownership: third comment", ownerComments[1]?.body, OWNERSHIP.third);

  const stray = items(
    await atl(["jql", `project = NMS AND summary ~ "atl smoke nm chaos" AND sprint is EMPTY AND statusCategory != Done AND issuetype != Epic`]),
  );
  expect("guard: open chaos issues in no sprint (would join the NMS backlog)", stray.map((item) => asString(item.key)), []);
  const strayActive = items(await atl(["jql", `summary ~ "atl smoke nm chaos" AND sprint = ${ACTIVE_SPRINT_ID}`]));
  expect("guard: chaos issues in the active sprint", strayActive.map((item) => asString(item.key)), []);
  const fixVersioned = items(await atl(["jql", `summary ~ "atl smoke nm chaos" AND fixVersion = "1.1"`]));
  expect("guard: chaos issues with fixVersion 1.1", fixVersioned.map((item) => asString(item.key)), []);

  return { delivered, wontDo, duplicate, open };
}

function facts(planted: Planted): Obj[] {
  const key = (tag: string): string => planted.children.get(tag) ?? "";
  return [
    {
      id: "chaos-moved",
      question: `Where does ${planted.moved.oldKey} live now (current key), which sprint is it planned in and how much time is logged on it in total?`,
      answer: `${planted.moved.key} in project NMS; ${SPRINT_NAME}; ${MOVED.totalText} (${MOVED.logs.map((entry) => entry.time).join(" + ")})`,
      whyHard: `bulk move changed the key (${planted.moved.oldKey} still resolves, so a reader that stops at the old key never notices); the sprint was set after the move; the issue shows both worklogs, 2h alone is a decoy`,
    },
    {
      id: "chaos-delivered",
      question: "Which children of the Checkout v2 epic were actually delivered, and how many?",
      answer: `3: saved cards (${key("saved-cards")}), Apple Pay (${key("apple-pay")}), address autocomplete (${key("address-autocomplete")})`,
      whyHard: `5 children are in status Kész; ${key("guest-checkout")} is resolution Won't Do, ${key("card-tokenisation")} is Másolat (duplicate); ${key("three-d-secure")} and ${key("confirmation-email")} are still open`,
    },
    {
      id: "chaos-reopened",
      question: "Was the duplicate-charge-on-retry bug fixed and shipped?",
      answer: `No, not any more: it was fixed and released with 1.1, then reopened after a production regression; ${planted.bug} is In Progress`,
      whyHard: "the fix comment and a Kész transition exist; only the later reopen comment and the current status say otherwise",
    },
    {
      id: "chaos-contradicting",
      question: "Who owns the data-retention sign-off now and what is the go-live date?",
      answer: `${OWNERSHIP.owner}; ${OWNERSHIP.goLive}`,
      whyHard: `the description says ${OWNERSHIP.previousOwner} and ${OWNERSHIP.descriptionGoLive}; a comment overrides both and was edited once (it first said ${OWNERSHIP.editedAwayGoLive}); a third comment keeps ${OWNERSHIP.previousOwner} as reviewer only`,
    },
  ];
}

async function main(): Promise<void> {
  const found = await findChaos();
  log(`found ${found.size} existing chaos issues`);
  const moved = await seedMoved(found);
  const { epic, children } = await seedEpic(found);
  const bug = await seedBug(found);
  const ownership = await seedOwnership(found);
  const planted: Planted = { moved, epic, children, bug, ownership: ownership.key, commentIds: { owner: ownership.owner, third: ownership.third } };
  const buckets = await verify(planted);

  const manifest = {
    generatedAt: new Date().toISOString(),
    moved: { ...moved, summary: MOVED.summary, sprint: SPRINT_NAME, totalSeconds: MOVED.totalSeconds, totalText: MOVED.totalText },
    epic: { key: epic, summary: EPIC_SUMMARY, ...buckets },
    children: Object.fromEntries(CHILDREN.map((child) => [child.tag, { key: children.get(child.tag), summary: child.summary, final: child.final }])),
    bug: { key: bug, summary: BUG.summary },
    ownership: { key: ownership.key, summary: OWNERSHIP.summary, commentIds: planted.commentIds },
    facts: facts(planted),
    createdThisRun: created,
    consistencyChecks: checks,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote ${MANIFEST_PATH}; ${created} writes this run; ${checks.length} failed checks`);
  for (const failure of checks) {
    log(`CHECK FAILED ${failure}`);
  }
  if (checks.length > 0) {
    process.exit(1);
  }
}

await main();
