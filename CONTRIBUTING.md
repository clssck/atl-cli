# Contributing to atl

Thanks for your interest in improving atl, the JSON CLI for Jira and Confluence. This guide covers the local workflow and the checks every change must pass.

## Prerequisites

- [Bun](https://bun.sh) >= 1.4.4: package manager, source runtime, and test runner
- Git

atl has no runtime dependencies and every change keeps it that way.

## Setup

```text
git clone https://github.com/clssck/atl-cli
cd atl-cli
bun install --frozen-lockfile
```

## Project layout

- `src/`: the CLI. `src/main.ts` is the entry; `src/commands/` holds commands, `src/core/` the shared HTTP, output and error plumbing, `src/auth/` OAuth, `src/adf/` the markdown/ADF conversion, `src/resolve/` identifier resolution, `src/mcp/` the MCP parity client
- `test/`: unit tests mirroring `src/`, run with `bun test`
- `skills/atl/SKILL.md`: the agent skill, kept compact on purpose (see below)
- `mcp/`: MCP tool snapshots and the coverage map enforced by `test/parity.test.ts`
- `eval/`: maintainers' benchmark against a private trial site. Contributors are not expected to run it
- `docs/design.md`: design notes and rationale; `AGENTS.md`: repository flow, conventions and the MCP upgrade procedure

## Everyday commands

| Task                    | Command                                                        |
| ----------------------- | -------------------------------------------------------------- |
| Run from source         | `bun src/main.ts --help`                                       |
| Everything CI checks    | `bun run check`                                                |
| Format                  | `bun run fmt` (verify with `bun run fmt:check`)                |
| Lint                    | `bun run lint` (autofix with `bun run lint:fix`)               |
| Type-check              | `bun run typecheck`                                            |
| Plugin version and changelog checks | `bun run verify`                                   |
| Test                    | `bun test`; `bun test PATH` for one file                       |
| Build                   | `bun run build` (`dist/atl.js`)                                |
| Native binary           | `bun run compile` (also `compile:linux`, `compile:windows`)    |
| Packaged platform smoke | `bun run test:platform` (pack, install into a temp dir, smoke) |

## Checks your change must pass

`bun run check` runs all of these in order; it must be green before you open a pull request, and CI must be green before merge:

1. `bun run typecheck`: TypeScript reports no errors
2. `bun run lint`: type-aware oxlint with warnings denied
3. `bun run fmt:check`: oxfmt formatting is applied
4. `bun run verify`: `plugin.json` version and the changelog are consistent
5. `bun test`: the unit suite passes

CI additionally builds and runs `bun run test:platform` against the packed artifact.

## Conventions

- Correctness first, then maintainability, then performance.
- No runtime dependencies.
- TypeScript without `any`, `ReturnType`/`Parameters`, or non-null `!`.
- No emojis in code or repository prose.
- One implementation per concept. Replace and migrate callers in the same change; do not leave deprecated aliases or compatibility shims behind.
- Tests defend observable CLI behaviour: exit codes, JSON on stdout, diagnostics on stderr. Do not test source text or wiring.
- New behaviour ships with a test.

## The output contract

stdout is exactly one JSON value; stderr carries JSONL diagnostics; exit codes are fixed. See "Output contract" in the [README](README.md). Treat it as a compatibility boundary: do not change command names, flags, exit codes, or output shapes without a deliberate reason, and document the change in the changelog.

## The agent skill

`skills/atl/SKILL.md` is token-budgeted: keep it compact and add only what agents cannot get cheaply from `atl <command> --help`. If your change touches it, state the token change in the pull request.

## Changelog

Add flat bullets under `## [Unreleased]` in `CHANGELOG.md` for every user-visible change. The release process cuts that section into the new version.

## Commit messages

Commit subjects are `type: summary`, imperative, one coherent concern per commit. Use types such as `feat`, `fix`, `eval`, `docs`, `test`, `refactor`, and `chore`.

## Releases

Maintainers dispatch the Release workflow ([.github/workflows/release.yml](.github/workflows/release.yml)) from `main` with a patch, minor, or major bump. See "Install" in the [README](README.md) for what it does.

## Pull requests

- Changes go through pull requests to `main`; there are no direct pushes.
- CI must be green before merge.
- One concern per pull request.
- Update `CHANGELOG.md` under `[Unreleased]`, and the README and skill when behaviour changes.
- Fill out the pull request template.
- Pull requests are merged by squash or rebase to keep history linear.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md). Never paste tokens, `credentials.json`, or tenant data into issues or pull requests.

## License

atl is released under the [MIT license](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.
