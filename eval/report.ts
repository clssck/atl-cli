#!/usr/bin/env bun
/**
 * Build eval/.out/report.md from eval/.out/micro.json and eval/.out/runs/<arm>/*.metrics.json.
 * Every number in the generated sections comes from those files. Hand-written analysis goes in
 * eval/.out/friction.md and is appended verbatim.
 *
 * Usage: bun eval/report.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/core/guards.ts";
import { OUT } from "./lib.ts";
import { type MicroRow, renderMicroTable } from "./micro.ts";
import { type RunMetrics, SESSION_REP, type ToolCallRecord } from "./run.ts";

const ARMS = ["atl", "mcp"] as const;

function isRunMetrics(value: unknown): value is RunMetrics {
  return (
    isRecord(value) &&
    (value.arm === "atl" || value.arm === "mcp") &&
    typeof value.scenario === "string" &&
    Array.isArray(value.toolCalls) &&
    isRecord(value.usage)
  );
}

function isMicroRow(value: unknown): value is MicroRow {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.atl) && isRecord(value.mcp);
}

function loadRuns(): RunMetrics[] {
  const runs: RunMetrics[] = [];
  for (const dirName of readdirSync(join(OUT, "runs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()) {
    const dir = join(OUT, "runs", dirName);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".metrics.json")).toSorted()) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!isRunMetrics(parsed)) {
        throw new Error(`${dirName}/${name} is not a run metrics file`);
      }
      runs.push(parsed);
    }
  }
  return runs;
}

function loadMicro(): MicroRow[] {
  const parsed: unknown = JSON.parse(readFileSync(join(OUT, "micro.json"), "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.rows) || !parsed.rows.every(isMicroRow)) {
    throw new Error("micro.json has no valid rows; run bun eval/micro.ts");
  }
  return parsed.rows;
}

/** omp exposes MCP tools as xd:// devices, so an MCP call is recorded as `write` with an xd path. */
function toolLabel(call: ToolCallRecord): string {
  const device = /"path":"xd:\/\/([^"]+)"/.exec(call.args ?? "")?.[1];
  return device === undefined ? call.name : `${call.name}:${device}`;
}

function sum(runs: readonly RunMetrics[], pick: (run: RunMetrics) => number): number {
  return runs.reduce((total, run) => total + pick(run), 0);
}

function runRow(run: RunMetrics): string {
  return `| ${run.scenario} | ${run.arm} | ${run.rep} | ${run.success ? "pass" : `FAIL (${run.checkDetails.filter((line) => line.startsWith("FAIL")).join("; ") || run.stopReason})`} | ${run.turns} | ${run.toolCallCount} | ${run.resultTokens} | ${run.finalContext} | ${run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite} | ${run.usage.cost.toFixed(3)} | ${Math.round(run.wallMs / 1000)} |`;
}

function macroTable(runs: readonly RunMetrics[]): string {
  const lines = [
    "| scenario | arm | rep | success | turns | tool calls | tool-result tokens | final context | summed tokens (in+out+cache) | cost USD | wall s |",
    "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ...runs
      .toSorted((a, b) => a.scenario.localeCompare(b.scenario) || a.rep - b.rep || a.arm.localeCompare(b.arm))
      .map(runRow),
  ];
  return lines.join("\n");
}

function totalsTable(runs: readonly RunMetrics[]): string {
  const lines = [
    "| arm | runs | passed | tool calls | tool-result tokens | mean final context | summed tokens (in+out+cache) | summed output tokens | cost USD | wall s |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const arm of ARMS) {
    const own = runs.filter((run) => run.arm === arm);
    if (own.length === 0) {
      continue;
    }
    lines.push(
      `| ${arm} | ${own.length} | ${own.filter((run) => run.success).length} | ${sum(own, (run) => run.toolCallCount)} | ${sum(own, (run) => run.resultTokens)} | ${Math.round(sum(own, (run) => run.finalContext) / own.length)} | ${sum(own, (run) => run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite)} | ${sum(own, (run) => run.usage.output)} | ${sum(own, (run) => run.usage.cost).toFixed(3)} | ${Math.round(sum(own, (run) => run.wallMs) / 1000)} |`,
    );
  }
  return lines.join("\n");
}

interface Flagged {
  run: RunMetrics;
  call: ToolCallRecord;
}

