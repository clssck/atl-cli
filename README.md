# atl

JSON CLI for Confluence, Jira, Compass and Teamwork Graph on Atlassian Cloud, built for agents. Calls REST and GraphQL on `api.atlassian.com` directly, authenticated with the same OAuth flow the Atlassian Remote MCP (v1, `https://mcp.atlassian.com/v1/mcp/authv2`) uses. No runtime dependencies. Design notes and rationale: [docs/design.md](docs/design.md).

Status: covers every tool of the Atlassian MCP v1 server (`mcp/tools-v1.json`, 41 tools; `test/parity.test.ts` enforces the mapping) without calling the MCP server, and adds comment editing. `atl mcp tools | call` remain as parity tooling and an explicit escape hatch; no other command uses them.

Gaps against the MCP, from what a third-party OAuth token can reach:

- `search` combines Confluence CQL `text ~` and Jira JQL `text ~`. The GraphQL `search` root rejects 3LO tokens (`OAuthNoSiteInQuery`), so Rovo semantic ranking and third-party sources are unavailable.
- `graph add` supports Jira issue links (`links`, `blocks`) and remote links. Atlas relationships (`tracks-atlassian-project`, `contributes-to-atlassian-goal`) need `write:project:projects` / `write:goal:goals`, which the MCP's scopes do not include; the command fails with `missing_scope`.
- `graph context` traverses relationships with Cypher (`graphStore_cypherQueryV2Batch`) per relationship type from a built-in catalog; `node(id)` is not exposed to OAuth clients.

## Run

```bash
bun install
bun src/main.ts --help
bun src/main.ts auth login      # opens the browser; approve, then return
bun src/main.ts doctor
bun run build                   # dist/atl: single binary (--compile --minify --bytecode)
bun run build:linux             # dist/atl-linux
bun run build:windows           # dist/atl.exe
```

## Auth

`atl auth login` registers its own OAuth client (RFC 7591 DCR, `client_name: atl`), runs PKCE S256 with a loopback redirect `http://localhost:47923/callback` (`--port` to change), and stores its own tokens. It never touches omp's MCP credential: Atlassian rotates refresh tokens, so sharing one would log the other client out.

The authorize request replicates omp's MCP flow: scopes from the protected-resource metadata, `resource=<MCP resource>` on authorize/exchange/refresh, `prompt=consent`, no `audience`.

- Credentials: `<configDir>/credentials.json` (mode 0600). Refresh runs under a cross-process lock (`refresh.lock`) and re-reads the store before rotating.
- Headless: `ATL_ACCESS_TOKEN` env (never refreshed), or `atl auth login --with-token < token.txt`.
- `atl auth status | refresh | logout [--revoke]`.

## Sites

The cloudId is never asked for. Site precedence: site in the target URL > `--site` > `ATL_SITE` > `atl sites --default <host>` > the only accessible site. `atl sites` refreshes the cache from `accessible-resources`.

## Commands

```
doctor | sites | whoami | api <METHOD> <path> | get <url|ari|key> | formats
auth login | status | refresh | logout
page get | tree | children | versions | labels | create | update
space list | pages
comment list | get | replies | versions | add | update
cql "<query>"
issue get | transitions | links | link-types | comments | create | edit | comment | move | log | link
jql "<query>"
project list | types | fields
user find "<name>"
search "<text>" [--product confluence|jira] [--type page|issue|...]
graph context | object | add               (Teamwork Graph)
compass components | component | fields | field-create | create | relate
mcp tools | call <tool>                     (MCP parity tooling, escape hatch)
commands run [--fields NAME,...] [--contains TEXT]
agent contract
```

`atl commands run --contains <mcpToolName>` finds the command that replaces an MCP tool (each command lists its `mcpTools`).

### Agent skill

`skills/atl/SKILL.md` teaches agents when and how to use `atl` (task → command map, `--output` for large pages, inline bodies, error handling). Install for omp by linking it into a skills root, e.g. `ln -s "$PWD/skills/atl" ~/.omp/agent/skills/atl`, with the `atl` binary on `PATH`.

### Writes

