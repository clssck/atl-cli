#!/usr/bin/env bun
/**
 * Macro eval: run the scenarios through headless omp agents, one workdir per arm.
 *
 * Usage:
 *   bun eval/run.ts probe                          verify the arms' tool surface (1 prompt each)
 *   bun eval/run.ts rejudge                        re-apply the answer checks (both sets) to saved final texts
 *   bun eval/run.ts list [--set macro|nightmare]   scenario ids, kind and name (no model call)
 *   bun eval/run.ts run [--set macro|nightmare] [--rep N] [--arms atl,atl-pre,mcp] [--scenarios s1-needle-quartz,...]
 *                       [--tag label] [--sessions]
 *
 * `--set nightmare` runs n01-n42 (eval/nightmare/scenarios.ts) and writes to runs/<arm>-nm[-label]/.
 *
 * `--tag r3` writes to runs/<arm>-r3/ (a later round; rebuild the atl binary first). Every command
 * recreates the arm workdirs and the skill copy, so only /tmp/atl-eval/bin/atl must exist.
 *
 * Arms: `atl` has the atl skill and binary on PATH and the Atlassian MCP server disabled; `atl-pre` is
 * `atl` with the skill text appended to the system prompt instead of a discoverable skill file (no
 * skill read costs a tool call); `mcp` has
 * the MCP v1 server configured with atl's bearer (via the child's env only) and no atl on PATH.
 * Per run it writes eval/.out/runs/<arm>[-<tag>]/<scenario>-<rep>.{jsonl,stderr.txt,metrics.json}.
 * Runs are sequential, arms interleaved per scenario. The bearer is never printed or stored.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/core/guards.ts";
import {
  ARMS_DIR,
  ATL_BIN_DIR,
  atl,
  bearer,
  claudeTokens,
  log,
  loadManifest,
  MCP_URL,
  OUT,
  run,
  writeJson,
} from "./lib.ts";
import { buildNightmareScenarios } from "./nightmare/scenarios.ts";
import { ARMS, type Arm, buildScenarios, type Check, isArm, type Scenario, WRITE_FROM, writeCandidates } from "./scenarios.ts";

/** Arms a run uses when --arms is not given; `atl-pre` is opt-in so existing invocations keep their cost. */
const DEFAULT_ARMS: readonly Arm[] = ["atl", "mcp"];
/** Skill text file for the `atl-pre` arm, passed to omp with --append-system-prompt. */
const PRELOAD_FILE = "skill-preload.md";
const RUNS = join(OUT, "runs");
const MAX_TIME = "10m";
const SESSION_DIR = "/tmp/atl-eval/sessions";
/** Reps at or above this number are the session-persisting variant (artifact:// readable). */
export const SESSION_REP = 10;
/** Run-dir tag of the nightmare set (runs/<arm>-nm[-tag]/), which keeps those runs out of the s1-s8 report. */
const NIGHTMARE_TAG = "nm";
const PROBE_PROMPT =
  "List the exact names of every tool available to you whose name mentions atlassian, jira, confluence or rovo, one per line. If there are none, reply with the single word none. Do not call any tool.";