const CLASSES: [string, (call: ToolCallRecord) => boolean][] = [
  ["help / command discovery", (call) => /--help|\s-h(\s|$)|\bcommands\b|\batl help\b/.test(call.command ?? "")],
  ["--full", (call) => /--full\b/.test(call.command ?? "")],
  ["--all", (call) => /--all\b/.test(call.command ?? "")],
  ["tool error", (call) => call.isError],
  ["result over 1500 tokens", (call) => call.resultTokens > 1500],
  ["--output file then read/grep", (call) => /--output\b/.test(call.command ?? "")],
];

function frictionTable(runs: readonly RunMetrics[], arm: string): string {
  const flagged: Flagged[] = runs
    .filter((run) => run.arm === arm)
    .flatMap((run) => run.toolCalls.map((call) => ({ run, call })));
  const lines = [
    "| pattern | calls | result tokens | runs affected |",
    "|---|---:|---:|---|",
  ];
  for (const [label, test] of CLASSES) {
    const hits = flagged.filter((entry) => test(entry.call));
    if (hits.length === 0) {
      continue;
    }
    const affected = [...new Set(hits.map((entry) => `${entry.run.scenario}-${entry.run.rep}`))].join(", ");
    lines.push(`| ${label} | ${hits.length} | ${hits.reduce((total, entry) => total + entry.call.resultTokens, 0)} | ${affected} |`);
  }
  return lines.join("\n");
}

function topCalls(runs: readonly RunMetrics[], arm: string, count: number): string {
  const calls = runs
    .filter((run) => run.arm === arm)
    .flatMap((run) => run.toolCalls.map((call) => ({ run, call })))
    .toSorted((a, b) => b.call.resultTokens - a.call.resultTokens)
    .slice(0, count);
  const lines = ["| run | tool | call | result tokens |", "|---|---|---|---:|"];
  for (const { run, call } of calls) {
    const shown = (call.command ?? call.args ?? "").replaceAll("\n", " ").replaceAll("|", "\\|").slice(0, 160);
    lines.push(`| ${run.scenario}-${run.rep} | ${toolLabel(call)} | \`${shown}\` | ${call.resultTokens} |`);
  }
  return lines.join("\n");
}

function commandLog(runs: readonly RunMetrics[], arm: string): string {
  const lines: string[] = [];
  for (const run of runs.filter((entry) => entry.arm === arm)) {
    lines.push(`- ${run.scenario}-${run.rep} (${run.success ? "pass" : "FAIL"}):`);
    for (const call of run.toolCalls) {
      const shown = (call.command ?? call.args ?? "").replaceAll("\n", " ").slice(0, 200);
      lines.push(`  - ${toolLabel(call)}${call.isError ? " [error]" : ""} ${call.resultTokens}t: \`${shown.replaceAll("`", "'")}\``);
    }
  }
  return lines.join("\n");
}

interface HarnessStats {
  firstContext: number[];
  skillReads: number;
  skillTokens: number;
  schemaReads: number;
  schemaTokens: number;
  truncatedResults: number;
  blockedShellGrep: number;
  artifactUnavailable: number;
  deadlineAborts: number;
  toolErrors: number;
}

/** Counts that only the raw omp events show: first-turn context, harness truncation, blocks. */
function harnessStats(runs: readonly RunMetrics[], arm: string): HarnessStats {
  const stats: HarnessStats = {
    firstContext: [],
    skillReads: 0,
    skillTokens: 0,
    schemaReads: 0,
    schemaTokens: 0,
    truncatedResults: 0,
    blockedShellGrep: 0,
    artifactUnavailable: 0,
    deadlineAborts: 0,
    toolErrors: 0,
  };
  for (const run of runs.filter((entry) => entry.arm === arm)) {
    for (const call of run.toolCalls) {
      stats.toolErrors += call.isError ? 1 : 0;
      const target = call.args ?? "";
      if (call.name === "read" && target.includes("skill://atl")) {
        stats.skillReads += 1;
        stats.skillTokens += call.resultTokens;
      }
      if (call.name === "read" && target.includes("xd://mcp__")) {
        stats.schemaReads += 1;
        stats.schemaTokens += call.resultTokens;
      }
    }
    const dir = join(OUT, "runs", run.tag === undefined ? run.arm : `${run.arm}-${run.tag}`);
    const jsonl = readFileSync(join(dir, `${run.scenario}-${run.rep}.jsonl`), "utf8");
    let firstAssistant = true;
    for (const line of jsonl.split("\n").filter((entry) => entry !== "")) {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) {
        continue;
      }
      const message = event.message;
      if (message.role === "assistant" && firstAssistant && isRecord(message.usage)) {
        firstAssistant = false;
        const usage = message.usage;
        stats.firstContext.push(Number(usage.input) + Number(usage.cacheRead) + Number(usage.cacheWrite));
      }
      if (message.role !== "toolResult") {
        continue;
      }
      const text = Array.isArray(message.content)
        ? message.content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("")
        : "";
      const limits = isRecord(message.details) && isRecord(message.details.meta) ? message.details.meta.limits : undefined;
      stats.truncatedResults += isRecord(limits) && "columnTruncated" in limits ? 1 : 0;
      stats.blockedShellGrep += text.startsWith("Blocked: Use the `grep` tool") ? 1 : 0;
      stats.artifactUnavailable += text.includes("artifacts unavailable") || text.includes("artifact://0: No such file") ? 1 : 0;
      stats.deadlineAborts += text.includes("Deadline exceeded") ? 1 : 0;
    }
  }
  return stats;
}

