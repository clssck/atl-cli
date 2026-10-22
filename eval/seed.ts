#!/usr/bin/env bun
/**
 * Seed the eval trial site (Jira project KAN, Confluence space SZOFTVERFE) with deterministic,
 * realistic data plus seven "needles" with known answers, read every needle back with atl, and
 * write the ground truth to eval/.out/manifest.json.
 *
 * Usage: bun eval/seed.ts [--dry] [--force]
 *   --dry    print the plan (counts, titles, needle specs) and send nothing
 *   --force  run even though a manifest (or a partial one from an interrupted run) exists
 *
 * All content comes from a fixed-seed PRNG, so the plan is identical on every run; ids and keys are
 * not. The token has no delete scope and every create makes a new object, so an existing manifest
 * blocks a second run unless --force is given.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/core/guards.ts";

const ATL = "/tmp/atl-eval/atl";
const SITE = "foldvarszki.atlassian.net";
const PROJECT = "KAN";
const SPACE = "SZOFTVERFE";
const HOME_PAGE = "196724";
const PREFIX = "atl smoke eval";
const SEED = 20_261_021;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const VERIFY_ATTEMPTS = 4;
const OUT = join(import.meta.dir, ".out");
const BODIES = join(OUT, "bodies");
const MANIFEST = join(OUT, "manifest.json");
const PARTIAL = join(OUT, "manifest.partial.json");
const TRANSIENT_TEXT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i;

const PHRASES = {
  budgetRow: "| Rollout budget | 48,210 EUR |",
  budget: "48,210 EUR",
  quartzLabel: "needle-quartz",
  rollback: "rollback window is 37 minutes",
  coldRow: "| Cold storage retention | 410 days |",
  cold: "Cold storage retention",
  lantern: "quartz lantern protocol",
  latency: "latency budget",
} as const;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`index ${index} out of range (length ${items.length})`);
  }
  return item;
}

/** mulberry32: tiny, fast, and stable across runtimes, which is all a seeded content plan needs. */
class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d_2b_79_f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return at(items, this.int(0, items.length - 1));
  }

  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) {
        return value;
      }
    }
    return at(entries, entries.length - 1)[0];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = at(copy, i);
      copy[i] = at(copy, j);
      copy[j] = a;
    }
    return copy;
  }

  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, count);
  }

  hex(length: number): string {
    let out = "";
    while (out.length < length) {
      out += this.int(0, 15).toString(16);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const SERVICES = [
  "ledger-api",
  "auth-gateway",
  "search-indexer",
  "mobile-bff",
  "settlement-worker",
  "notification-hub",
  "risk-engine",
  "config-service",
  "checkout-web",
  "billing-scheduler",
  "identity-sync",
  "catalog-api",
] as const;
const TEAMS = ["Payments Core", "Identity", "Discovery", "Platform", "Mobile Apps", "Reliability"];
const PEOPLE = [
  "Ágnes Kovács",
  "Bence Tóth",
  "Csilla Nagy",
  "Dávid Szabó",
  "Eszter Horváth",
  "Gergő Varga",
  "Hanna Kiss",
  "Levente Molnár",
];
const PROBLEMS = [
  "retries failed requests without backoff",
  "holds a global lock while flushing batches",
  "logs full request bodies, including card tokens",
  "returns stale data for up to ten minutes after a write",
  "drops events when the internal queue is full",
  "times out on cold starts right after a deploy",
  "opens a new database connection per request",
  "ignores the cancellation signal from upstream callers",
];
const SYMPTOMS = [
  "duplicate refunds were issued",
  "users were logged out in the middle of checkout",
  "search returned empty result pages",
  "pods were evicted during peak traffic",
  "the mobile app showed an outdated cart",
  "alerts fired without a clear owner",
  "settlement files arrived after the bank cut-off",
  "config pushes reached only half of the fleet",
];
const GOALS = [
  "removes the manual step from the release checklist",
  "cuts the median response time roughly in half",
  "makes the failure mode visible on the on-call dashboard",
  "lets us retire the legacy cron job",
  "keeps the public API contract backward compatible",
  "reduces the blast radius of a bad config push",
  "brings the service in line with the platform defaults",
];
const CONSTRAINTS = [
  "a schema migration",
  "downtime for merchants",
  "changing the public API",
  "a new third-party dependency",
  "extra on-call load",
  "touching the mobile release train",
];
const MEETINGS = ["architecture review", "weekly sync", "incident retro", "quarterly planning", "design crit"];
const DECISIONS = [
  "ship behind a feature flag first",
  "keep the old endpoint for two more releases",
  "measure before optimising any further",
  "split the work across two sprints",
  "ask security for a review before the rollout",
  "run a game day before enabling it in production",
];
const FALLBACKS = [
  "serves the cached response and emits a warning metric",
  "routes traffic back to the previous version within one deploy",
  "queues the request and retries with jitter",
  "fails closed and pages the owning team",
];
const FLAGS = ["ledger.v2.writes", "auth.passkeys", "search.typo-tolerance", "mobile.offline-cart", "infra.new-ingress"];
const METRICS = [
  "p50 latency",
  "p99 latency",
  "error rate",
  "throughput",
  "CPU utilisation",
  "memory headroom",
  "queue depth",
  "cache hit ratio",
  "cold start time",
  "crash-free sessions",
];
const VERBS = [
  "Add",
  "Fix",
  "Refactor",
  "Instrument",
  "Harden",
  "Document",
  "Backfill",
  "Cache",
  "Throttle",
  "Migrate",
  "Simplify",
  "Load-test",
  "Validate",
  "Paginate",
  "Rework",
];
const STORY_LEADS = [
  "Merchants get reliable",
  "Support agents can inspect",
  "Admins can configure",
  "Mobile users benefit from",
  "Finance can audit",
  "On-call engineers can trace",
];
const SUBTASK_VERBS = ["Write tests for", "Update the runbook for", "Add metrics for", "Review the PR for", "Pair on"];
const EXTRA_LABELS = ["tech-debt", "customer-reported", "security", "perf", "q4-okr"];
const SHORT_COMMENTS = [
  "LGTM, merging after the canary looks clean.",
  "Picked this up, will post an update tomorrow.",
  "Blocked on the vendor sandbox being down again.",
  "Moved to next sprint, the dependency slipped.",
  "Pairing with the platform team on this one.",
  "Can we get a second reviewer from security?",
  "Repro confirmed on staging with the latest build.",
];
const PRIORITY_WEIGHTS = [
  ["Highest", 8],
  ["High", 25],
  ["Medium", 45],
  ["Low", 15],
  ["Lowest", 7],
] as const;

type Status = "Teendő" | "Folyamatban" | "Ellenőrzés alatt" | "Kész";
const STATUS_WEIGHTS: readonly (readonly [Status, number])[] = [
  ["Teendő", 40],
  ["Folyamatban", 40],
  ["Ellenőrzés alatt", 10],
  ["Kész", 10],
];

interface Area {
  labels: string[];
  epic: string;
  objects: string[];
}

const AREAS: Area[] = [
  {
    labels: ["payments"],
    epic: "Payments ledger v2",
    objects: [
      "refund idempotency keys",
      "currency rounding in invoices",
      "settlement batch retries",
      "3DS challenge timeout handling",
      "the chargeback webhook parser",
      "double-entry balance checks",
      "the payout reconciliation report",
      "FX rate snapshotting",
      "partial capture support",
      "the ledger export to the data lake",
    ],
  },
  {
    labels: ["auth"],
    epic: "Unified login and SSO",
    objects: [
      "SAML assertion validation",
      "refresh token rotation",
      "the MFA enrolment flow",
      "session revocation on password reset",
      "OIDC discovery caching",
      "service account key expiry",
      "login rate limiting",
      "SCIM group sync",
      "passkey registration",
      "the audit log for admin logins",
    ],
  },
  {
    labels: ["search"],
    epic: "Search relevance overhaul",
    objects: [
      "the synonym dictionary reload",
      "typo tolerance for SKUs",
      "facet count accuracy",
      "index rebuild throttling",
      "the query latency histogram",
      "boosting for in-stock items",
      "the autocomplete prefix cache",
      "multilingual stemming",
      "zero-result query logging",
      "reindexing on catalog updates",
    ],
  },
  {
    labels: ["infra"],
    epic: "Kubernetes platform migration",
    objects: [
      "node pool autoscaling",
      "ingress TLS renewal",
      "the Helm chart for ledger-api",
      "pod disruption budgets",
      "secret rotation via the vault operator",
      "the cluster upgrade runbook",
      "egress NAT gateway costs",
      "container image signing",
      "namespace quota defaults",
      "cross-zone traffic costs",
    ],
  },
  {
    labels: ["mobile"],
    epic: "Mobile offline mode",
    objects: [
      "offline cart persistence",
      "the background sync scheduler",
      "conflict resolution for edits",
      "push notification deep links",
      "crash reporting symbol upload",
      "app start time on Android",
      "biometric unlock",
      "the download size limit",
      "image cache eviction",
      "the offline feature flag bootstrap",
    ],
  },
  {
    labels: ["infra", "observability"],
    epic: "Observability and SLOs",
    objects: [
      "trace sampling rules",
      "the SLO burn-rate alerts",
      "log volume per namespace",
      "the synthetic checkout probe",
      "metric cardinality limits",
      "the on-call handover report",
      "error budget reporting",
      "dashboard ownership tags",
      "structured logging in workers",
      "alert routing to team channels",
    ],
  },
];
const EPIC_STATUSES: readonly Status[] = ["Folyamatban", "Folyamatban", "Folyamatban", "Folyamatban", "Teendő", "Kész"];

const HANDBOOK_DOMAINS = [
  "Onboarding",
  "Access management",
  "Local development",
  "Code review",
  "Branching and merging",
  "Continuous integration",
  "Release management",
  "Feature flags",
  "Incident response",
  "On-call rotations",
  "Postmortems",
  "Monitoring",
  "Alerting",
  "Logging",
  "Distributed tracing",
  "Capacity planning",
  "Cost management",
  "Security reviews",
  "Secrets handling",
  "Dependency updates",
  "Data retention and storage tiers",
  "Backups",
  "Disaster recovery",
  "Database migrations",
  "API versioning",
  "Service ownership",
  "Documentation standards",
  "Accessibility",
  "Performance testing",
  "Vendor management",
];
const HANDBOOK_ASPECTS = ["overview", "procedures", "reference"];
const NEEDLE_SECTION = 63;

const ARCH_CHILDREN = [
  "Ledger service",
  "Settlement pipeline",
  "Payout engine",
  "Risk scoring",
  "Auth gateway",
  "Session store",
  "Identity sync",
  "Search indexer",
  "Query service",
  "Catalog API",
  "Checkout web",
  "Mobile BFF",
  "Offline sync",
  "Notification hub",
  "Email delivery",
  "Billing scheduler",
  "Config service",
  "Feature flag service",
  "Edge network",
  "API gateway rate limiting",
  "Service mesh",
  "Event bus",
  "Data lake ingestion",
  "Reporting warehouse",
  "Secrets management",
  "CI/CD pipeline",
  "Observability stack",
  "Disaster recovery",
  "Multi-region failover",
  "Cost allocation",
];
const ARCH_GRANDCHILDREN: Record<string, string[]> = {
  "Ledger service": ["Double-entry model", "Balance snapshots"],
  "Auth gateway": ["Token formats", "Signing key rotation"],
  "Search indexer": ["Index schema"],
  "Mobile BFF": ["GraphQL schema"],
  "Edge network": ["Edge relay handshake", "TLS termination", "DDoS mitigation"],
  "Event bus": ["Topic naming", "Consumer groups"],
  "Observability stack": ["Trace sampling"],
  "Disaster recovery": ["Restore drills", "RPO and RTO targets"],
};
const LANTERN_PARENT = "Edge network";
const LANTERN_PAGE = "Edge relay handshake";
const LATENCY_PAGE = "API gateway rate limiting";

// ---------------------------------------------------------------------------
// Markdown generators
// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function sentence(r: Rng): string {
  const svc = r.pick(SERVICES);
  const other = r.pick(SERVICES);
  const ms = r.int(40, 900);
  const templates = [
    () => `The ${svc} service currently ${r.pick(PROBLEMS)}.`,
    () => `Over the last ${r.int(2, 8)} weeks we saw ${r.int(2, 40)} incidents where ${r.pick(SYMPTOMS)}.`,
    () => `${r.pick(TEAMS)} owns the rollout and ${r.pick(PEOPLE)} is the point of contact for questions.`,
    () => `p99 latency for ${svc} sits at ${ms} ms against a target of ${Math.round(ms * 0.6)} ms.`,
    () => `Roughly ${r.int(5, 95)}% of traffic to ${svc} goes through ${other} first, so changes need coordination.`,
    () => `This change ${r.pick(GOALS)} without ${r.pick(CONSTRAINTS)}.`,
    () => `We agreed in the ${r.pick(MEETINGS)} to ${r.pick(DECISIONS)}.`,
    () => `When ${svc} is unavailable, the fallback path ${r.pick(FALLBACKS)}.`,
    () => `Error rates on ${svc} spiked to ${(r.next() * 5).toFixed(2)}% during the last deploy.`,
    () => `Dashboards for ${svc} live in Grafana under the ${r.pick(TEAMS)} folder.`,
  ];
  return r.pick(templates)();
}

function paragraph(r: Rng, min = 2, max = 5): string {
  return Array.from({ length: r.int(min, max) }, () => sentence(r)).join(" ");
}

function nestedList(r: Rng): string {
  const lines: string[] = [];
  for (let i = 0, n = r.int(3, 6); i < n; i++) {
    lines.push(`- ${sentence(r)}`);
    for (let j = 0, m = r.int(0, 3); j < m; j++) {
      lines.push(`  - ${sentence(r)}`);
      if (r.chance(0.3)) {
        lines.push(`    - ${sentence(r)}`);
      }
    }
  }
  return lines.join("\n");
}

function numberedList(r: Rng): string {
  const lines: string[] = [];
  for (let i = 1, n = r.int(3, 7); i <= n; i++) {
    lines.push(`${i}. ${sentence(r)}`);
    if (r.chance(0.4)) {
      lines.push(`   - ${sentence(r)}`);
    }
  }
  return lines.join("\n");
}

function taskList(r: Rng): string {
  return Array.from({ length: r.int(3, 7) }, () => `- [${r.chance(0.3) ? "x" : " "}] ${sentence(r)}`).join("\n");
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const separator = header.map(() => "---");
  return [header, separator, ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

function metricsTable(r: Rng): string {
  const rows = r.sample(METRICS, r.int(3, 7)).map((metric) => {
    const current = r.int(10, 900);
    return [metric, String(current), String(Math.round(current * (0.5 + r.next() / 2))), r.pick(TEAMS)];
  });
  return table(["Metric", "Current", "Target", "Owner"], rows);
}

function distractorBudget(r: Rng): string {
  const value = `${r.int(3, 95)},${String(r.int(0, 999)).padStart(3, "0")} EUR`;
  return value === PHRASES.budget ? "12,400 EUR" : value;
}

function rolloutTable(r: Rng, budget: string): string {
  return table(
    ["Item", "Value"],
    [
      ["Owner team", r.pick(TEAMS)],
      ["Rollout budget", budget],
      ["Target date", `2026-${String(r.int(11, 12))}-${String(r.int(1, 28)).padStart(2, "0")}`],
      ["Feature flag", `\`${r.pick(FLAGS)}\``],
      ["Rollback plan", r.pick(FALLBACKS)],
    ],
  );
}

function codeBlock(r: Rng): string {
  const svc = r.pick(SERVICES);
  const blocks = [
    () => [
      "ts",
      [
        `export async function retryWithJitter<T>(fn: () => Promise<T>, attempts = ${r.int(3, 6)}): Promise<T> {`,
        "  for (let i = 1; ; i++) {",
        "    try {",
        "      return await fn();",
        "    } catch (error) {",
        "      if (i >= attempts) throw error;",
        `      await sleep(2 ** i * ${r.int(50, 250)} + Math.random() * 100);`,
        "    }",
        "  }",
        "}",
      ].join("\n"),
    ],
    () => [
      "sql",
      [
        "SELECT merchant_id, count(*) AS refunds, sum(amount_minor) / 100.0 AS total",
        "FROM ledger.refunds",
        `WHERE created_at > now() - interval '${r.int(1, 30)} days'`,
        "GROUP BY merchant_id",
        "ORDER BY total DESC",
        `LIMIT ${r.int(10, 50)};`,
      ].join("\n"),
    ],
    () => [
      "yaml",
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        `  name: ${svc}`,
        "spec:",
        `  replicas: ${r.int(2, 12)}`,
        "  template:",
        "    spec:",
        "      containers:",
        `        - name: ${svc}`,
        "          resources:",
        "            limits:",
        `              cpu: "${r.int(1, 4)}"`,
        `              memory: ${r.pick(["512Mi", "1Gi", "2Gi"])}`,
      ].join("\n"),
    ],
    () => [
      "bash",
      [
        `kubectl -n ${r.pick(["payments", "identity", "search", "platform"])} rollout status deploy/${svc} --timeout=${r.int(2, 10)}m`,
        `kubectl -n platform logs deploy/${svc} --since=${r.int(5, 60)}m | grep -c ERROR`,
      ].join("\n"),
    ],
    () => [
      "json",
      JSON.stringify(
        {
          service: svc,
          timeoutMs: r.int(200, 5000),
          retry: { attempts: r.int(2, 5), backoff: "exponential" },
          featureFlags: [r.pick(FLAGS), r.pick(FLAGS)],
        },
        null,
        2,
      ),
    ],
  ];
  const [lang, code] = r.pick(blocks)();
  return `\`\`\`${lang ?? ""}\n${code ?? ""}\n\`\`\``;
}

function linksParagraph(r: Rng): string {
  const svc = r.pick(SERVICES);
  return [
    `Related: [${svc} runbook](https://runbooks.example.com/${svc}),`,
    `[Grafana dashboard](https://grafana.example.com/d/${r.hex(8)}/${svc}) and`,
    `[design doc](https://docs.example.com/design/${svc}-${r.hex(4)}).`,
  ].join(" ");
}

/** Fill to a target length from shuffled optional sections, never crossing `max`. */
function fill(r: Rng, head: string[], optional: readonly (() => string)[], target: number, max: number): string {
  const parts = [...head];
  let length = parts.join("\n\n").length;
  for (let round = 0; round < 6 && length < target; round++) {
    for (const make of r.shuffle(optional)) {
      if (length >= target) {
        break;
      }
      const part = make();
      if (length + part.length + 2 > max) {
        continue;
      }
      parts.push(part);
      length += part.length + 2;
    }
  }
  return parts.join("\n\n");
}

function issueDescription(r: Rng, min = 300, max = 4000): string {
  const optional = [
    () => `## Scope\n\n${nestedList(r)}`,
    () => `## Acceptance criteria\n\n${taskList(r)}`,
    () => `## Rollout\n\n${rolloutTable(r, distractorBudget(r))}`,
    () => `## Metrics\n\n${metricsTable(r)}`,
    () => `## Implementation notes\n\n${paragraph(r)}\n\n${codeBlock(r)}`,
    () => `## Links\n\n${linksParagraph(r)}`,
    () => `## Open questions\n\n${numberedList(r)}`,
    () => `## Background\n\n${paragraph(r, 3, 6)}`,
  ];
  return fill(r, [`## Context\n\n${paragraph(r, 3, 5)}`], optional, r.int(min, max), max);
}

function quartzDescription(r: Rng): string {
  return [
    "## Context",
    "Quartz batching groups EU settlement instructions per acquiring bank so payouts land before the 14:00 CET cut-off. " +
      paragraph(r, 2, 3),
    "## Rollout",
    table(
      ["Item", "Value"],
      [
        ["Owner team", "Payments Core"],
        ["Rollout budget", PHRASES.budget],
        ["Target date", "2026-11-30"],
        ["Feature flag", "`ledger.v2.writes`"],
        ["Rollback plan", "disable the flag and replay the batch queue"],
      ],
    ),
    "## Acceptance criteria",
    taskList(r),
    "## Implementation notes",
    codeBlock(r),
    "## Links",
    linksParagraph(r),
  ].join("\n\n");
}

function issueComment(r: Rng): string {
  const kind = r.int(0, 9);
  if (kind < 3) {
    return r.pick(SHORT_COMMENTS);
  }
  if (kind < 7) {
    return paragraph(r, 1, 4);
  }
  if (kind < 9) {
    return `Review notes:\n\n${nestedList(r)}${r.chance(0.5) ? `\n\n${codeBlock(r)}` : ""}`;
  }
  return fill(
    r,
    [`Long write-up after digging into this:\n\n${paragraph(r, 4, 6)}`],
    [() => paragraph(r, 3, 6), () => metricsTable(r), () => codeBlock(r), () => nestedList(r)],
    r.int(1500, 3000),
    3200,
  );
}

function handbookFacts(r: Rng): string {
  const facts: readonly (readonly [string, () => string])[] = [
    ["Owner team", () => r.pick(TEAMS)],
    ["Escalation channel", () => `#${slug(r.pick(TEAMS))}-oncall`],
    ["Review cadence", () => r.pick(["weekly", "bi-weekly", "monthly", "quarterly"])],
    ["Default timeout", () => `${r.int(200, 30_000)} ms`],
    ["Max batch size", () => `${r.int(50, 5000)} items`],
    ["Error budget", () => `${(r.next() * 2).toFixed(2)}% per 28 days`],
    ["Pager rotation", () => `${r.int(4, 12)} engineers`],
    ["Change freeze", () => r.pick(["last week of December", "none", "during Black Friday week"])],
    ["Approval required", () => r.pick(["yes", "no", "for production only"])],
    ["Runbook", () => `[runbook](https://runbooks.example.com/${r.pick(SERVICES)})`],
    ["Primary contact", () => r.pick(PEOPLE)],
  ];
  const rows = r.sample(facts, r.int(4, 8)).map(([key, value]) => [key, value()]);
  return table(["Setting", "Value"], rows);
}

const RETENTION_TABLE = table(
  ["Setting", "Value"],
  [
    ["Hot storage retention", "30 days"],
    ["Warm storage retention", "120 days"],
    [PHRASES.cold, "410 days"],
    ["Audit log retention", "7 years"],
    ["Backup snapshot retention", "35 days"],
  ],
);

function handbookSectionTitle(n: number): string {
  return `${n}. ${at(HANDBOOK_DOMAINS, Math.floor((n - 1) / 3))}: ${at(HANDBOOK_ASPECTS, (n - 1) % 3)}`;
}

function handbookSection(r: Rng, n: number): string {
  const head = [`## ${handbookSectionTitle(n)}`, paragraph(r, 3, 5), `### Key facts\n\n${handbookFacts(r)}`];
  if (n === NEEDLE_SECTION) {
    head.push(`### Retention schedule\n\n${RETENTION_TABLE}`);
  }
  const optional = [
    () => `### Procedure\n\n${numberedList(r)}`,
    () => `### Checklist\n\n${nestedList(r)}`,
    () => `### Example\n\n${codeBlock(r)}`,
    () => `### Notes\n\n${paragraph(r, 2, 5)}`,
    () => `### Metrics\n\n${metricsTable(r)}`,
    () => linksParagraph(r),
  ];
  return fill(r, head, optional, r.int(1700, 2900), 3600);
}

function handbookBody(r: Rng): string {
  const intro = [
    "This handbook is the single reference for how the platform organisation builds, ships and runs software. " +
      "Each topic has an overview, the procedures we follow, and a reference section with the numbers people ask about most.",
    `## Contents\n\n${Array.from({ length: 90 }, (_, i) => `- ${handbookSectionTitle(i + 1)}`).join("\n")}`,
  ];
  return [...intro, ...Array.from({ length: 90 }, (_, i) => handbookSection(r, i + 1))].join("\n\n");
}

function archBody(r: Rng, name: string, extra: string | null): string {
  const head = [`## Overview\n\n${name}: ${paragraph(r, 3, 5)}`];
  if (extra !== null) {
    head.push(extra);
  }
  const optional = [
    () =>
      `## Components\n\n${table(
        ["Component", "Responsibility", "Owner"],
        Array.from({ length: r.int(3, 6) }, () => [r.pick(SERVICES), r.pick(GOALS), r.pick(TEAMS)]),
      )}`,
    () => `## Data flow\n\n${numberedList(r)}`,
    () => `## Interfaces\n\n${codeBlock(r)}`,
    () => `## Failure modes\n\n${nestedList(r)}`,
    () =>
      `## Decisions\n\n${table(
        ["Decision", "Date", "Status"],
        Array.from({ length: r.int(2, 5) }, () => [
          r.pick(DECISIONS),
          `2026-${String(r.int(1, 10)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`,
          r.pick(["accepted", "proposed", "superseded"]),
        ]),
      )}`,
    () => `## Open questions\n\n${taskList(r)}`,
    () => `## Notes\n\n${paragraph(r, 3, 6)}`,
    () => `## Links\n\n${linksParagraph(r)}`,
  ];
  return fill(r, head, optional, r.int(1000, 9500), 10_000);
}

function pageComment(r: Rng): string {
  const kind = r.int(0, 5);
  if (kind === 0) {
    return r.pick(SHORT_COMMENTS);
  }
  if (kind < 4) {
    return paragraph(r, 1, 3);
  }
  if (kind === 4) {
    return `A few follow-ups:\n\n${nestedList(r)}`;
  }
  return `${paragraph(r, 3, 5)}\n\n${codeBlock(r)}\n\n${paragraph(r, 2, 4)}`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

type IssueType = "Eposz" | "Feladat" | "Story" | "Subtask";

interface WorklogSpec {
  time: string[];
  started: string;
  comment: string;
}

interface IssueSpec {
  ref: string;
  type: IssueType;
  summary: string;
  body: string;
  parentRef: string | null;
  labels: string[];
  priority: string;
  assign: boolean;
  status: Status;
  comments: string[];
  worklogs: WorklogSpec[];
}

interface LinkSpec {
  from: string;
  relation: "blocks" | "relates to";
  to: string;
}

interface CommentSpec {
  body: string;
  replies: string[];
}

interface PageSpec {
  ref: string;
  kind: "page" | "blogpost";
  title: string;
  body: string;
  /** Page ref of the parent; null means the space homepage (pages) or no parent (blog posts). */
  parentRef: string | null;
  comments: CommentSpec[];
}

interface Plan {
  issues: IssueSpec[];
  links: LinkSpec[];
  pages: PageSpec[];
  needles: {
    quartz: string;
    chain: string[];
    rollback: string;
    rollbackIndex: number;
    handbook: string;
    lantern: string;
    mixedEpic: string;
    latencyPage: string;
    latencyIndices: number[];
  };
}

function issueRef(areaIndex: number, j: number): string {
  return `I${String(areaIndex * 25 + j + 1).padStart(3, "0")}`;
}

function archRef(name: string): string {
  return `arch-${slug(name)}`;
}

function worklogStarted(r: Rng): string {
  const month = r.int(9, 10);
  const day = r.int(1, month === 10 ? 20 : 30);
  return `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(r.int(7, 16)).padStart(2, "0")}:00:00.000+0000`;
}

function buildPlan(): Plan {
  const r = new Rng(SEED);
  const summaries = new Set<string>();
  const unique = (make: () => string): string => {
    for (let i = 0; i < 200; i++) {
      const summary = `${PREFIX} ${make()}`;
      if (!summaries.has(summary)) {
        summaries.add(summary);
        return summary;
      }
    }
    throw new Error("could not generate a unique summary");
  };
  const issues: IssueSpec[] = [];
  const byRef = new Map<string, IssueSpec>();
  const add = (spec: IssueSpec) => {
    issues.push(spec);
    byRef.set(spec.ref, spec);
  };
  const get = (ref: string): IssueSpec => {
    const spec = byRef.get(ref);
    if (spec === undefined) {
      throw new Error(`unknown issue ref ${ref}`);
    }
    return spec;
  };

  AREAS.forEach((area, ai) => {
    add({
      ref: `E${ai + 1}`,
      type: "Eposz",
      summary: unique(() => area.epic),
      body: issueDescription(r, 800, 4000),
      parentRef: null,
      labels: [...area.labels],
      priority: r.weighted(PRIORITY_WEIGHTS),
      assign: true,
      status: at(EPIC_STATUSES, ai),
      comments: [],
      worklogs: [],
    });
  });
  const children: string[] = [];
  AREAS.forEach((area, ai) => {
    for (let j = 0; j < 25; j++) {
      const story = r.chance(0.4);
      const labels = new Set(area.labels);
      if (r.chance(0.3)) {
        labels.add(r.pick(EXTRA_LABELS));
      }
      if (r.chance(0.12)) {
        labels.add(at(r.pick(AREAS).labels, 0));
      }
      const ref = issueRef(ai, j);
      children.push(ref);
      add({
        ref,
        type: story ? "Story" : "Feladat",
        summary: unique(() =>
          story
            ? `${r.pick(STORY_LEADS)} ${r.pick(area.objects)}`
            : `${r.pick(VERBS)} ${r.pick(area.objects)} in ${r.pick(SERVICES)}`,
        ),
        body: issueDescription(r),
        parentRef: `E${ai + 1}`,
        labels: [...labels],
        priority: r.weighted(PRIORITY_WEIGHTS),
        assign: r.chance(0.55),
        status: r.weighted(STATUS_WEIGHTS),
        comments: [],
        worklogs: [],
      });
    }
  });
  const subtasks: string[] = [];
  for (let i = 0; i < 20; i++) {
    const parent = get(r.pick(children));
    const area = at(AREAS, Math.floor((Number(parent.ref.slice(1)) - 1) / 25));
    const ref = `S${String(i + 1).padStart(2, "0")}`;
    subtasks.push(ref);
    add({
      ref,
      type: "Subtask",
      summary: unique(() => `${r.pick(SUBTASK_VERBS)} ${r.pick(area.objects)}`),
      body: issueDescription(r, 300, 1500),
      parentRef: parent.ref,
      labels: [at(parent.labels, 0)],
      priority: r.weighted(PRIORITY_WEIGHTS),
      assign: r.chance(0.5),
      status: r.weighted(STATUS_WEIGHTS),
      comments: [],
      worklogs: [],
    });
  }

  // Needle 1: the only needle-quartz issue, in progress, assigned, with the budget row.
  const quartz = get(issueRef(0, 7));
  quartz.labels = ["payments", PHRASES.quartzLabel];
  quartz.status = "Folyamatban";
  quartz.assign = true;
  quartz.body = quartzDescription(r);

  // Needle 6: force at least four distinct statuses under the search epic.
  const mixedEpic = "E3";
  (["Teendő", "Folyamatban", "Ellenőrzés alatt", "Kész"] as const).forEach((status, j) => {
    get(issueRef(2, j)).status = status;
  });

  // Needle 3: twelve comments; the 9th-newest (index 3, oldest first) carries the phrase.
  const rollback = get(issueRef(3, 5));
  const rollbackIndex = 3;
  rollback.comments = Array.from({ length: 12 }, () => issueComment(r));
  rollback.comments[rollbackIndex] =
    `Checked with the DBA team: the ${PHRASES.rollback} for the full ledger cutover, measured on last Tuesday's staging snapshot. ` +
    "Anything longer than that and we breach the settlement SLA, so the go/no-go call has to happen before 02:00.";
  rollback.comments[9] =
    "Rollback rehearsal is booked for Thursday; we will time it again on production-sized data before sign-off.";
  const commented = r.sample(
    children.filter((ref) => ref !== rollback.ref),
    39,
  );
  for (const ref of commented) {
    get(ref).comments = Array.from({ length: r.int(3, 12) }, () => issueComment(r));
  }

  for (const ref of r.sample([...children, ...subtasks], 15)) {
    get(ref).worklogs = Array.from({ length: r.int(1, 3) }, () => ({
      time: r.pick([["30m"], ["45m"], ["1h"], ["2h", "30m"], ["3h"], ["4h"], ["1d"]]),
      started: worklogStarted(r),
      comment: paragraph(r, 1, 2),
    }));
  }

  // Needle 2: the only 4-issue blocks chain; other blocks chains are at most 3 issues long.
  const chain = [issueRef(1, 10), issueRef(3, 12), issueRef(4, 3), issueRef(5, 18)];
  const links: LinkSpec[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    links.push({ from: at(chain, i), relation: "blocks", to: at(chain, i + 1) });
  }
  const free = r.shuffle(children.filter((ref) => !chain.includes(ref) && ref !== quartz.ref));
  const groups = [3, 3, 2, 2, 2];
  let cursor = 0;
  for (const size of groups) {
    const group = free.slice(cursor, cursor + size);
    cursor += size;
    for (let i = 0; i + 1 < group.length; i++) {
      links.push({ from: at(group, i), relation: "blocks", to: at(group, i + 1) });
    }
  }
  const pairs = new Set(links.map((link) => [link.from, link.to].toSorted().join("|")));
  while (links.length < 40) {
    const from = r.pick(children);
    const to = r.pick(children);
    const key = [from, to].toSorted().join("|");
    if (from === to || pairs.has(key)) {
      continue;
    }
    pairs.add(key);
    links.push({ from, relation: "relates to", to });
  }

  // Confluence
  const pages: PageSpec[] = [];
  const pageByRef = new Map<string, PageSpec>();
  const addPage = (spec: PageSpec) => {
    pages.push(spec);
    pageByRef.set(spec.ref, spec);
  };
  const comments = (count: number, replyChance: number): CommentSpec[] =>
    Array.from({ length: count }, () => ({
      body: pageComment(r),
      replies: r.chance(replyChance) ? Array.from({ length: r.int(1, 2) }, () => pageComment(r)) : [],
    }));

  addPage({
    ref: "handbook",
    kind: "page",
    title: `${PREFIX} Platform Handbook`,
    body: handbookBody(r),
    parentRef: null,
    comments: comments(4, 0.5),
  });
  addPage({
    ref: "arch",
    kind: "page",
    title: `${PREFIX} Architecture`,
    body: archBody(r, "Platform architecture", `## How to read this tree\n\n${nestedList(r)}`),
    parentRef: null,
    comments: comments(3, 0.4),
  });
  for (const name of ARCH_CHILDREN) {
    addPage({
      ref: archRef(name),
      kind: "page",
      title: `${PREFIX} Architecture: ${name}`,
      body: archBody(r, name, null),
      parentRef: "arch",
      comments: [],
    });
    for (const grandchild of ARCH_GRANDCHILDREN[name] ?? []) {
      const lantern =
        grandchild === LANTERN_PAGE
          ? `## Handshake\n\nEdge relays authenticate to the regional origin with the ${PHRASES.lantern}: ` +
            "a mutual-TLS handshake followed by a signed capability token that expires after 90 seconds. " +
            "Relays that fail the handshake three times in a row are drained from the pool automatically."
          : null;
      addPage({
        ref: archRef(grandchild),
        kind: "page",
        title: `${PREFIX} Architecture: ${grandchild}`,
        body: archBody(r, grandchild, lantern),
        parentRef: archRef(name),
        comments: [],
      });
    }
  }
  for (const [i, topic] of ["Q3 platform retrospective", "Introducing the new deploy pipeline"].entries()) {
    addPage({
      ref: `blog-${i + 1}`,
      kind: "blogpost",
      title: `${PREFIX} ${topic}`,
      body: archBody(r, topic, null),
      parentRef: null,
      comments: comments(3 - i, 0.5),
    });
  }

  // Needle 7: six footer comments, exactly two mention the latency budget.
  const latencyPage = archRef(LATENCY_PAGE);
  const latencyIndices = [1, 4];
  const latency = pageByRef.get(latencyPage);
  if (latency === undefined) {
    throw new Error("latency page missing from the plan");
  }
  latency.comments = Array.from({ length: 6 }, () => ({ body: pageComment(r), replies: [] }));
  at(latency.comments, 1).body =
    `The ${PHRASES.latency} for the gateway hop is 25 ms at p99; the new token bucket check adds about 3 ms, so we still have headroom.`;
  at(latency.comments, 4).body =
    `Can we confirm the ${PHRASES.latency} still holds when the Redis cluster fails over? Last game day the lookup took 40 ms.`;
  const lantern = archRef(LANTERN_PAGE);
  const others = r.sample(
    ARCH_CHILDREN.map(archRef).filter((ref) => ref !== latencyPage),
    6,
  );
  for (const ref of [...others, lantern]) {
    const page = pageByRef.get(ref);
    if (page !== undefined) {
      page.comments = comments(2, 0.3);
    }
  }

  const plan: Plan = {
    issues,
    links,
    pages,
    needles: {
      quartz: quartz.ref,
      chain,
      rollback: rollback.ref,
      rollbackIndex,
      handbook: "handbook",
      lantern,
      mixedEpic,
      latencyPage,
      latencyIndices,
    },
  };
  assertPlan(plan);
  return plan;
}

function occurrences(texts: readonly string[], phrase: string): number {
  const needle = phrase.toLowerCase();
  let count = 0;
  for (const chunk of texts) {
    const haystack = chunk.toLowerCase();
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
      count += 1;
    }
  }
  return count;
}

/** The needles are only meaningful if their phrases are unique site-wide; fail before sending anything. */
function assertPlan(plan: Plan): void {
  const texts = [
    ...plan.issues.flatMap((i) => [i.summary, i.body, ...i.comments, ...i.worklogs.map((w) => w.comment)]),
    ...plan.pages.flatMap((p) => [p.title, p.body, ...p.comments.flatMap((c) => [c.body, ...c.replies])]),
  ];
  const expectations: readonly (readonly [string, number])[] = [
    [PHRASES.budgetRow, 1],
    [PHRASES.budget, 1],
    [PHRASES.rollback, 1],
    [PHRASES.coldRow, 1],
    [PHRASES.cold, 1],
    [PHRASES.lantern, 1],
    [PHRASES.latency, 2],
  ];
  for (const [phrase, expected] of expectations) {
    const actual = occurrences(texts, phrase);
    if (actual !== expected) {
      throw new Error(`plan has ${actual} occurrences of "${phrase}", expected ${expected}`);
    }
  }
  if (plan.issues.filter((i) => i.labels.includes(PHRASES.quartzLabel)).length !== 1) {
    throw new Error("needle-quartz must label exactly one issue");
  }
  const titles = plan.pages.map((p) => p.title);
  if (new Set(titles).size !== titles.length) {
    throw new Error("page titles are not unique");
  }
  const handbook = plan.pages.find((p) => p.ref === plan.needles.handbook);
  const bytes = Buffer.byteLength(handbook?.body ?? "");
  if (bytes < 150_000 || bytes > 250_000) {
    throw new Error(`handbook is ${bytes} bytes, expected 150-250 KB`);
  }
  for (const page of plan.pages) {
    const size = Buffer.byteLength(page.body);
    if (page.ref.startsWith("arch") && (size < 1000 || size > 10_500)) {
      throw new Error(`${page.ref} body is ${size} bytes, expected 1-10 KB`);
    }
  }
  for (const issue of plan.issues) {
    if (issue.body.length < 300 || issue.body.length > 4000) {
      throw new Error(`${issue.ref} description is ${issue.body.length} chars, expected 300-4000`);
    }
  }
}

const byName = (a: readonly [string, number], b: readonly [string, number]) => a[0].localeCompare(b[0]);

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function planSummary(plan: Plan) {
  const pages = plan.pages.filter((p) => p.kind === "page");
  return {
    seed: SEED,
    issues: {
      total: plan.issues.length,
      byType: tally(plan.issues.map((i) => i.type)),
      byStatus: tally(plan.issues.map((i) => i.status)),
      byPriority: tally(plan.issues.map((i) => i.priority)),
      byLabel: tally(plan.issues.flatMap((i) => i.labels)),
      assigned: plan.issues.filter((i) => i.assign).length,
      withComments: plan.issues.filter((i) => i.comments.length > 0).length,
      comments: plan.issues.reduce((n, i) => n + i.comments.length, 0),
      withWorklogs: plan.issues.filter((i) => i.worklogs.length > 0).length,
      worklogs: plan.issues.reduce((n, i) => n + i.worklogs.length, 0),
      descriptionChars: {
        min: Math.min(...plan.issues.map((i) => i.body.length)),
        max: Math.max(...plan.issues.map((i) => i.body.length)),
      },
    },
    links: tally(plan.links.map((l) => l.relation)),
    pages: {
      pages: pages.length,
      blogposts: plan.pages.length - pages.length,
      handbookBytes: Buffer.byteLength(pages.find((p) => p.ref === "handbook")?.body ?? ""),
      footerComments: plan.pages.reduce((n, p) => n + p.comments.length, 0),
      replies: plan.pages.reduce((n, p) => n + p.comments.reduce((m, c) => m + c.replies.length, 0), 0),
      titles: plan.pages.map((p) => `${p.parentRef ?? "-"} > ${p.title} (${Buffer.byteLength(p.body)} B)`),
    },
    needles: plan.needles,
    sampleSummaries: plan.issues.slice(0, 12).map((i) => `${i.ref} ${i.type} ${i.status}: ${i.summary}`),
  };
}

// ---------------------------------------------------------------------------
// atl process plumbing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface ErrorEntry {
  label: string;
  argv: string[];
  attempt: number;
  exitCode: number;
  code: string;
  message: string;
  handling: "retried" | "gave-up";
}

class AtlFailure extends Error {}

const errors: ErrorEntry[] = [];
let calls = 0;

function log(message: string): void {
  process.stderr.write(`[seed] ${message}\n`);
}

function describeFailure(stdout: string, stderr: string, exitCode: number): { code: string; message: string } {
  for (const line of [stdout.trim(), ...stderr.trim().split("\n").toReversed()]) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value) && value.type === "error") {
        return {
          code: typeof value.code === "string" ? value.code : "unknown",
          message: typeof value.message === "string" ? value.message : line,
        };
      }
    } catch {
      // A diagnostic line that is not JSON; keep scanning.
    }
  }
  return { code: `exit_${exitCode}`, message: (stderr.trim() || stdout.trim() || `exit ${exitCode}`).slice(0, 500) };
}