- Bodies come from exactly one of `--body <text>` (inline, for short text), `--file <path>` or `--file -` (stdin). Both together is `body_conflict`; commands that need a body (`page create`, `comment add`, `issue comment`) fail with `body_required` when neither is given. Markdown is the default and is converted locally to ADF; `--body-format adf` takes ADF JSON, `storage` is Confluence only. A `--file` path infers `adf` for `.json` and `storage` for `.html`/`.xhtml`/`.xml`; inline and stdin bodies default to markdown.
- `issue link`, `issue log` and `issue move` attach a comment the same way: `--comment <text>` or `--comment-file <path|->`, mutually exclusive.
- `--plan` (alias `--dry-run`) prints the exact request (method, URL, body digest and preview) and sends nothing. `next` holds the argv that applies it.
- Named write commands send once and never retry. `page update` and `comment update` read the current version and send version+1. A 409 conflict exits 3 with a re-read hint.
- `atl api` and `atl mcp call` require `--yes` for anything that is not a read.
- The token has no delete scopes, so delete in the UI.

`atl <command> --help` prints usage, flags and examples; `atl commands run --fields page.get` returns the same as JSON with a flag schema.

Identifiers: page ids, page/blog URLs, tiny links (`/wiki/x/...`), `focusedCommentId` URLs, ARIs, issue keys and issue URLs.

## Output contract

- stdout: exactly one JSON value (compact; `--pretty` or `ATL_PRETTY=1` indents). A result over 700 bytes is broken across lines (one list item or object property per line, no indentation) because agent harnesses cut long stdout lines; `jq .` and any JSON parser read it unchanged. `--help`/`--version` are the only text outputs.
- stderr: JSONL diagnostics, e.g. `{"type":"error","code","category","exitCode","message","hint","next"}`. Never contains tokens.
- Reads are compact by default; `--full` returns raw API objects; `--fields a,b.c` projects (per item for lists); `--output PATH` writes a result's `body` (or `description`) to the file as the original markdown (never the wrapped display lines) and prints the rest of the result with `{path, bytes, lines}` in its place (results without that text are written as JSON and print `{path, bytes}`).
- Lists return `{items, nextCursor}`; `--limit N`, `--all` (hard cap 1000), `--cursor`.
- Bodies render ADF to markdown locally (`--format md`, default) and print as an array of lines, so no stdout line exceeds about 700 bytes: the markdown split on `\n`, a prose line over 600 JSON bytes soft-wrapped at spaces (a markdown soft break, same rendering); fenced code, table rows and headings are never wrapped (an over-long one is hard-split between code points, unmarked). `--format adf` returns raw ADF, pages also accept `storage`; both are unchanged.
- `api`: GET/HEAD send directly; other methods need `--yes`, and `--plan` prints the request without sending it. Only `api.atlassian.com` receives the bearer token.

Exit codes: `0` ok, `1` input/config/auth, `2` API/internal, `3` transient (429/5xx/timeout/409), `4` failed assertion.

## Environment

| variable | effect |
|---|---|
| `ATL_CONFIG_DIR` | config directory (default `%APPDATA%\atl` on Windows, else `$XDG_CONFIG_HOME/atl` or `~/.config/atl`) |
| `ATL_SITE` | default site host |
| `ATL_ACCESS_TOKEN` | bearer token override |
| `ATL_TIMEOUT_MS` | HTTP timeout (default 30000) |
| `ATL_PRETTY` | `1` indents JSON |
| `ATL_MCP_URL` | MCP endpoint for passthrough commands (default `https://mcp.atlassian.com/v1/mcp/authv2`) |

## Develop

```bash
bun install --frozen-lockfile
bun run check    # tsc, type-aware oxlint (warnings denied), oxfmt --check, bun test
bun run fmt
```

Repository flow, conventions and the MCP upgrade procedure are in [AGENTS.md](AGENTS.md).

- CI (`.github/workflows/ci.yml`) runs `bun run check` on pushes to main and on pull requests.
- `.github/workflows/mcp-watch.yml` runs daily. It compares the public MCP signals with `mcp/upstream.json`: upstream `server.json`/`plugin.json`, the MCP registry, protected-resource scopes, and a probe for a new `/vN/mcp` endpoint. When they differ it opens an `mcp-upstream` issue.
- `bun scripts/mcp-watch.ts` runs the same check locally.
- `bun src/main.ts mcp tools --snapshot --output mcp/tools-v1.json` refreshes the tool snapshot. This needs a login.

`.omp/mcp.json` points omp at the v1 `authv2` MCP endpoint for this project (overrides the user-level `atlassian` server); authorize it with `/mcp reauth atlassian`.
