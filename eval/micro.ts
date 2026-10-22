#!/usr/bin/env bun
/**
 * Micro eval: the same data, one call each. For every pair, run the atl command and the equivalent
 * MCP v1 tool, count bytes and Claude tokens of what each prints, and check whether the output
 * carries what the task needs.
 *
 * Usage: bun eval/micro.ts
 *
 * "MCP" bytes are the raw text content the server returns, which is what an MCP host puts in the
 * model's context. `atl mcp call` re-serializes that text as one JSON value; its size is recorded
 * as mcpCallBytes/mcpCallTokens for reference. Outputs: eval/.out/micro.json, micro.md and the raw
 * stdout of every call under eval/.out/micro/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/core/guards.ts";
import { atl, claudeTokens, loadManifest, log, McpSession, needle, OUT, pageByTitle, writeJson } from "./lib.ts";

export interface McpCallSpec {
  tool: string;
  args: Record<string, unknown>;
}

export interface Pair {
  id: string;
  task: string;
  atlArgv: string[];
  mcp: McpCallSpec;
  /** Facts an agent needs; each must appear verbatim in the output. */
  needs: string[];
  note?: string;
}

export interface Measure {
  bytes: number;
  tokens: number;
  chars: number;
  hasNeeds: boolean;
  missing: string[];
}

export interface MicroRow {
  id: string;
  task: string;
  atl: Measure & { argv: string[]; code: number; ms: number };
  mcp: Measure & {
    tool: string;
    args: Record<string, unknown>;
    isError: boolean;
    ms: number;
    mcpCallBytes: number;
    mcpCallTokens: number;
  };
  byteRatio: number;
  tokenRatio: number;
  note: string;
}

const manifest = loadManifest();
const rollback = needle(manifest, "rollback-window-old-comment");
const handbook = needle(manifest, "handbook-cold-storage-retention");
const lantern = needle(manifest, "quartz-lantern-grandchild");
const latency = needle(manifest, "latency-budget-comments");
const epic = needle(manifest, "mixed-status-epic");
const rateLimiting = pageByTitle(manifest, "atl smoke eval Architecture: API gateway rate limiting");
const architecture = pageByTitle(manifest, "atl smoke eval Architecture");
const epicChildren = manifest.jira.issues.filter((issue) => issue.parent === "KAN-6");
const epicStatuses = isRecord(epic.statusCounts) ? Object.keys(epic.statusCounts) : [];

function str(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("manifest needle field is not a string");
  }
  return value;
}

