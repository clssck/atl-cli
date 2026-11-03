# Research: answer from Confluence and Jira

Read-only. Narrow search, selective fetch, synthesis by topic, every claim cited. Never fill gaps from general knowledge; never create, edit, comment or transition while researching.

## Route

| Signal | First command |
|---|---|
| Key, URL, ARI given | `atl get NMS-55` · `atl get <url>` |
| "in Confluence", docs, runbook, how-to | `atl cql 'type = page AND text ~ "runbook"'` |
| tickets, bugs, status, history, decisions | `atl jql 'project = NMS AND text ~ "refund" ORDER BY updated DESC'` |
| unknown system, acronym | `atl search "settlement export"` |
| several sites (`atl sites`) | add `--site <host>`; pick by the user's hint or ask |

`atl search` is CQL `text ~` plus JQL `text ~`, interleaved; not Rovo: no semantic ranking, no third-party sources. Every word must match, so pass 2-3 key terms (system name, acronym, error text), never a sentence. `--product jira|confluence` and `--type page|issue|comment|...` narrow it. No hits → stderr hint `empty_search` whose `next` holds `title ~` / `summary ~` fallbacks; the index can lag, so try those and variants before calling it a gap.

## Run a search

<procedure>
1. Shortest query that names the thing. Run independent searches in parallel: the CQL or JQL from the route table plus `atl search "<2-3 terms>"` (they rank differently; CQL `text ~` alone has missed the most relevant page).
2. Trim lists: `--fields id,title,spaceKey,lastModified` (pages), `--fields key,summary,status,updated` (issues); `--limit N`. Localized status names: `issue get` adds `statusCategory` (`new`/`indeterminate`/`done`); counts per category: `jql '<JQL>' --group-by statusCategory`.
3. Fetch only the hits needed, in parallel. Prefer grep to full bodies:
   - `atl page get 786503 --grep "card token" --context 1` → matching lines with line numbers, plus `version`, `url`.
   - `atl issue get NMS-55 --grep "charged" --context 1` → matching description and comment lines.
   - `--grep` cuts long matched lines with `…` (storage bodies are often one line). Long page or cut matches: `atl page get 786503 --output p.md`, then search the file.
4. Discussion matters (decisions, reversals): `atl issue comments NMS-55 --grep "idempotency"`, `atl get NMS-55 --comments 5`, `atl comment list <page> --kind all --replies`.
5. Context: a hub page (topic overview) → always `atl page children ID` (sub-pages often hold the specifics). Also `atl issue links KEY --chain "is blocked by"`, `atl issue tree EPIC-1 --depth 2`, `atl page tree ID --depth 2`, `atl graph object <ari|url|key>` (hydrate an ARI), `atl page versions ID --limit 5` (staleness).
6. Weak results → retry once or twice with variants (synonym, acronym expansion, error code, `title ~` only) before declaring a gap. A page whose title promises the answer but whose body lacks it → check `--format storage` (macro parameters), `page properties`, `comment list`; still nothing → report "page X exists but states no value", never a guessed value.
7. Over 15 hits → group, curate the top few, offer to narrow. A page of obvious noise → narrow the query instead of paging it. Any list your answer relies on → complete it (see Paging).
</procedure>

## Paging

A list is complete only when stdout has no `nextCursor`, `truncated` or `capped`, and stderr has no `search_incomplete` or other warning or hint about missing data (`tree_depth_unchecked` on `page tree`, `replies_truncated` and `repliesNextCursor` on `comment list --replies`). `search_incomplete`: the Confluence index answered short with no next page; rerun the query, still short → partial. Otherwise report the list as partial and how far you read; NEVER narrow the depth the user asked for ("every", "complete") without saying so. Default page is 25 items (`search`: 10).

For "every descendant", `page tree` boundary nodes with `hasChildren: true` mean deeper pages remain even without a cursor or warning. Continue from those page IDs until the requested tree is covered, or report the depth-limited result as partial. For an explicitly requested depth, stop at that bound and state it.

| Command | More results |
|---|---|
| `cql`, `jql`, `issue comments`, `page children` (also `page tree`, `page versions`, `comment list`, `space pages`, `attachment list`, `issue changelog`) | `--limit N`, then `--cursor <nextCursor>` with the same query and filters; or `--all` for up to 1000 items from the start (`--all --cursor C` continues from C). A capped sweep returns 1000 items plus `nextCursor` and `truncated: true`: continue with `--all --cursor <nextCursor>` |
| `search` | `--limit N` (max 100), then `--cursor`: one cursor covers Confluence and Jira. `--all` → `unknown_flag` (exit 1, no request). If either product errors the whole call fails with no partial stdout: rerun with `--product confluence\|jira` for the other and report the failed product as unsearched. A short Confluence page returns both products' items plus `search_incomplete` |
| `issue tree` | no cursor; `--limit N` (max 1000), `capped: true` means the tree is partial |
| `jql --group-by` | scans up to 1000 issues; `capped: true` means partial counts. `--limit`/`--cursor` conflict with this mode |
| `issue comments --grep` | searches up to 1000 comments without a resumable cursor; `truncated: true` means partial. For more, fetch ordinary paged comments and search locally; do not combine `--grep` with `--limit`/`--cursor` |
| `page ancestors`, `user find` | `--limit` only; `--all` → `unknown_flag` |
| `issue worklogs --since/--until` | reads every page itself, but stops at 1000 with `truncated: true` and cannot resume (`--cursor` conflicts): split into non-overlapping date windows; if a window still truncates, report it partial. `--all`, `--limit`, `--cursor` → `conflicting_flags` |
| `issue get`, `issue links`, `issue attachments`, `page get`, `page diff`, `board sprints` | not paged; `--all` is accepted and ignored |