/** Run atl once per attempt; exit 3 (429/5xx/timeout/409) and network failures are retried with backoff. */
async function atl(label: string, args: string[]): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawn([ATL, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    calls += 1;
    if (exitCode === 0) {
      const parsed: unknown = JSON.parse(stdout);
      if (!isRecord(parsed)) {
        throw new AtlFailure(`${label}: stdout is not a JSON object`);
      }
      return parsed;
    }
    const failure = describeFailure(stdout, stderr, exitCode);
    const transient = exitCode === 3 || exitCode > 4 || TRANSIENT_TEXT.test(failure.message);
    const retry = transient && attempt < MAX_ATTEMPTS;
    errors.push({
      label,
      argv: args,
      attempt,
      exitCode,
      code: failure.code,
      message: failure.message.slice(0, 500),
      handling: retry ? "retried" : "gave-up",
    });
    log(`${label}: exit ${exitCode} ${failure.code} (${retry ? "retrying" : "giving up"})`);
    if (!retry) {
      throw new AtlFailure(`${label}: ${failure.message}`);
    }
    await Bun.sleep(1500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
  }
}

/** Run a step that may fail without aborting the seed; the failure is already in `errors`. */
async function soft<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof AtlFailure)) {
      errors.push({
        label,
        argv: [],
        attempt: 0,
        exitCode: -1,
        code: "script",
        message: error instanceof Error ? error.message : String(error),
        handling: "gave-up",
      });
    }
    return null;
  }
}