function harnessTable(runs: readonly RunMetrics[]): string {
  const lines = [
    "| arm | first-turn context (min-max) | skill reads | skill-read result tokens | MCP schema reads | schema-read tokens | results cut at 768 bytes/line | shell grep blocked | artifact unreadable | tool deadline aborts | tool errors |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const arm of ARMS.filter((name) => runs.some((run) => run.arm === name))) {
    const s = harnessStats(runs, arm);
    lines.push(
      `| ${arm} | ${Math.min(...s.firstContext)}-${Math.max(...s.firstContext)} | ${s.skillReads} | ${s.skillTokens} | ${s.schemaReads} | ${s.schemaTokens} | ${s.truncatedResults} | ${s.blockedShellGrep} | ${s.artifactUnavailable} | ${s.deadlineAborts} | ${s.toolErrors} |`,
    );
  }
  return lines.join("\n");
}

function mean(runs: readonly RunMetrics[], pick: (run: RunMetrics) => number): number {
  return Math.round(sum(runs, pick) / Math.max(runs.length, 1));
}

function variantRow(scenario: string, label: string, own: readonly RunMetrics[]): string {
  return `| ${scenario} | ${label} | ${own.filter((run) => run.success).length}/${own.length} | ${(sum(own, (run) => run.toolCallCount) / Math.max(own.length, 1)).toFixed(1)} | ${mean(own, (run) => run.resultTokens)} | ${mean(own, (run) => run.finalContext)} | ${mean(own, (run) => run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite)} | ${(sum(own, (run) => run.usage.cost) / Math.max(own.length, 1)).toFixed(3)} | ${Math.round(mean(own, (run) => run.wallMs) / 1000)} |`;
}

/** Per-scenario and total comparison of atl round 1, atl round 2 and mcp (reps 1-2, means per run). */
function roundTwoSection(firstTwo: readonly RunMetrics[], round2: readonly RunMetrics[]): string[] {
  if (round2.length === 0) {
    return [];
  }
  const variants: [string, RunMetrics[]][] = [
    ["atl r1", firstTwo.filter((run) => run.arm === "atl")],
    ["atl r2", [...round2]],
    ["mcp", firstTwo.filter((run) => run.arm === "mcp")],
  ];
  const scenarios = [...new Set(firstTwo.map((run) => run.scenario))].toSorted();
  const header = [
    "| scenario | variant | pass | tool calls | result tokens | final context | summed tokens | cost USD | wall s |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  const rows = scenarios.flatMap((scenario) =>
    variants.map(([label, own]) => variantRow(scenario, label, own.filter((run) => run.scenario === scenario))),
  );
  const totals = variants.map(([label, own]) => variantRow("**total (per run mean)**", label, own));
  return [
    "",
    "## Round 2: atl arm after output-layout, `--output` and skill changes",
    "",
    "Same prompts, model and settings as round 1 (`--no-session`), atl arm only, 2 reps per scenario, fresh binary and skill; files under `eval/.out/runs/atl-r2/`. Cells are means over reps 1-2 (pass is count of reps). `atl r1` and `mcp` are the round-1 runs from the tables above.",
    "",
    ...header,
    ...rows,
    "",
    "### Totals per run (means over all scenarios and reps 1-2)",
    "",
    ...header,
    ...totals,
    "",
    "### Harness and context facts, atl r2",
    "",
    harnessTable(round2),
    "",
    "### Friction patterns, atl r2 (machine-classified)",
    "",
    frictionTable(round2, "atl"),
    "",
    "### Tool-call log, atl r2",
    "",
    commandLog(round2, "atl"),
    "",
  ];
}