const PAIRS: Pair[] = [
  {
    id: "issue-get",
    task: "Read KAN-18: status, assignee, labels, description table",
    atlArgv: ["issue", "get", "KAN-18"],
    mcp: { tool: "getJiraIssue", args: { issueIdOrKey: "KAN-18", responseContentFormat: "markdown" } },
    needs: ["Folyamatban", "foldvarszki", "needle-quartz", "48,210 EUR"],
    note: "MCP returns the raw Jira REST issue (all fields, avatar URLs, self links).",
  },
  {
    id: "issue-get-fields",
    task: "Same as issue-get, MCP told to project fields",
    atlArgv: ["issue", "get", "KAN-18"],
    mcp: {
      tool: "getJiraIssue",
      args: {
        issueIdOrKey: "KAN-18",
        responseContentFormat: "markdown",
        fields: ["summary", "status", "assignee", "labels", "description"],
      },
    },
    needs: ["Folyamatban", "foldvarszki", "needle-quartz", "48,210 EUR"],
    note: "Fairness variant: an agent that already knows to pass `fields`.",
  },
  {
    id: "issue-get-comments",
    task: "Read KAN-91 with its 12 comments",
    atlArgv: ["issue", "get", "KAN-91", "--comments", "12"],
    mcp: { tool: "getJiraIssue", args: { issueIdOrKey: "KAN-91", responseContentFormat: "markdown" } },
    needs: [str(rollback.phrase)],
    note: "getJiraIssue default fields omit comments entirely (fields.comment absent); the agent must know to pass fields=[\"comment\"].",
  },
  {
    id: "issue-get-comments-fields",
    task: "Same as issue-get-comments, MCP told to project fields",
    atlArgv: ["issue", "get", "KAN-91", "--comments", "12"],
    mcp: {
      tool: "getJiraIssue",
      args: {
        issueIdOrKey: "KAN-91",
        responseContentFormat: "markdown",
        fields: ["summary", "status", "comment"],
      },
    },
    needs: [str(rollback.phrase)],
    note: "Fairness variant.",
  },
  {
    id: "jql",
    task: "Children of epic KAN-6 (25 issues) with status",
    atlArgv: ["jql", "parent = KAN-6", "--limit", "25"],
    mcp: { tool: "searchJiraIssuesUsingJql", args: { jql: "parent = KAN-6", maxResults: 25, responseContentFormat: "markdown" } },
    needs: [...epicChildren.map((issue) => issue.key), ...epicStatuses],
    note: "MCP default `fields` returns every field of every issue.",
  },
  {
    id: "jql-fields",
    task: "Same as jql, MCP told to project fields",
    atlArgv: ["jql", "parent = KAN-6", "--limit", "25"],
    mcp: {
      tool: "searchJiraIssuesUsingJql",
      args: { jql: "parent = KAN-6", maxResults: 25, fields: ["summary", "status"], responseContentFormat: "markdown" },
    },
    needs: [...epicChildren.map((issue) => issue.key), ...epicStatuses],
    note: "Fairness variant.",
  },
  {
    id: "transitions",
    task: "Transitions available on KAN-18",
    atlArgv: ["issue", "transitions", "KAN-18"],
    mcp: { tool: "getTransitionsForJiraIssue", args: { issueIdOrKey: "KAN-18" } },
    needs: ["Ellenőrzés alatt", "Teendő", "Kész"],
  },
  {
    id: "user-find",
    task: "Account id of foldvarszki",
    atlArgv: ["user", "find", "foldvarszki"],
    mcp: { tool: "lookupJiraAccountId", args: { searchString: "foldvarszki" } },
    needs: [manifest.owner.accountId],
  },
  {
    id: "project-list",
    task: "Visible Jira projects",
    atlArgv: ["project", "list"],
    mcp: { tool: "getVisibleJiraProjects", args: {} },
    needs: ["KAN"],
    note: "MCP expandIssueTypes defaults to true.",
  },
  {
    id: "page-get",
    task: "Platform Handbook page (246 KB markdown) for the cold storage retention row",
    atlArgv: ["page", "get", str(handbook.pageId)],
    mcp: { tool: "getConfluencePage", args: { pageId: str(handbook.pageId), contentFormat: "markdown" } },
    needs: [str(handbook.tableRow)],
    note: "Both print the whole body; the atl skill steers agents to `--output` plus grep instead.",
  },
  {
    id: "page-tree",
    task: "Descendants of the Architecture page (30 children, 14 grandchildren)",
    atlArgv: ["page", "tree", architecture.id],
    mcp: { tool: "getConfluencePageDescendants", args: { pageId: architecture.id } },
    needs: ["589841", "65801"],
    note: "Both return 25 descendants plus a cursor on the first call (30 children + 14 grandchildren total).",
  },
  {
    id: "comment-list",
    task: "Footer comments of the API gateway rate limiting page (6)",
    atlArgv: ["comment", "list", rateLimiting.id],
    mcp: { tool: "getConfluencePageFooterComments", args: { pageId: rateLimiting.id, contentFormat: "markdown" } },
    needs: ["25 ms at p99", "40 ms"],
    note: `Seed: ${String(latency.footerComments)} comments, ${String(latency.mentioning)} mention the latency budget.`,
  },
  {
    id: "cql",
    task: "Pages titled like 'atl smoke eval', 25 hits",
    atlArgv: ["cql", 'title ~ "atl smoke eval"', "--limit", "25"],
    mcp: { tool: "searchConfluenceUsingCql", args: { cql: 'title ~ "atl smoke eval"', limit: 25 } },
    needs: ["atl smoke eval Architecture: Disaster recovery"],
    note: "Both return the same 25-hit first page (relevance order; the Handbook is not on it).",
  },
  {
    id: "search",
    task: "Rovo search for 'quartz lantern protocol'",
    atlArgv: ["search", "quartz lantern protocol"],
    mcp: { tool: "search", args: { query: "quartz lantern protocol" } },
    needs: ["Edge relay handshake"],
    note: `Expected page ${str(lantern.id)}; MCP search returns ARIs, atl returns the page id.`,
  },
  {
    id: "graph-context",
    task: "Teamwork Graph context of KAN-46",
    atlArgv: ["graph", "context", "JiraWorkItem", "KAN-46"],
    mcp: { tool: "getTeamworkGraphContext", args: { objectType: "JiraWorkItem", objectIdentifier: "KAN-46" } },
    needs: ["KAN-46", "atlassian_user_created_jira_work_item"],
    note: "Summary level lists relationship names with counts only; neither side lists the blocks link to KAN-98.",
  },
];