async function pool<T>(label: string, items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = at(items, next);
      next += 1;
      await fn(item);
      done += 1;
      if (done % 25 === 0 || done === items.length) {
        log(`${label}: ${done}/${items.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

function text(value: Json, key: string): string {
  const field = value[key];
  if (typeof field === "string") {
    return field;
  }
  if (typeof field === "number") {
    return String(field);
  }
  throw new AtlFailure(`missing "${key}" in ${JSON.stringify(value).slice(0, 200)}`);
}

function optionalText(value: Json, key: string): string | null {
  const field = value[key];
  return typeof field === "string" || typeof field === "number" ? String(field) : null;
}

/** `page get` reports its parent as `parent: {id, title}`. */
function parentIdOf(page: Json): string | null {
  const parent = page.parent;
  return isRecord(parent) && typeof parent.id === "string" ? parent.id : null;
}

function itemsOf(value: Json): Json[] {
  return Array.isArray(value.items) ? value.items.filter(isRecord) : [];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface IssueState {
  key: string | null;
  url: string | null;
  status: Status | null;
  priority: string | null;
  commentIds: string[];
  worklogIds: string[];
}

interface PageState {
  id: string | null;
  url: string | null;
  comments: { id: string; replies: string[] }[];
}

interface State {
  owner: { accountId: string; name: string };
  issues: Map<string, IssueState>;
  links: { from: string; relation: string; to: string; ok: boolean }[];
  pages: Map<string, PageState>;
}

function bodyFile(name: string, content: string): string {
  const path = join(BODIES, `${name}.md`);
  writeFileSync(path, `${content}\n`);
  return path;
}

function issueKey(state: State, ref: string): string | null {
  return state.issues.get(ref)?.key ?? null;
}

const STATUS_PATHS: Record<Status, Status[]> = {
  Teendő: [],
  Folyamatban: ["Folyamatban"],
  "Ellenőrzés alatt": ["Folyamatban", "Ellenőrzés alatt"],
  Kész: ["Folyamatban", "Kész"],
};

async function createIssue(state: State, spec: IssueSpec): Promise<void> {
  const issue: IssueState = { key: null, url: null, status: null, priority: null, commentIds: [], worklogIds: [] };
  state.issues.set(spec.ref, issue);
  const parentKey = spec.parentRef === null ? null : issueKey(state, spec.parentRef);
  if (spec.parentRef !== null && parentKey === null) {
    errors.push({
      label: `create ${spec.ref}`,
      argv: [],
      attempt: 0,
      exitCode: -1,
      code: "parent_missing",
      message: `parent ${spec.parentRef} was not created`,
      handling: "gave-up",
    });
    return;
  }
  const args = [
    "issue",
    "create",
    "--project",
    PROJECT,
    "--type",
    spec.type,
    "--summary",
    spec.summary,
    "--file",
    bodyFile(spec.ref, spec.body),
    "--set",
    `labels=${JSON.stringify(spec.labels)}`,
  ];
  if (parentKey !== null) {
    args.push("--parent", parentKey);
  }
  if (spec.assign) {
    args.push("--assignee", state.owner.accountId);
  }
  const created = await soft(`create ${spec.ref}`, () => atl(`create ${spec.ref}`, args));
  if (created === null) {
    return;
  }
  const key = text(created, "key");
  issue.key = key;
  issue.url = optionalText(created, "url");
  issue.status = "Teendő";
  issue.priority = "Medium";
  // KAN's create screen has no priority field, so it is set with an edit afterwards.
  if (spec.priority !== "Medium") {
    const edited = await soft(`priority ${key}`, () =>
      atl(`priority ${key}`, ["issue", "edit", key, "--set", `priority=${JSON.stringify({ name: spec.priority })}`]),
    );
    if (edited !== null) {
      issue.priority = optionalText(edited, "priority") ?? spec.priority;
    }
  }
  for (const status of STATUS_PATHS[spec.status]) {
    const moved = await soft(`move ${key} ${status}`, () => atl(`move ${key}`, ["issue", "move", key, status]));
    if (moved === null) {
      break;
    }
    issue.status = status;
  }
}

async function seedJira(plan: Plan, state: State): Promise<void> {
  const epics = plan.issues.filter((i) => i.type === "Eposz");
  const children = plan.issues.filter((i) => i.type === "Feladat" || i.type === "Story");
  const subtasks = plan.issues.filter((i) => i.type === "Subtask");
  await pool("epics", epics, (spec) => createIssue(state, spec));
  await pool("issues", children, (spec) => createIssue(state, spec));
  await pool("subtasks", subtasks, (spec) => createIssue(state, spec));
  writePartial(plan, state);

  await pool("links", plan.links, async (link) => {
    const from = issueKey(state, link.from);
    const to = issueKey(state, link.to);
    const entry = { from: from ?? link.from, relation: link.relation, to: to ?? link.to, ok: false };
    state.links.push(entry);
    if (from === null || to === null) {
      return;
    }
    const type = link.relation === "blocks" ? "blocks" : "Relates";
    entry.ok = (await soft(`link ${from} ${to}`, () => atl(`link ${from}`, ["issue", "link", from, type, to]))) !== null;
  });

  // Comments on one issue are sequential so their created order matches the plan order.
  await pool(
    "issue comments",
    plan.issues.filter((i) => i.comments.length > 0),
    async (spec) => {
      const issue = state.issues.get(spec.ref);
      const key = issue?.key ?? null;
      if (issue === undefined || key === null) {
        return;
      }
      for (const [i, body] of spec.comments.entries()) {
        const file = bodyFile(`${spec.ref}.c${String(i).padStart(2, "0")}`, body);
        const added = await soft(`comment ${key}#${i}`, () =>
          atl(`comment ${key}`, ["issue", "comment", key, "--file", file]),
        );
        if (added !== null) {
          issue.commentIds.push(text(added, "id"));
        }
      }
    },
  );

  await pool(
    "worklogs",
    plan.issues.filter((i) => i.worklogs.length > 0),
    async (spec) => {
      const issue = state.issues.get(spec.ref);
      const key = issue?.key ?? null;
      if (issue === undefined || key === null) {
        return;
      }
      for (const [i, worklog] of spec.worklogs.entries()) {
        const file = bodyFile(`${spec.ref}.w${i}`, worklog.comment);
        const logged = await soft(`worklog ${key}#${i}`, () =>
          atl(`worklog ${key}`, ["issue", "log", key, ...worklog.time, "--started", worklog.started, "--comment-file", file]),
        );
        if (logged !== null) {
          issue.worklogIds.push(optionalText(logged, "id") ?? "?");
        }
      }
    },
  );
  writePartial(plan, state);
}