/** s1/s3/s7: atl r1 vs r2 vs r3 vs mcp, plus retry lines the r3 binary wrote to stderr. */
function roundThreeSection(
  firstTwo: readonly RunMetrics[],
  round2: readonly RunMetrics[],
  round3: readonly RunMetrics[],
): string[] {
  if (round3.length === 0) {
    return [];
  }
  const scenarios = [...new Set(round3.map((run) => run.scenario))].toSorted();
  const only = (runs: readonly RunMetrics[]) => runs.filter((run) => scenarios.includes(run.scenario));
  const variants: [string, RunMetrics[]][] = [
    ["atl r1", only(firstTwo.filter((run) => run.arm === "atl"))],
    ["atl r2", only(round2)],
    ["atl r3", [...round3]],
    ["mcp", only(firstTwo.filter((run) => run.arm === "mcp"))],
  ];
  const header = [
    "| scenario | variant | pass | tool calls | result tokens | final context | summed tokens | cost USD | wall s |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  const rows = scenarios.flatMap((scenario) =>
    variants.map(([label, own]) => variantRow(scenario, label, own.filter((run) => run.scenario === scenario))),
  );
  const totals = variants.map(([label, own]) => variantRow("**s1+s3+s7 mean**", label, own));
  const retryLines = retryLineCount(round3);
  return [
    "",
    "## Round 3: atl arm, s1 / s3 / s7 only",
    "",
    "Same prompts, model and settings (`--no-session`), atl arm only, 2 reps; files under `eval/.out/runs/atl-r3/`. Cells are means over reps 1-2 (pass is a count). `atl r1`, `atl r2` and `mcp` are the earlier runs of the same scenarios.",
    "",
    "What each round measured (the atl side changed between rounds; model, prompts and harness did not):",
    "",
    "- **r1 -> r2** measured three changes together: width-bounded default stdout (one item or property per line once a value exceeds ~700 bytes), `--output` on page/issue/comment get writing the body markdown to a file with `{path, bytes, lines}` in place, and the first skill rewrite (harness grep tool, specific phrases, numeric ids, parentId, `--replies`). The eval cannot separate these three.",
    "- **r2 -> r3** measured two changes together: the skill's long-text directive (print issues, comment lists and search directly; `--output` only for Confluence page bodies or after a cut; shell grep/cat/head may be blocked) and the HTTP retry cap (20 s total sleep, stderr `{type:\"retry\"}` lines). The directive change targets the s1/s3/s7 call-count increase; the retry cap only matters when the server returns 429.",
    "- `eval/lib.ts` credential resolution changed between r2 and r3; it does not touch what the agent sees.",
    "",
    ...header,
    ...rows,
    "",
    "### Mean over the three scenarios",
    "",
    ...header,
    ...totals,
    "",
    `Retry lines on stderr across the ${round3.length} r3 runs: ${retryLines}.`,
    "",
    "### Harness and context facts, atl r3",
    "",
    harnessTable(round3),
    "",
    "### Friction patterns, atl r3 (machine-classified)",
    "",
    frictionTable(round3, "atl"),
    "",
    "### Tool-call log, atl r3",
    "",
    commandLog(round3, "atl"),
    "",
  ];
}

function runText(run: RunMetrics, suffix: string): string {
  const dir = join(OUT, "runs", run.tag === undefined ? run.arm : `${run.arm}-${run.tag}`);
  return readFileSync(join(dir, `${run.scenario}-${run.rep}${suffix}`), "utf8");
}

/** `{type:"retry"}` lines atl wrote to stderr (HTTP retries; only binaries from round 3 on emit them). */
function retryLineCount(runs: readonly RunMetrics[]): number {
  return sum(runs, (run) => runText(run, ".stderr.txt").split("\n").filter((line) => line.includes('"type":"retry"')).length);
}

