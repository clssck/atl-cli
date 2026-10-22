# atl

JSON CLI for Jira and Confluence on Atlassian Cloud (plus Teamwork Graph and Compass), built for agents. Calls REST and GraphQL on `api.atlassian.com` directly, authenticated with the same OAuth flow the Atlassian Remote MCP (v1, `https://mcp.atlassian.com/v1/mcp/authv2`) uses. No runtime dependencies. Design notes and rationale: [docs/design.md](docs/design.md).

Status: covers every tool of the Atlassian MCP v1 server and the directly reachable part of v2 without calling the MCP server (see [Coverage and gaps](#coverage-and-gaps)). `atl mcp tools | call` remain as parity tooling and an explicit escape hatch; no other command uses them.

## Coverage and gaps

- **MCP v1:** every tool in `mcp/tools-v1.json` (41 tools) maps to a command; `test/parity.test.ts` enforces it.
- **MCP v2:** covered directly only, on REST/GraphQL with atl's own token, for Jira, Confluence, Teamwork Graph and system tools (`mcp/tools-v2.json`, `mcp/operations-v2.json`). Every other in-scope v2 operation is a documented gap in `mcp/gaps-v2.json` with a reason class:
  - `scope-not-grantable`: the DCR client only gets the MCP resource's classic scopes; v2 `*:agent-interface` scopes return 401 on REST/GraphQL.
  - `no-public-api`: approvals, reactions, public links, Rovo/AI features, export.
  - `mcp-internal`: discover/execute* tools.
  - Out-of-scope products are listed in `outOfScopeProducts` (assets, jsm, bitbucket, loom, goals, teams, ...).
- `atl mcp tools | call` stay the escape hatch for anything above.
- `search` is CQL `text ~` plus JQL `text ~`, not Rovo search: the GraphQL `search` root rejects 3LO tokens (`OAuthNoSiteInQuery`), so semantic ranking and third-party sources are unavailable.
- Comala Workflows is a Forge app without a public Cloud API; only `page properties`, labels and storage reads (`page get --format storage`) are possible.
- `graph add` supports Jira issue links (`links`, `blocks`) and remote links. Atlas relationships need `write:project:projects` / `write:goal:goals`, outside the MCP's scopes (`missing_scope`). `graph context` uses Cypher per relationship type; `node(id)` is not exposed to OAuth clients.
- Token limits: Confluence has no delete scope (pages, comments and attachments are deleted in the UI); Confluence attachment downloads are 401 (`attachment list | get` are metadata via CQL); page restriction writes (`page restrict`, `page permissions ...`) may be refused by the site's plan; board column config and the sprint list are not exposed to OAuth clients (`board sprints` reads the Sprint field of the board's issues); `board list` only shows boards you opened recently.

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

issue get | transitions | links [--chain "<relation>" [--max N]] | tree [--depth N] [--group-by <field>] | link-types | comments | changelog | worklogs | editmeta | watchers | permissions
issue attachments | attachment add | attachment download [--force] | attachment delete
issue create | edit | comment | move | log | link | remote-link add | convert | watch | unwatch | notify
issue delete | comment-delete | remote-link delete   (need --yes)
jql "<query>|<issues URL>" [--group-by <field>] | jql-check <query...> | jql-suggest
bulk edit | transition | move | delete | status   (async bulk tasks; delete needs --yes)
board list | get | issues | sprints
project list | types | fields
status | component | priority | resolution | field | filter | dashboard | property
version list | get | related-work list | related-work set
user find "<name>" | get <accountId...>

page get [--version N] [--format md|adf|storage|view] [--grep <regex> [--context N]] | diff | ancestors | tree [--depth 1-5] | children | versions | labels
page operations | properties | property set | restriction | permissions list
page create | update [--force] | move | copy | restore --version N
page restrict | property delete | permissions add | remove | set    (restrict/property delete/remove/set need --yes)
space list | get | personal | pages
attachment list | get                          (Confluence metadata)
comment list [--kind footer|inline|all] [--replies] | get [--version N] | replies | versions | add | update   (--kind footer|inline)
cql "<query>"

search "<text>" [--product confluence|jira] [--type page|issue|...]
graph context | object | add | cypher       (Teamwork Graph)
compass components | component | fields | field-create | create | relate
mcp tools [--names | --snapshot | --catalog] | call <tool>   (MCP parity tooling, escape hatch)
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
- Named write commands send once and never retry. `page update` and `comment update` read the current version and send version+1. A 409 conflict exits 3 with a re-read hint. A write that times out or loses its connection exits 3 with `write_outcome_unknown`: the request may have been applied, so read the target back before retrying.
- `atl api` and `atl mcp call` require `--yes` for anything that is not a read. Destructive commands (`issue delete`, `issue comment-delete`, `issue attachment delete`, `issue remote-link delete`, `bulk delete`, `page restrict`, `page property delete`, `page permissions remove | set`) also require `--yes`; `issue convert` needs it when the issue has children. `--plan` works without it.
- `page update` always reads the current body as ADF; a markdown body that would drop inline-comment anchors fails with `inline_comment_anchors_dropped` (`--plan` lists them as `droppedInlineComments`) unless `--force`. `issue attachment download` never overwrites (`file_exists`) without `--force`.
- A command that declares its own `--version` flag (`page get`, `page restore`) owns it; `-V` always prints the CLI version.

`atl <command> --help` prints usage, flags and examples; `atl commands run --fields page.get` returns the same as JSON with a flag schema.

Identifiers: page ids, page/blog URLs, tiny links (`/wiki/x/...`), `/display/SPACE/Title` links (exact title), `viewpage.action?pageId=` and `draftId=` links, `pageVersion=` (`--version` wins), `focusedCommentId` URLs, ARIs, issue keys and issue URLs; a bare id is probed as page then blog post unless `--type` is given. Wrappers (`<url>`, `[x](url)`, `[KAN-1]`, a trailing `:`) are stripped. An ARI of another site is `site_not_accessible`. `jql` also takes a Jira issues URL.

## Output contract

- stdout: exactly one JSON value (compact; `--pretty` or `ATL_PRETTY=1` indents). A result over 700 bytes is broken across lines (one list item or object property per line, no indentation) because agent harnesses cut long stdout lines; a line exceeds that only for a single unsplittable string. `jq .` and any JSON parser read it unchanged. Invisible and bidi characters (zero-width, NBSP, control, tag characters) are escaped as `\uXXXX`. `--help`/`--version` are the only text outputs.
- stderr: JSONL diagnostics, e.g. `{"type":"error","code","category","exitCode","message","hint","next"}`; warnings and hints use `type: "warning" | "hint"`. A warning means the result may be incomplete or suspect: `jql_invalid` (empty JQL result, Jira reported errors in the query), `search_incomplete` (a Confluence page came back short twice), `fields_unmatched` (no `--fields` path matched), `inline_comment_anchors_dropped`. Hints: `child_issues_of_empty` (use `issue tree`), `replies_truncated`, `tree_depth_unchecked`, `empty_search`. Never contains tokens.
- Reads are compact by default; `--full` returns raw API objects; `--fields a,b.c` projects (per item for lists: use `key`, not `items.key`, though the `items.` prefix is accepted; a numeric segment indexes an array and keys the result by index; a list item no path matches stays `{}` so counts hold; no match at all warns `fields_unmatched`); `--output PATH` writes a result's `body` (or `description`) to the file as the original markdown (never the wrapped display lines) and prints the rest of the result with `{path, bytes, lines}` in its place (results without that text are written as JSON and print `{path, bytes}`).
- Lists return `{items, nextCursor}`; `--limit N`, `--all` (hard cap 1000), `--cursor` (a malformed cursor is `invalid_cursor` on every list).
- Bodies render ADF to markdown locally (`--format md`, default) and print as an array of lines, so no stdout line exceeds about 700 bytes: the markdown split on `\n`, a prose line over 600 JSON bytes soft-wrapped at spaces (a markdown soft break, same rendering); fenced code, table rows and headings are never wrapped (an over-long one is hard-split between code points, unmarked). `--format adf` returns raw ADF, pages also accept `storage`; ADF is unchanged and the storage `body` is a line array too (`--output` writes the original).
- `page get` includes `parent: {id, title}` (`{id, type}` when the parent is not a page). `--grep <regex>` (case-insensitive, matched against the markdown text without backslash escapes) replaces the body with `{id, title, parent, version, url, lines, matches:[{from, to?, hits?, text}], moreMatches?}` (`matches: []` is always printed): 1-based line numbers in the rendered body (the lines `--output` writes), ranges split at 20 lines, a long line becomes an excerpt followed by a `… N more matches in this line` row, at most 20 ranges with `moreMatches` counting the rest; `--context N` (needs `--grep`) adds surrounding lines and merges overlapping ranges. Works with `--version` and `--format md|storage|view`; `--format adf` and `--full` are `invalid_flag_combination`.
- Every comment command takes `--kind footer|inline`. `comment add` has no default: a top-level comment is footer and a reply takes its parent's kind (`comment_kind_mismatch` otherwise); `comment get | replies | versions` try footer then inline when `--kind` is omitted; `comment list` defaults to footer and also accepts `all` (footer then inline, each item tagged `kind`; `--limit` applies per kind and one `nextCursor` resumes both). `comment get --version N` reads an earlier version. `comment list --replies` nests replies to full depth (10 levels or 200 requests, then `replies_truncated`); `parentCommentId` is the comment replied to. `atl get <comment ref>` forwards `--kind` to `comment get`.
- `issue links --chain "<relation>"` follows the first matching link per issue (up to `--max`, default 20) and returns `{chain:[{key, summary, status, branches?, cycleTo?}], stoppedBy: end|cycle|max}`; `branches` is the array of other matching keys, and `relations` lists the start issue's relations when none matches. `issue links` reports `remote: <n>`; `--global-id` with no match gives an empty list.
- `jql --group-by <field>` (a field id, name, localized name or clause name) returns `{total, groups:{value: count}}` over up to 1000 issues (`capped: true` when cut). `issue tree <issue> [--depth N] [--group-by <field>] [--issue-fields ...]` lists everything under an epic or issue, sub-tasks and deeper levels included, as `{root, total, items, capped?}` (each item has `depth` and its parent key) or counts them with `--group-by`; `childIssuesOf()` JQL can return nothing for sub-tasks (`child_issues_of_empty`). `--issue-fields` extras are top-level on `jql` and `issue get` items. On non-English sites status names are localized; transition names work in either language, JQL may need the names `atl jql-suggest --field status` returns.
- `search` with no results writes a `{"type":"hint","code":"empty_search","next":[...]}` line to stderr whose `next` holds the equivalent `atl cql` / `atl jql` argv (the search index can lag); an empty Confluence page is retried once. Confluence hits carry `spaceKey` and `parent`.
- `api`: GET/HEAD send directly; other methods need `--yes`, and `--plan` prints the request without sending it. Only `api.atlassian.com` receives the bearer token.

Exit codes: `0` ok, `1` input/config/auth (including `body_not_utf8` for a non-UTF-8 `--file`/stdin body), `2` API/internal (every not-found: `page_not_found`, `space_not_found`, `attachment_not_found`, `comment_not_found`, `property_not_found`), `3` transient (429/5xx/timeout/409; after a write error `write_outcome_unknown` read back before retrying), `4` failed assertion.

Markdown syntax: `<u>`, `<sub>` and `<sup>` read and write underline, subscript and superscript. A table or task list inside a quote, and a table inside a list item, is placed after its container. Tabs in fenced code are kept; merged table cells repeat their text on read; a mid-paragraph image is inline and a linked image keeps its link. `atl formats` prints the full mapping.

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
- `.github/workflows/mcp-watch.yml` runs daily. It compares the public MCP signals with `mcp/upstream.json`: upstream `server.json`/`plugin.json`, the MCP registry, protected-resource scopes, a probe for a new `/vN/mcp` endpoint, and the tool names on the public supported-tools page. When they differ it opens an `mcp-upstream` issue.
- `bun scripts/mcp-watch.ts` runs the same check locally.
- `bun src/main.ts mcp tools --snapshot --output mcp/tools-v1.json` refreshes the v1 tool snapshot. This needs a login.
- v2 refresh (needs a v2 login in a throwaway config dir; inline env only):
  1. `ATL_CONFIG_DIR=$D bun src/main.ts auth login --resource https://mcp.atlassian.com/v2/mcp` (a v1 login sees a scope-filtered catalog; `--snapshot`/`--catalog` refuse it with `resource_mismatch`)
  2. `ATL_CONFIG_DIR=$D ATL_MCP_URL=https://mcp.atlassian.com/v2/mcp`, `mcp tools --snapshot --pretty --output mcp/tools-v2.json` and `mcp tools --catalog --pretty --output mcp/operations-v2.json`
  3. `bun test test/parity.test.ts`; map every new name to a command or add a `mcp/gaps-v2.json` entry with probe evidence
  4. `rm -rf "$D"`, then `bun scripts/mcp-watch.ts --write`

`.omp/mcp.json` points omp at the v1 `authv2` MCP endpoint for this project (overrides the user-level `atlassian` server); authorize it with `/mcp reauth atlassian`.