async function createPage(state: State, spec: PageSpec): Promise<void> {
  const page: PageState = { id: null, url: null, comments: [] };
  state.pages.set(spec.ref, page);
  const args = ["page", "create", "--space", SPACE, "--title", spec.title, "--file", bodyFile(spec.ref, spec.body)];
  if (spec.kind === "blogpost") {
    args.push("--type", "blogpost");
  } else {
    const parent = spec.parentRef === null ? HOME_PAGE : (state.pages.get(spec.parentRef)?.id ?? null);
    if (parent === null) {
      errors.push({
        label: `page ${spec.ref}`,
        argv: [],
        attempt: 0,
        exitCode: -1,
        code: "parent_missing",
        message: `parent ${spec.parentRef ?? "?"} was not created`,
        handling: "gave-up",
      });
      return;
    }
    args.push("--parent", parent);
  }
  const created = await soft(`page ${spec.ref}`, () => atl(`page ${spec.ref}`, args));
  if (created !== null) {
    page.id = text(created, "id");
    page.url = optionalText(created, "url");
  }
}

async function seedConfluence(plan: Plan, state: State): Promise<void> {
  const depth = (spec: PageSpec): number => {
    let level = 0;
    for (let ref = spec.parentRef; ref !== null; level++) {
      ref = plan.pages.find((p) => p.ref === ref)?.parentRef ?? null;
    }
    return level;
  };
  for (const level of [0, 1, 2]) {
    await pool(
      `pages depth ${level}`,
      plan.pages.filter((p) => depth(p) === level),
      (spec) => createPage(state, spec),
    );
  }
  writePartial(plan, state);

  // Comments on one page are sequential: top-level first, then its replies, so threads stay ordered.
  await pool(
    "page comments",
    plan.pages.filter((p) => p.comments.length > 0),
    async (spec) => {
      const page = state.pages.get(spec.ref);
      const id = page?.id ?? null;
      if (page === undefined || id === null) {
        return;
      }
      for (const [i, comment] of spec.comments.entries()) {
        const file = bodyFile(`${spec.ref}.c${i}`, comment.body);
        const args = ["comment", "add", id, "--file", file];
        if (spec.kind === "blogpost") {
          args.push("--target-type", "blogpost");
        }
        const added = await soft(`page comment ${id}#${i}`, () => atl(`page comment ${id}`, args));
        if (added === null) {
          continue;
        }
        const entry = { id: text(added, "id"), replies: [] as string[] };
        page.comments.push(entry);
        for (const [j, reply] of comment.replies.entries()) {
          const replyFile = bodyFile(`${spec.ref}.c${i}.r${j}`, reply);
          const replied = await soft(`reply ${entry.id}#${j}`, () =>
            atl(`reply ${entry.id}`, ["comment", "add", "--reply-to", entry.id, "--file", replyFile]),
          );
          if (replied !== null) {
            entry.replies.push(text(replied, "id"));
          }
        }
      }
    },
  );
  writePartial(plan, state);
}