/** Tool results in which the harness cut a line: omp's truncation notice in the text or its `columnTruncated` meta. */
function lineCutCount(runs: readonly RunMetrics[]): number {
  return sum(runs, (run) => {
    let cuts = 0;
    for (const line of runText(run, ".jsonl").split("\n").filter((entry) => entry !== "")) {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) {
        continue;
      }
      const message = event.message;
      if (message.role !== "toolResult") {
        continue;
      }
      const text = Array.isArray(message.content)
        ? message.content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("")
        : "";
      const limits = isRecord(message.details) && isRecord(message.details.meta) ? message.details.meta.limits : undefined;
      cuts += text.includes("[Some lines truncated") || (isRecord(limits) && "columnTruncated" in limits) ? 1 : 0;
    }
    return cuts;
  });
}

function callMean(own: readonly RunMetrics[], scenario: string): string {
  const picked = own.filter((run) => run.scenario === scenario);
  return (sum(picked, (run) => run.toolCallCount) / Math.max(picked.length, 1)).toFixed(1);
}

/** All scenarios: atl r1 / r2 / r4 vs mcp, totals, harness line cuts per atl round, s1/s3/s7 call check. */
function roundFourSection(
  firstTwo: readonly RunMetrics[],
  round2: readonly RunMetrics[],
  round3: readonly RunMetrics[],
  round4: readonly RunMetrics[],
): string[] {
  if (round4.length === 0) {
    return [];
  }
  const atlR1 = firstTwo.filter((run) => run.arm === "atl");
  const mcp = firstTwo.filter((run) => run.arm === "mcp");
  const variants: [string, readonly RunMetrics[]][] = [
    ["atl r1", atlR1],
    ["atl r2", round2],
    ["atl r4", round4],
    ["mcp", mcp],
  ];
  const scenarios = [...new Set(round4.map((run) => run.scenario))].toSorted();
  const header = [
    "| scenario | variant | pass | tool calls | result tokens | final context | summed tokens | cost USD | wall s |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  const rows = scenarios.flatMap((scenario) =>
    variants.map(([label, own]) => variantRow(scenario, label, own.filter((run) => run.scenario === scenario))),
  );
  const totals = variants.map(([label, own]) => variantRow("**total (per run mean)**", label, own));
  const focus = ["s1-needle-quartz", "s3-rollback-window", "s7-latency-comments"];
  const rounds: [string, readonly RunMetrics[]][] = [
    ["atl r1", atlR1],
    ["atl r2", round2],
    ["atl r3 (s1/s3/s7 only)", round3],
    ["atl r4", round4],
  ];
  return [
    "",
    "## Round 4: atl arm, all scenarios, line-array bodies",
    "",
    "Same prompts, model and settings (`--no-session`), atl arm only, 2 reps per scenario; files under `eval/.out/runs/atl-r4/`. Cells are means over reps 1-2 (pass is a count). `atl r1`, `atl r2` and `mcp` are the earlier runs.",
    "",
    "**r3 -> r4 measured two changes together:** compact markdown bodies printed as `string[]` of lines (prose soft-wrapped at 600 encoded bytes), so no stdout line should exceed ~700 bytes; and the rewritten skill long-text directive (print results whole; `--output` only for Confluence page bodies or results over 50 KB; one-call examples `issue get KEY --comments N` and `jql ... --issue-fields description`).",
    "",
    ...header,
    ...rows,
    "",
    "### Totals per run (means over all scenarios and reps 1-2)",
    "",
    ...header,
    ...totals,
    "",
    "### Tool calls on s1 / s3 / s7: atl r4 vs mcp",
    "",
    "| scenario | atl r1 | atl r2 | atl r4 | mcp |",
    "|---|---:|---:|---:|---:|",
    ...focus.map(
      (scenario) =>
        `| ${scenario} | ${callMean(atlR1, scenario)} | ${callMean(round2, scenario)} | ${callMean(round4, scenario)} | ${callMean(mcp, scenario)} |`,
    ),
    "",
    "Atl call counts include the skill `read` (one call per run); mcp runs have no equivalent call.",
    "",
    "### Harness line-cut notices in the atl arm (tool results omp truncated at 768 bytes per line)",
    "",
    "| round | runs | results with a line-cut notice | HTTP retry lines on stderr |",
    "|---|---:|---:|---:|",
    ...rounds.map(([label, own]) => `| ${label} | ${own.length} | ${lineCutCount(own)} | ${retryLineCount(own)} |`),
    "",
    "### Harness and context facts, atl r4",
    "",
    harnessTable(round4),
    "",
    "### Friction patterns, atl r4 (machine-classified)",
    "",
    frictionTable(round4, "atl"),
    "",
    "### Tool-call log, atl r4",
    "",
    commandLog(round4, "atl"),
    "",
  ];
}