export interface ToolCallRecord {
  id: string;
  name: string;
  command?: string;
  args?: string;
  isError: boolean;
  resultChars: number;
  resultTokens: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface RunMetrics {
  arm: Arm;
  scenario: string;
  rep: number;
  model: string;
  target?: string;
  prompt: string;
  startedAt: string;
  wallMs: number;
  exitCode: number;
  stderrLines: string[];
  success: boolean;
  /** Set by `rejudge` when a corrected answer check changed the verdict. */
  rejudged?: true;
  /** Persisted-session variant: oversized tool results spilled to artifact:// can be re-read. */
  sessions?: true;
  /** Round label (`--tag`); files live in runs/<arm>-<tag>/. */
  tag?: string;
  checkDetails: string[];
  finalText: string;
  stopReason: string;
  turns: number;
  toolCalls: ToolCallRecord[];
  toolCallCount: number;
  usage: UsageTotals;
  finalContext: number;
  peakContext: number;
  resultChars: number;
  resultTokens: number;
}

function armDir(arm: Arm): string {
  return join(ARMS_DIR, arm);
}

function setupArms(): void {
  const skill = readFileSync(join(import.meta.dir, "..", "skills", "atl", "SKILL.md"), "utf8");
  const atlMcp = `${JSON.stringify({ mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v2/mcp", enabled: false } } })}\n`;
  const atlDir = armDir("atl");
  mkdirSync(join(atlDir, ".omp", "skills", "atl"), { recursive: true });
  writeFileSync(join(atlDir, ".omp", "mcp.json"), atlMcp);
  writeFileSync(join(atlDir, ".omp", "skills", "atl", "SKILL.md"), skill);
  // atl-pre: same tool surface, but no skills dir, so the skill can only come from the system prompt.
  const preDir = armDir("atl-pre");
  mkdirSync(join(preDir, ".omp"), { recursive: true });
  writeFileSync(join(preDir, ".omp", "mcp.json"), atlMcp);
  writeFileSync(join(preDir, PRELOAD_FILE), skill);
  const mcpDir = armDir("mcp");
  mkdirSync(join(mcpDir, ".omp"), { recursive: true });
  writeFileSync(
    join(mcpDir, ".omp", "mcp.json"),
    `${JSON.stringify({ mcpServers: { atlassian: { type: "http", url: MCP_URL, headers: { Authorization: "Bearer ${ATL_EVAL_BEARER}" } } } })}\n`,
  );
}

async function armEnv(arm: Arm): Promise<Record<string, string | undefined>> {
  const base = { ...process.env };
  delete base.ATL_EVAL_BEARER;
  const path = (base.PATH ?? "").split(":").filter((entry) => entry !== ATL_BIN_DIR);
  if (arm !== "mcp") {
    return { ...base, PATH: [ATL_BIN_DIR, ...path].join(":") };
  }
  return { ...base, PATH: path.join(":"), ATL_EVAL_BEARER: await bearer() };
}

/**
 * Run one omp session; returns raw stdout/stderr and wall time. `sessions` persists the session
 * (under /tmp) so spilled oversized tool results stay readable as artifact:// files; the default
 * `--no-session` run cannot re-read them.
 */
async function ompRun(arm: Arm, prompt: string, sessions = false) {
  const persistence = sessions ? ["--session-dir", SESSION_DIR] : ["--no-session"];
  const preload = arm === "atl-pre" ? ["--append-system-prompt", join(armDir(arm), PRELOAD_FILE)] : [];
  return run(
    ["omp", "-p", "--mode", "json", ...persistence, ...preload, "--no-title", "--max-time", MAX_TIME, prompt],
    { cwd: armDir(arm), env: await armEnv(arm), timeoutMs: 11 * 60_000 },
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Fold the omp JSONL stream into per-run metrics (everything except success). */
export async function parseTranscript(jsonl: string) {
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  const calls = new Map<string, ToolCallRecord>();
  const order: string[] = [];
  let turns = 0;
  let finalContext = 0;
  let peakContext = 0;
  let finalText = "";
  let stopReason = "";
  let model = "";
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) {
      continue;
    }
    const message = event.message;
    if (message.role === "assistant") {
      turns += 1;
      model = typeof message.model === "string" ? message.model : model;
      stopReason = typeof message.stopReason === "string" ? message.stopReason : stopReason;
      const u = isRecord(message.usage) ? message.usage : {};
      usage.input += num(u.input);
      usage.output += num(u.output);
      usage.cacheRead += num(u.cacheRead);
      usage.cacheWrite += num(u.cacheWrite);
      usage.total += num(u.totalTokens);
      usage.cost += isRecord(u.cost) ? num(u.cost.total) : 0;
      finalContext = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
      peakContext = Math.max(peakContext, finalContext);
      finalText = textOf(message.content);
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
            const args = isRecord(block.arguments) ? block.arguments : {};
            const record: ToolCallRecord = {
              id: block.id,
              name: typeof block.name === "string" ? block.name : "?",
              isError: false,
              resultChars: 0,
              resultTokens: 0,
              ...(typeof args.command === "string" ? { command: args.command } : { args: JSON.stringify(args).slice(0, 600) }),
            };
            calls.set(block.id, record);
            order.push(block.id);
          }
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const record = calls.get(message.toolCallId);
      const text = textOf(message.content);
      if (record !== undefined) {
        record.isError = message.isError === true;
        record.resultChars = text.length;
        record.resultTokens = await claudeTokens(text);
      }
    }
  }
  const toolCalls = order.flatMap((id) => calls.get(id) ?? []);
  return {
    model,
    stopReason,
    turns,
    usage,
    finalContext,
    peakContext,
    finalText,
    toolCalls,
    resultChars: toolCalls.reduce((sum, call) => sum + call.resultChars, 0),
    resultTokens: toolCalls.reduce((sum, call) => sum + call.resultTokens, 0),
  };
}