// ---------------------------------------------------------------------------
// Needle verification
// ---------------------------------------------------------------------------

interface Needle {
  n: number;
  name: string;
  question: string;
  expected: Json;
  verify: { commands: string[][]; passed: boolean; details: string[] };
}

/** Run `check` until it passes; JQL and comment reads can lag a fresh write by a few seconds. */
async function verified(
  commands: string[][],
  check: (results: Json[]) => string[],
): Promise<{ commands: string[][]; passed: boolean; details: string[] }> {
  let details: string[] = [];
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const results = await soft("verify", () => Promise.all(commands.map((argv) => atl("verify", argv.slice(1)))));
    details = results === null ? ["read-back command failed (see errors)"] : check(results);
    if (details.length === 0) {
      return { commands, passed: true, details: [] };
    }
    if (attempt < VERIFY_ATTEMPTS) {
      await Bun.sleep(10_000);
    }
  }
  return { commands, passed: false, details };
}

async function verifyNeedles(plan: Plan, state: State): Promise<Needle[]> {
  const n = plan.needles;
  const key = (ref: string) => issueKey(state, ref) ?? `<missing ${ref}>`;
  const page = (ref: string) => state.pages.get(ref);
  const pageId = (ref: string) => page(ref)?.id ?? `<missing ${ref}>`;
  const titleOf = (ref: string) => plan.pages.find((p) => p.ref === ref)?.title ?? ref;
  const needles: Needle[] = [];

  const quartzKey = key(n.quartz);
  needles.push({
    n: 1,
    name: "quartz-rollout-budget",
    question:
      "Find the in-progress KAN issue labelled needle-quartz that is assigned to me and report its rollout budget.",
    expected: {
      key: quartzKey,
      summary: plan.issues.find((i) => i.ref === n.quartz)?.summary ?? null,
      url: state.issues.get(n.quartz)?.url ?? null,
      status: "Folyamatban",
      assigneeAccountId: state.owner.accountId,
      tableRow: PHRASES.budgetRow,
      answer: PHRASES.budget,
    },
    verify: await verified(
      [
        ["atl", "jql", `project = ${PROJECT} AND labels = "${PHRASES.quartzLabel}"`],
        ["atl", "issue", "get", quartzKey],
      ],
      (results) => {
        const problems: string[] = [];
        const hits = itemsOf(at(results, 0));
        if (hits.length !== 1 || optionalText(at(hits, 0), "key") !== quartzKey) {
          problems.push(`jql returned ${JSON.stringify(hits.map((h) => h.key))}`);
        }
        const issue = at(results, 1);
        if (issue.status !== "Folyamatban") {
          problems.push(`status is ${String(issue.status)}`);
        }
        const assignee = isRecord(issue.assignee) ? issue.assignee.accountId : null;
        if (assignee !== state.owner.accountId) {
          problems.push("not assigned to the owner");
        }
        if (!/Rollout budget\s*\|\s*48,210 EUR/.test(JSON.stringify(issue))) {
          problems.push("description lacks the budget row");
        }
        return problems;
      },
    ),
  });

  const chainKeys = n.chain.map(key);
  needles.push({
    n: 2,
    name: "four-issue-blocks-chain",
    question:
      "Follow the blocks links from the head of the only 4-issue blocks chain in KAN and list the keys in order.",
    expected: { keys: chainKeys, head: chainKeys[0] ?? null, tail: chainKeys.at(-1) ?? null, issues: 4, links: 3 },
    verify: await verified(
      chainKeys.map((k) => ["atl", "issue", "links", k]),
      (results) => {
        const problems: string[] = [];
        results.forEach((links, i) => {
          const items = itemsOf(links);
          const next = chainKeys[i + 1];
          const prev = i > 0 ? chainKeys[i - 1] : undefined;
          if (next !== undefined && !items.some((l) => l.relation === "blocks" && l.key === next)) {
            problems.push(`${at(chainKeys, i)} does not block ${next}`);
          }
          if (prev === undefined && items.some((l) => l.relation === "is blocked by")) {
            problems.push(`head ${at(chainKeys, i)} is blocked by something`);
          }
          if (next === undefined && items.some((l) => l.relation === "blocks")) {
            problems.push(`tail ${at(chainKeys, i)} blocks something`);
          }
        });
        return problems;
      },
    ),
  });

  const rollbackKey = key(n.rollback);
  const rollbackIds = state.issues.get(n.rollback)?.commentIds ?? [];
  const rollbackCommentId = rollbackIds[n.rollbackIndex] ?? null;
  needles.push({
    n: 3,
    name: "rollback-window-old-comment",
    question:
      "Which KAN issue has a comment saying how long the rollback window is, and what is it? (It is the 9th-newest comment, outside the newest 5.)",
    expected: {
      key: rollbackKey,
      commentId: rollbackCommentId,
      positionFromNewest: 9,
      totalComments: 12,
      phrase: PHRASES.rollback,
      answer: "37 minutes",
    },
    verify: await verified(
      [
        ["atl", "issue", "comments", rollbackKey, "--all"],
        ["atl", "issue", "get", rollbackKey, "--comments", "5"],
      ],
      (results) => {
        const problems: string[] = [];
        const comments = itemsOf(at(results, 0)).toSorted(
          (a, b) => Number(optionalText(b, "id")) - Number(optionalText(a, "id")),
        );
        if (comments.length !== 12) {
          problems.push(`${comments.length} comments, expected 12`);
        }
        const ninth = comments[8];
        if (ninth === undefined || !JSON.stringify(ninth).includes(PHRASES.rollback)) {
          problems.push("9th-newest comment lacks the phrase");
        } else if (optionalText(ninth, "id") !== rollbackCommentId) {
          problems.push(`9th-newest comment is ${String(ninth.id)}, expected ${rollbackCommentId ?? "?"}`);
        }
        if (JSON.stringify(at(results, 1)).includes(PHRASES.rollback)) {
          problems.push("phrase visible in the newest 5 comments");
        }
        return problems;
      },
    ),
  });

  const handbookId = pageId(n.handbook);
  const handbookBytes = Buffer.byteLength(plan.pages.find((p) => p.ref === n.handbook)?.body ?? "");
  needles.push({
    n: 4,
    name: "handbook-cold-storage-retention",
    question: "In the atl smoke eval Platform Handbook, what is the cold storage retention period?",
    expected: {
      pageId: handbookId,
      title: titleOf(n.handbook),
      url: page(n.handbook)?.url ?? null,
      markdownBytes: handbookBytes,
      sections: 90,
      section: handbookSectionTitle(NEEDLE_SECTION),
      tableRow: PHRASES.coldRow,
      answer: "410 days",
    },
    verify: await verified([["atl", "page", "get", handbookId]], (results) => {
      const handbook = at(results, 0);
      const body = typeof handbook.body === "string" ? handbook.body : JSON.stringify(handbook);
      const problems: string[] = [];
      const row = body.search(/Cold storage retention\s*\|\s*410 days/);
      const start = body.indexOf(`## ${NEEDLE_SECTION}. `);
      const end = body.indexOf(`## ${NEEDLE_SECTION + 1}. `, start);
      if (row === -1) {
        problems.push("row not found");
      } else if (start === -1 || row < start || (end !== -1 && row > end)) {
        problems.push("row is not inside section 63");
      }
      if (occurrences([body], PHRASES.cold) !== 1) {
        problems.push(`"${PHRASES.cold}" occurs ${occurrences([body], PHRASES.cold)} times`);
      }
      return problems;
    }),
  });

  const lanternId = pageId(n.lantern);
  const lanternParentRef = archRef(LANTERN_PARENT);
  const lanternParentId = pageId(lanternParentRef);
  const archId = pageId("arch");
  needles.push({
    n: 5,
    name: "quartz-lantern-grandchild",
    question:
      "Which page under atl smoke eval Architecture describes the quartz lantern protocol? Give its id, title, and URL.",
    expected: {
      id: lanternId,
      title: titleOf(n.lantern),
      url: page(n.lantern)?.url ?? null,
      parentId: lanternParentId,
      parentTitle: titleOf(lanternParentRef),
      grandparentId: archId,
      authorAccountId: state.owner.accountId,
      phrase: PHRASES.lantern,
    },
    verify: await verified(
      [
        ["atl", "page", "get", lanternId],
        ["atl", "page", "get", lanternParentId],
      ],
      (results) => {
        const problems: string[] = [];
        const leaf = at(results, 0);
        const parent = at(results, 1);
        const leafBody = typeof leaf.body === "string" ? leaf.body : JSON.stringify(leaf);
        if (!leafBody.includes(PHRASES.lantern)) {
          problems.push("phrase missing");
        }
        if (leaf.authorId !== state.owner.accountId) {
          problems.push(`author is ${String(leaf.authorId)}`);
        }
        const leafParent = parentIdOf(leaf);
        if (leafParent !== lanternParentId) {
          problems.push(`parent is ${String(leafParent)}`);
        }
        const grandparent = parentIdOf(parent);
        if (grandparent !== archId) {
          problems.push(`grandparent is ${String(grandparent)}`);
        }
        return problems;
      },
    ),
  });

  const epicKey = key(n.mixedEpic);
  const childStatuses = plan.issues
    .filter((i) => i.parentRef === n.mixedEpic)
    .map((i) => state.issues.get(i.ref))
    .filter((i): i is IssueState => i?.key !== null && i !== undefined)
    .map((i) => i.status ?? "unknown");
  const statusCounts = tally(childStatuses);
  needles.push({
    n: 6,
    name: "mixed-status-epic",
    question: "How many child issues does the Search relevance overhaul epic have, and how many are in each status?",
    expected: {
      epicKey,
      summary: plan.issues.find((i) => i.ref === n.mixedEpic)?.summary ?? null,
      childCount: childStatuses.length,
      statusCounts,
    },
    verify: await verified([["atl", "jql", `parent = ${epicKey}`, "--all"]], (results) => {
      const actual = tally(itemsOf(at(results, 0)).map((i) => optionalText(i, "status") ?? "unknown"));
      const expected = JSON.stringify(Object.entries(statusCounts).toSorted(byName));
      const got = JSON.stringify(Object.entries(actual).toSorted(byName));
      return expected === got ? [] : [`jql status counts ${got}, expected ${expected}`];
    }),
  });

  const latencyId = pageId(n.latencyPage);
  const latencyComments = page(n.latencyPage)?.comments.map((c) => c.id) ?? [];
  needles.push({
    n: 7,
    name: "latency-budget-comments",
    question:
      "On the atl smoke eval Architecture: API gateway rate limiting page, how many footer comments are there and which ones mention the latency budget?",
    expected: {
      pageId: latencyId,
      title: titleOf(n.latencyPage),
      url: page(n.latencyPage)?.url ?? null,
      footerComments: 6,
      mentioning: 2,
      mentioningCommentIds: n.latencyIndices.map((i) => latencyComments[i] ?? null),
      allCommentIds: latencyComments,
    },
    verify: await verified([["atl", "comment", "list", latencyId, "--all"]], (results) => {
      const items = itemsOf(at(results, 0));
      const mentioning = items.filter((c) => JSON.stringify(c).toLowerCase().includes(PHRASES.latency));
      const problems: string[] = [];
      if (items.length !== 6) {
        problems.push(`${items.length} footer comments, expected 6`);
      }
      if (mentioning.length !== 2) {
        problems.push(`${mentioning.length} mention the phrase, expected 2`);
      }
      return problems;
    }),
  });
  return needles;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function manifest(plan: Plan, state: State, extra: Json): Json {
  const issues = plan.issues.map((spec) => {
    const s = state.issues.get(spec.ref);
    return {
      ref: spec.ref,
      key: s?.key ?? null,
      url: s?.url ?? null,
      type: spec.type,
      summary: spec.summary,
      parent: spec.parentRef === null ? null : issueKey(state, spec.parentRef),
      labels: spec.labels,
      assignedToOwner: spec.assign,
      plannedStatus: spec.status,
      status: s?.status ?? null,
      priority: s?.priority ?? null,
      descriptionChars: spec.body.length,
      commentIds: s?.commentIds ?? [],
      worklogIds: s?.worklogIds ?? [],
    };
  });
  const pages = plan.pages.map((spec) => {
    const s = state.pages.get(spec.ref);
    return {
      ref: spec.ref,
      kind: spec.kind,
      id: s?.id ?? null,
      url: s?.url ?? null,
      title: spec.title,
      parentId: spec.kind === "blogpost" ? null : spec.parentRef === null ? HOME_PAGE : (state.pages.get(spec.parentRef)?.id ?? null),
      markdownBytes: Buffer.byteLength(spec.body),
      footerComments: s?.comments ?? [],
    };
  });
  const created = issues.filter((i) => i.key !== null);
  const createdPages = pages.filter((p) => p.id !== null);
  const archChildren = new Set(plan.pages.filter((p) => p.parentRef === "arch").map((p) => p.ref));
  return {
    site: SITE,
    project: PROJECT,
    space: SPACE,
    seed: SEED,
    prefix: PREFIX,
    binary: ATL,
    owner: state.owner,
    ...extra,
    counts: {
      epics: created.filter((i) => i.type === "Eposz").length,
      tasks: created.filter((i) => i.type === "Feladat").length,
      stories: created.filter((i) => i.type === "Story").length,
      subtasks: created.filter((i) => i.type === "Subtask").length,
      issuesTotal: created.length,
      issuesPlanned: plan.issues.length,
      issueStatus: tally(created.map((i) => i.status ?? "unknown")),
      issuePriority: tally(created.map((i) => i.priority ?? "unknown")),
      assignedToOwner: created.filter((i) => i.assignedToOwner).length,
      issueComments: created.reduce((sum, i) => sum + i.commentIds.length, 0),
      issuesWithComments: created.filter((i) => i.commentIds.length > 0).length,
      worklogs: created.reduce((sum, i) => sum + i.worklogIds.length, 0),
      issuesWithWorklogs: created.filter((i) => i.worklogIds.length > 0).length,
      links: tally(state.links.filter((l) => l.ok).map((l) => l.relation)),
      pages: createdPages.filter((p) => p.kind === "page").length,
      archChildren: createdPages.filter((p) => archChildren.has(p.ref)).length,
      archGrandchildren: createdPages.filter((p) => plan.pages.some((s) => s.ref === p.ref && s.parentRef !== null && archChildren.has(s.parentRef))).length,
      blogposts: createdPages.filter((p) => p.kind === "blogpost").length,
      pageFooterComments: createdPages.reduce((sum, p) => sum + p.footerComments.length, 0),
      pageReplies: createdPages.reduce((sum, p) => sum + p.footerComments.reduce((m, c) => m + c.replies.length, 0), 0),
      atlCalls: calls,
      errors: errors.length,
    },
    jira: { issues, links: state.links },
    confluence: { pages },
    errors,
  };
}

function writePartial(plan: Plan, state: State): void {
  writeFileSync(PARTIAL, `${JSON.stringify(manifest(plan, state, { partial: true }), null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--dry" && a !== "--force");
  if (unknown.length > 0) {
    log(`unknown arguments: ${unknown.join(" ")}; usage: bun eval/seed.ts [--dry] [--force]`);
    return 1;
  }
  const plan = buildPlan();
  if (args.includes("--dry")) {
    process.stdout.write(`${JSON.stringify(planSummary(plan), null, 2)}\n`);
    return 0;
  }
  if ((existsSync(MANIFEST) || existsSync(PARTIAL)) && !args.includes("--force")) {
    log(`${existsSync(MANIFEST) ? MANIFEST : PARTIAL} exists; the site is already seeded. Pass --force to seed again.`);
    return 1;
  }
  const started = performance.now();
  mkdirSync(BODIES, { recursive: true });
  const me = await atl("whoami", ["whoami"]);
  const state: State = {
    owner: { accountId: text(me, "accountId"), name: optionalText(me, "name") ?? "" },
    issues: new Map(),
    links: [],
    pages: new Map(),
  };
  await seedJira(plan, state);
  await seedConfluence(plan, state);
  log("verifying needles");
  const needles = await verifyNeedles(plan, state);
  const wallTimeSec = Math.round((performance.now() - started) / 100) / 10;
  const out = manifest(plan, state, { generatedAt: new Date().toISOString(), wallTimeSec, needles });
  writeFileSync(MANIFEST, `${JSON.stringify(out, null, 2)}\n`);
  rmSync(PARTIAL, { force: true });
  const failed = needles.filter((needle) => !needle.verify.passed).map((needle) => needle.n);
  log(
    `done in ${wallTimeSec}s, ${calls} atl calls, ${errors.length} errors; needles failed: ${failed.length > 0 ? failed.join(",") : "none"}`,
  );
  process.stdout.write(`${JSON.stringify({ manifest: MANIFEST, counts: out.counts, failedNeedles: failed }, null, 2)}\n`);
  return failed.length > 0 ? 4 : 0;
}

process.exitCode = await main();
