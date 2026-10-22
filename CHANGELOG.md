# Changelog

## [Unreleased]

- Initial `atl` CLI covering every Atlassian MCP v1 tool on direct REST/GraphQL, without calling the MCP server:
  - Confluence pages, spaces, comments (including comment editing) and CQL.
  - Jira issues, transitions, links, worklogs, projects and JQL.
  - `search` (CQL + JQL text search), `user find` (`groupuserpicker`), Teamwork Graph (`graph object | context | add`), Compass (GraphQL).
  - `mcp tools | call` as parity tooling and an explicit escape hatch.
- OAuth login through the Atlassian MCP authorization server, using the CLI's own registered client and locked refresh-token rotation.
- Local markdown ⇄ ADF conversion on `Bun.markdown`, `--plan` for every write, and a JSON-only stdout contract.
- Token-efficient compact output: minimal list shapes, names for people, short timestamps, and a central prune of null/empty values; `--full` returns raw API objects.
- No runtime dependencies; `bun run build` produces a single bytecode-compiled binary (plus `build:linux`, `build:windows`).
- Strict type-aware linting and a CI check.
- Daily MCP upstream watcher that opens an issue when the Atlassian MCP changes.
- Write bodies can be passed inline with `--body <text>` (and `--comment <text>` for `issue link | log | move`), or read from stdin with `--file -` / `--comment-file -`; `--body` with `--file` is `body_conflict` and a missing required body is `body_required`.
- Compact stdout is width-bounded: results over 700 bytes put one list item or object property per line (still one JSON value, no indentation, short results unchanged) so agent harnesses that cut long stdout lines no longer drop the tail. `--pretty` and the stderr JSONL diagnostics are unchanged.
- `--output PATH` now writes the `body` (pages, comments) or `description` (issues) text to the file and prints the rest of the result with that field replaced by `{path, bytes, lines}`; results without such text still write JSON (same width-bounded layout as stdout, one item per line for large results; `--pretty` indents) and print `{path, bytes}`.
- Markdown bodies (issue descriptions, issue and Confluence comments including replies, `issue get --comments`, page bodies, `space pages --body`, `jql --issue-fields description`, hydrated `get` fields) print as an array of lines instead of one string, so agent harnesses that cut each stdout line no longer drop the tail of bodies over about 700 bytes. A prose line over 600 JSON bytes is soft-wrapped at spaces; code fences, table rows and headings are not wrapped (an over-long one is hard-split). `--format adf`, `--format storage` and `--full` are unchanged, and `--output` writes the original markdown, not the wrapped display lines.
- GET/HEAD retries are bounded by a 20 s total sleep budget per request: a `Retry-After` that would exceed the remainder fails immediately with the transient error (exit 3) and a hint saying when to retry, instead of sleeping up to 30 s per retry past agent-harness foreground limits. Each retry writes one `{type:"retry", status, attempt, waitMs, path}` JSONL line to stderr.