function main(): void {
  const everything = loadRuns();
  const round2 = everything.filter((run) => run.tag === "r2");
  const round3 = everything.filter((run) => run.tag === "r3");
  const round4 = everything.filter((run) => run.tag === "r4");
  const all = everything.filter((run) => run.tag === undefined);
  const runs = all.filter((run) => run.rep < SESSION_REP);
  const sessionRuns = all.filter((run) => run.rep >= SESSION_REP);
  const firstTwo = runs.filter((run) => run.rep <= 2);
  const micro = loadMicro();
  const friction = join(OUT, "friction.md");
  const sections = [
    "# atl vs Atlassian MCP: eval report",
    "",
    "Sources: `eval/.out/micro.json` (micro), `eval/.out/runs/<arm>/*.metrics.json` and `*.jsonl` (macro). Token counts are Claude v5 tokenizer counts from `omp toks`; macro cost, turns and context come from omp usage events.",
    "",
    "## Micro: one call each, same data",
    "",
    "MCP bytes are the raw text content the server returns (what an MCP host puts in the model's context). Ratio = MCP/atl.",
    "",
    renderMicroTable(micro),
    "",
    `Micro totals over the ${micro.length} pairs: atl ${micro.reduce((total, row) => total + row.atl.tokens, 0)} tokens, MCP ${micro.reduce((total, row) => total + row.mcp.tokens, 0)} tokens.`,
    "",
    "## Macro: agents through omp -p",
    "",
    macroTable(runs),
    "",
    "### Totals per arm (all reps, 17 runs per arm; mcp includes one tool-deadline failure)",
    "",
    totalsTable(runs),
    "",
    "### Totals per arm (reps 1-2 only, 16 runs per arm)",
    "",
    totalsTable(firstTwo),
    "",
    "### Harness and context facts (from the raw omp events)",
    "",
    harnessTable(runs),
    "",
    "### Session-persisting variant (s4 and s6 re-run with the omp session kept, so spilled results are re-readable; not in the totals above)",
    "",
    macroTable(sessionRuns),
    "",
    "### Largest tool results (atl arm)",
    "",
    topCalls(runs, "atl", 8),
    "",
    "### Largest tool results (mcp arm)",
    "",
    topCalls(runs, "mcp", 8),
    "",
    "### Friction patterns by arm (machine-classified from tool calls)",
    "",
    "atl arm:",
    "",
    frictionTable(runs, "atl"),
    "",
    "mcp arm:",
    "",
    frictionTable(runs, "mcp"),
    "",
    "### Tool-call logs",
    "",
    "atl arm:",
    "",
    commandLog(runs, "atl"),
    "",
    "mcp arm:",
    "",
    commandLog(runs, "mcp"),
    "",
  ];
  if (existsSync(friction)) {
    sections.push(readFileSync(friction, "utf8"));
  }
  sections.push(...roundTwoSection(firstTwo, round2));
  const friction2 = join(OUT, "friction2.md");
  if (existsSync(friction2)) {
    sections.push(readFileSync(friction2, "utf8"));
  }
  sections.push(...roundThreeSection(firstTwo, round2, round3));
  const friction3 = join(OUT, "friction3.md");
  if (existsSync(friction3)) {
    sections.push(readFileSync(friction3, "utf8"));
  }
  sections.push(...roundFourSection(firstTwo, round2, round3, round4));
  const friction4 = join(OUT, "friction4.md");
  if (existsSync(friction4)) {
    sections.push(readFileSync(friction4, "utf8"));
  }
  writeFileSync(join(OUT, "report.md"), `${sections.join("\n")}\n`);
}

main();