## Query gotchas (verified on CQL and JQL)

| Rule | Example |
|---|---|
| Exact phrase needs escaped inner quotes; plain `"a b"` matches the words in any order | `atl cql 'text ~ "\"full request bodies\""'` |
| Shell: single-quote the whole query, `\"` inside | `atl jql 'text ~ "\"charged twice\""'` · `atl search '"charged twice"'` |
| All words must match | `text ~ "disaster zzqxv"` → nothing |
| Stemmed (CQL): plural/verb forms match | `title ~ "recoveries"` finds "Disaster recovery"; confirm hits before citing |
| JQL ignores stop words, even inside a phrase | `"customer was charged twice"` also hits "customer is charged twice": verify negations by reading |
| Text fields take `~`/`!~`, never `=` | CQL `text = ...` → `http_400` "Could not parse cql"; JQL `summary = ...` → empty plus warning `jql_invalid` |
| CQL cannot start with `NOT`; `!~`/`!=` first is fine | `'type = page AND NOT text ~ "x"'` |
| Quote space keys starting with a digit | `space = "3C"`; bare `3C` → `http_400` |
| Trailing wildcard, recency | `atl cql 'title ~ "disast*" AND lastmodified >= now("-12w") ORDER BY lastmodified DESC'` |
| JQL: narrow by `project`, `issuetype`, `created >= -90d`; sort `ORDER BY updated DESC`; check syntax first | `atl jql-check 'project = NMS AND'` |
| Jira status values may be localized; JQL keywords stay English | `statusCategory != Done` is portable |

## Source quality

- Strong: recent, canonical ("Guide", "Overview", "Runbook"), confirmed by several sources.
- Weak: tickets older than two years, drafts, personal spaces, duplicates.
- Fetch order: official docs → recent relevant issues → related pages named in results.
- Jira is implementation reality: a description says "fixed", a later comment may reopen it. Read the newest comments before stating status.

## Access errors

| Seen | Meaning | Say |
|---|---|---|
| `http_401` (category `auth`, `next: atl auth status`) | token expired or scope missing | run `atl auth status`/`atl auth login`; stop |
| `http_403` (category `auth`) | the account lacks permission in that space/project, or the token lacks a scope | name the item; user must request access |
| `http_404` (category `api`; Jira text "does not exist or you do not have permission") | missing **or** hidden | never claim it does not exist |
| User can open the item in a browser but atl gets 401/403/404, or it is absent from search | permission, token scope, or an org Data Security Policy (atl cannot tell which) | report as blocked; name key/title and space |

After `http_403`/`http_404` on an item, stop content requests for it: no `page versions`, `comment list`, `page children`, space-wide `cql`, title search or other site to explain it. Diagnose with metadata only (`atl sites`: does the login cover the host?), then report the item (key, URL or id), the error code, "missing or hidden", and that only the user's browser or the space/project admin settles it.

`atl auth status` reads local token metadata and sends no request: `loggedIn: true` does not show that Atlassian accepts the token or grants access, so it never rules out a login, scope or permission cause.

## Answer shape

Direct answer first, then context and caveats by topic, not by source. Cite each claim inline: page title or issue key. State conflicts (both sources, which is current, why), stale dates, and gaps ("Not found: rollback procedure; searched X, Y").

```
Retries can double-charge: NMS-55 was fixed in 1.1 (idempotency key reused) but reopened after a
production regression via the fallback gateway (NMS-55 comment, 2026-10-23).

## Sources
- [Disaster recovery](https://<site>/wiki/spaces/SZOFTVERFE/pages/786503)
- [NMS-55](https://<site>/browse/NMS-55) - Duplicate charge on payment retry
```

Page URLs: `url` from `page get`. `cql` and `search` page hits omit it. When the page cannot be fetched and the site host, `spaceKey` and `id` are all known from the hit, `https://<site>/wiki/spaces/<spaceKey>/pages/<id>` is the form `page get` prints. Such a link only points at the page: its body is unread, so it is never evidence for a claim. Issue URLs: `https://<site>/browse/<KEY>` (`atl sites` gives the host).

<critical>
- NEVER fill gaps from general knowledge; NEVER create, edit, comment or transition while researching.
- MUST cite every claim; NEVER retry around an access error or bypass it with `atl mcp call`.
</critical>