/** Every issue any recorded run (any arm, round or variant) already used as a write target. */
function usedTargets(): Set<string> {
  const used = new Set<string>();
  for (const entry of readdirSync(RUNS, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const dir = join(RUNS, entry.name);
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".metrics.json"))) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isRecord(parsed) && typeof parsed.target === "string") {
        used.add(parsed.target);
      }
    }
  }
  return used;
}

/** First seeded issue that is still in Teendő on the live site and not used by a previous run. */
async function pickTarget(): Promise<string> {
  const used = usedTargets();
  for (const key of writeCandidates(loadManifest())) {
    if (used.has(key)) {
      continue;
    }
    const issue = await atl("issue", "get", key, "--fields", "key,status");
    const parsed: unknown = JSON.parse(issue.stdout);
    if (isRecord(parsed) && parsed.status === WRITE_FROM) {
      return key;
    }
  }
  throw new Error("no unused issue in status Teendő left in the manifest");
}

async function runOne(
  scenario: Scenario,
  arm: Arm,
  rep: number,
  sessions: boolean,
  tag: string | undefined,
): Promise<RunMetrics> {
  const dir = join(RUNS, tag === undefined ? arm : `${arm}-${tag}`);
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, `${scenario.id}-${rep}`);
  if (scenario.write) {
    await scenario.prepare?.();
  }
  const target = scenario.write ? (scenario.pickTarget?.() ?? (await pickTarget())) : undefined;
  const prompt = scenario.prompt(arm, target);
  const startedAt = new Date().toISOString();
  const result = await ompRun(arm, prompt, sessions);
  writeFileSync(`${stem}.jsonl`, result.stdout);
  writeFileSync(`${stem}.stderr.txt`, result.stderr);
  const parsed = await parseTranscript(result.stdout);
  let check: Check = { success: false, details: ["no final answer"] };
  if (parsed.finalText !== "" || scenario.write) {
    check = await scenario.check(parsed.finalText, arm, target);
  }
  const metrics: RunMetrics = {
    arm,
    scenario: scenario.id,
    rep,
    model: parsed.model,
    ...(target === undefined ? {} : { target }),
    prompt,
    ...(sessions ? { sessions: true as const } : {}),
    ...(tag === undefined ? {} : { tag }),
    startedAt,
    wallMs: result.ms,
    exitCode: result.code,
    stderrLines: result.stderr.split("\n").filter((line) => line.trim() !== "").slice(0, 20),
    success: check.success,
    checkDetails: check.details,
    finalText: parsed.finalText,
    stopReason: parsed.stopReason,
    turns: parsed.turns,
    toolCalls: parsed.toolCalls,
    toolCallCount: parsed.toolCalls.length,
    usage: parsed.usage,
    finalContext: parsed.finalContext,
    peakContext: parsed.peakContext,
    resultChars: parsed.resultChars,
    resultTokens: parsed.resultTokens,
  };
  writeJson(`${stem}.metrics.json`, metrics);
  log(
    `${arm} ${scenario.id} rep${rep}: ${check.success ? "PASS" : "FAIL"} ${Math.round(result.ms / 1000)}s turns=${metrics.turns} calls=${metrics.toolCallCount} resultTok=${metrics.resultTokens} ctx=${metrics.finalContext} cost=${metrics.usage.cost.toFixed(3)}`,
  );
  return metrics;
}

/**
 * Re-apply the current answer checks to saved final texts in every runs/ dir. Write scenarios re-read the live site
 * for their saved target (markers persist, so this is the same read-back), except scenarios with `prepare`: they share
 * one target that every live run resets, so a later read-back would credit an old run with a newer run's transition.
 */