async function measure(text: string, needs: readonly string[]): Promise<Measure> {
  const missing = needs.filter((needleText) => !text.includes(needleText));
  return {
    bytes: Buffer.byteLength(text),
    chars: text.length,
    tokens: await claudeTokens(text),
    hasNeeds: missing.length === 0,
    missing,
  };
}

async function main(): Promise<void> {
  const raw = join(OUT, "micro");
  mkdirSync(raw, { recursive: true });
  const session = new McpSession();
  await session.open();
  const resources = await session.call("getAccessibleAtlassianResources", {});
  const cloud = /"id"\s*:\s*"([0-9a-f-]{36})"[^}]*?foldvarszki|foldvarszki[^}]*?"id"\s*:\s*"([0-9a-f-]{36})"/s.exec(
    resources.text,
  );
  const cloudId = cloud?.[1] ?? cloud?.[2];
  if (cloudId === undefined) {
    throw new Error("could not find the foldvarszki cloudId in getAccessibleAtlassianResources");
  }

  const rows: MicroRow[] = [];
  for (const pair of PAIRS) {
    const atlResult = await atl(...pair.atlArgv);
    const mcpArgs = { cloudId, ...pair.mcp.args };
    const mcpResult = await (async () => {
      const started = performance.now();
      const result = await session.call(pair.mcp.tool, mcpArgs);
      return { ...result, ms: Math.round(performance.now() - started) };
    })();
    const callArgv = ["mcp", "call", pair.mcp.tool, ...Object.entries(pair.mcp.args).flatMap(([key, value]) => ["--arg", `${key}=${JSON.stringify(value)}`])];
    const viaAtl = await atl(...callArgv);
    writeFileSync(join(raw, `${pair.id}.atl.txt`), atlResult.stdout);
    writeFileSync(join(raw, `${pair.id}.mcp.txt`), mcpResult.text);
    writeFileSync(join(raw, `${pair.id}.mcpcall.txt`), viaAtl.stdout);
    const atlMeasure = await measure(atlResult.stdout, pair.needs);
    const mcpMeasure = await measure(mcpResult.text, pair.needs);
    const row: MicroRow = {
      id: pair.id,
      task: pair.task,
      atl: { ...atlMeasure, argv: pair.atlArgv, code: atlResult.code, ms: atlResult.ms },
      mcp: {
        ...mcpMeasure,
        tool: pair.mcp.tool,
        args: pair.mcp.args,
        isError: mcpResult.isError,
        ms: mcpResult.ms,
        mcpCallBytes: Buffer.byteLength(viaAtl.stdout),
        mcpCallTokens: await claudeTokens(viaAtl.stdout),
      },
      byteRatio: Number((mcpMeasure.bytes / Math.max(atlMeasure.bytes, 1)).toFixed(2)),
      tokenRatio: Number((mcpMeasure.tokens / Math.max(atlMeasure.tokens, 1)).toFixed(2)),
      note: pair.note ?? "",
    };
    rows.push(row);
    log(`${pair.id}: atl ${row.atl.bytes}B/${row.atl.tokens}t  mcp ${row.mcp.bytes}B/${row.mcp.tokens}t  x${row.tokenRatio}`);
  }

  writeJson(join(OUT, "micro.json"), { generatedAt: new Date().toISOString(), tokenizer: "claude-v5", cloudId, rows });
  writeFileSync(join(OUT, "micro.md"), renderMicroTable(rows));
}

function parity(measureResult: Measure): string {
  return measureResult.hasNeeds ? "yes" : `NO (missing: ${measureResult.missing.join(", ")})`;
}

export function renderMicroTable(rows: readonly MicroRow[]): string {
  const lines = [
    "| pair | atl bytes | atl tok | MCP bytes | MCP tok | tok ratio (MCP/atl) | atl has needed info | MCP has needed info | notes |",
    "|---|---:|---:|---:|---:|---:|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.id} (\`atl ${row.atl.argv.join(" ")}\` vs \`${row.mcp.tool}\`) | ${row.atl.bytes} | ${row.atl.tokens} | ${row.mcp.bytes} | ${row.mcp.tokens} | ${row.tokenRatio} | ${parity(row.atl)} | ${parity(row.mcp)} | ${row.note} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  await main();
}
