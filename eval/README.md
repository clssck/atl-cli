# eval

Token and agent-friendliness eval of `atl` against the Atlassian Remote MCP (v1), on seeded data on the trial site. Outputs go to the gitignored `eval/.out/`.

| file | role |
|---|---|
| `seed.ts` | seeds Jira project KAN and Confluence space SZOFTVERFE, writes `.out/manifest.json` (ground truth) |
| `lib.ts` | shared plumbing: binary path, subprocess runner, `omp toks` counts, MCP session, manifest loader |
| `micro.ts` | one call each: 15 atl command / MCP tool pairs; bytes, Claude tokens, info-parity check |
| `scenarios.ts` | eight natural-language scenarios with answer checks from the manifest |
| `run.ts` | macro eval: headless `omp -p` agents per arm and scenario; metrics per run |
| `report.ts` | builds `.out/report.md` from `micro.json` and the run metrics |

## Prerequisites

- `atl` logged in (`atl auth status`); `omp` on PATH. Run `atl auth refresh` before a batch (the MCP arm borrows atl's token; scripts refresh it when under 15 minutes remain). The token only travels via the child env var `ATL_EVAL_BEARER` and is never printed or stored.
- The binary under test, built from the current tree:

```bash
bun build src/main.ts --compile --minify --bytecode --outfile /tmp/atl-eval/bin/atl
```

## Seed

```bash
bun eval/seed.ts            # creates ~176 issues and ~46 pages; refuses to run twice without --force
```

The seed is not idempotent (the token cannot delete), so run it once per site. The manifest lists the needles (known answers) the scenarios check.

## Micro eval

```bash
bun eval/micro.ts
```

Writes `.out/micro.json`, `.out/micro.md` and the raw output of every call in `.out/micro/<pair>.{atl,mcp,mcpcall}.txt`. "MCP" is the raw text the server returns (what a host feeds the model); `mcpcall` is what `atl mcp call` prints for the same call. Pairs marked `-fields` give the MCP call an explicit `fields` projection, the fair comparison for an agent that already knows the tool.

## Macro eval

```bash
bun eval/run.ts probe                       # each arm lists the Atlassian tools it sees
bun eval/run.ts run --rep 1                 # all scenarios, both arms, sequential
bun eval/run.ts run --rep 1 --arms atl --tag r2   # round 2: files go to runs/atl-r2/ (rebuild the binary first)
bun eval/run.ts run --rep 2 --scenarios s3-rollback-window --arms atl
bun eval/run.ts run --rep 11 --sessions --scenarios s4-handbook-retention,s6-epic-children
bun eval/run.ts rejudge                     # re-apply the current answer checks to saved final texts
```

Arms live in `/tmp/atl-eval/arms/<arm>`:

- `atl`: the repo's `skills/atl/SKILL.md` as a project skill, `atl` on PATH, the Atlassian MCP server disabled.
- `mcp`: the MCP v1 server configured with the bearer, no `atl` on PATH.

Each run writes `.out/runs/<arm>/<scenario>-<rep>.{jsonl,stderr.txt,metrics.json}`. Existing metrics files are skipped, so an interrupted batch resumes. The write scenario (s8) picks an unused issue still in status Teendő per run, comments `atl smoke eval: budget confirmed (<arm>)`, moves it to Ellenőrzés alatt, and the check reads the issue back with atl. It changes the site; used targets are recorded in the metrics files.

Runs use `--no-session`, which makes oversized tool results spilled to `artifact://` unreadable to the agent (this penalizes the MCP arm on large pages and lists). Reps >= 11 with `--sessions` keep the omp session under `/tmp/atl-eval/sessions` as a control; `report.ts` keeps them out of the totals.

Metrics per run: success (answer checks), wall time, assistant turns, tool calls (bash command lines for atl; omp exposes MCP tools as `write xd://mcp__atlassian_<tool>`), summed usage and cost, final-turn context (input + cacheRead + cacheWrite), tool-result characters and Claude tokens.

## Report

```bash
bun eval/report.ts          # writes .out/report.md; appends hand-written .out/friction.md if present
```

Check before committing eval changes: `bunx tsc --noEmit` and `bunx oxlint -c .oxlintrc.json --type-aware --deny-warnings eval`.