async function rejudge(): Promise<void> {
  const scenarios = [...buildScenarios(loadManifest()), ...buildNightmareScenarios()];
  for (const entry of readdirSync(RUNS, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const dir = join(RUNS, entry.name);
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".metrics.json"))) {
      const path = join(dir, name);
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !isRecord(saved) ||
        typeof saved.scenario !== "string" ||
        typeof saved.finalText !== "string" ||
        !isArm(saved.arm)
      ) {
        continue;
      }
      const scenario = scenarios.find((item) => item.id === saved.scenario);
      if (scenario === undefined || scenario.prepare !== undefined || (!scenario.write && saved.finalText === "")) {
        continue;
      }
      const target = typeof saved.target === "string" ? saved.target : undefined;
      const check = await scenario.check(saved.finalText, saved.arm, target);
      if (check.success !== saved.success) {
        log(`rejudge ${entry.name}/${name}: ${String(saved.success)} -> ${check.success}`);
        writeJson(path, { ...saved, success: check.success, checkDetails: check.details, rejudged: true });
      }
    }
  }
}

async function probe(): Promise<void> {
  mkdirSync(RUNS, { recursive: true });
  for (const arm of ARMS) {
    const result = await ompRun(arm, PROBE_PROMPT);
    const parsed = await parseTranscript(result.stdout);
    const record = {
      arm,
      answer: parsed.finalText,
      stderr: result.stderr.split("\n").filter((line) => line.trim() !== ""),
      toolCalls: parsed.toolCalls.length,
      connectFailed: /failed to connect/i.test(result.stderr),
    };
    writeJson(join(RUNS, `probe-${arm}.json`), record);
    log(`${arm}: connectFailed=${record.connectFailed} answer=${parsed.finalText.replaceAll("\n", " | ").slice(0, 400)}`);
  }
}

function flag(name: string): string | undefined {
  const at = Bun.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : Bun.argv[at + 1];
}

/** `macro` (default) is s1-s8 on the seeded data; `nightmare` is n01-n15 on the corporate-nightmare data. */
function scenarioSet(name: string | undefined): Scenario[] {
  if (name === undefined || name === "macro") {
    return buildScenarios(loadManifest());
  }
  if (name === "nightmare") {
    return buildNightmareScenarios();
  }
  throw new Error(`unknown --set ${name}: use macro or nightmare`);
}

async function main(): Promise<void> {
  if (Bun.argv[2] === "list") {
    for (const scenario of scenarioSet(flag("set"))) {
      process.stdout.write(`${scenario.id}\t${scenario.write ? "write" : "read"}\t${scenario.name}\n`);
    }
    return;
  }
  setupArms();
  if (Bun.argv[2] === "rejudge") {
    await rejudge();
    return;
  }
  if (Bun.argv[2] === "probe") {
    await probe();
    return;
  }
  if (Bun.argv[2] !== "run") {
    throw new Error(
      "usage: bun eval/run.ts probe | rejudge | list [--set macro|nightmare] | run [--set macro|nightmare] [--rep N] [--arms atl,atl-pre,mcp] [--scenarios id,id] [--tag label] [--sessions]",
    );
  }
  const sessions = Bun.argv.includes("--sessions");
  const rep = Number(flag("rep") ?? (sessions ? "11" : "1"));
  if (sessions !== rep >= SESSION_REP) {
    throw new Error(`--sessions runs must use --rep >= ${SESSION_REP}, and only those`);
  }
  const set = flag("set");
  const given = flag("tag");
  // Nightmare runs always carry a tag, so report.ts (untagged runs = the s1-s8 totals) never mixes them in.
  const tag = set === "nightmare" ? (given === undefined ? NIGHTMARE_TAG : `${NIGHTMARE_TAG}-${given}`) : given;
  const arms = (flag("arms") ?? DEFAULT_ARMS.join(",")).split(",").flatMap((name) => ARMS.filter((arm) => arm === name));
  const wanted = flag("scenarios")?.split(",");
  const available = scenarioSet(set);
  const unknown = wanted?.filter((id) => !available.some((scenario) => scenario.id === id)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`unknown scenario ids for set ${set ?? "macro"}: ${unknown.join(", ")}`);
  }
  const scenarios = available.filter((scenario) => wanted === undefined || wanted.includes(scenario.id));
  for (const scenario of scenarios) {
    for (const arm of arms) {
      if (existsSync(join(RUNS, tag === undefined ? arm : `${arm}-${tag}`, `${scenario.id}-${rep}.metrics.json`))) {
        log(`skip ${arm} ${scenario.id} rep${rep}: already recorded`);
        continue;
      }
      await runOne(scenario, arm, rep, sessions, tag);
    }
  }
}

if (import.meta.main) {
  await main();
}
