# Confluence storage-format patterns

Storage format = XML-based XHTML: what `atl page get --format storage` returns and `page update|create --file x.xhtml` sends as-is. Workflow: [editing.md](skill://atl/references/editing.md). Evidence: **live** = read on the trial site (page id); **docs** = Atlassian [storage format](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html), [macros](https://confluence.atlassian.com/spaces/CONF54/pages/428803596/Confluence+Storage+Format+for+Macros), per-macro pages.

## Rules

- Fragment only: no `<html>`, `<head>`, `<body>`, `<style>`, `<script>`. Well-formed XML: close every tag (`<br />`, `<hr />`), escape `& < >` as `&amp; &lt; &gt;`. Confluence writes named entities (`&oacute; &nbsp;`); raw UTF-8 also occurs (live 5472368).
- New macros omit `ac:macro-id` and `ac:schema-version` (docs examples omit them; id-less macros exist live, 196776). Existing macros: copy both verbatim. Parameter order is irrelevant.
- Code and raw text in `<![CDATA[...]]>`; a literal `]]>` inside is split as `]]]]><![CDATA[>`.
- Headings `h2`-`h4`; no `h1` (the title is the H1); none inside table cells.
- Preserve, never author: `ac:adf-extension`, `ac:inline-comment-marker`, `ac:placeholder`, `ri:version-at-save`.
- Look up first: title `atl cql 'space = KEY AND title = "Exact"'`; account id `atl user find "name"`; file `atl attachment list <page> --filename x.png`.

## Panels

```xml
<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Context</ac:parameter><ac:rich-text-body><p>Neutral background.</p></ac:rich-text-body></ac:structured-macro>
```

| `ac:name` | Colour / ADF panelType | Use |
|---|---|---|
| `info` | blue / `info` | context, scope |
| `tip` | green / `success` | confirmed outcome |
| `note` | yellow / `warning` | constraint, prerequisite, risk |
| `warning` | red / `error` | blocker, destructive step |

Mapping live: 196802 (info, tip, warning), 4161586 (`note` -> `warning`; an existing panel's `containerLevel` param stays, a new panel omits it). Purple note panels are `ac:adf-extension` (196802): preserve. Docs params: `title`, `icon=false`. Custom colour: `panel` with `bgColor`, `panelIcon`, `panelIconId` (live 196724). 1-2 framing panels near the top, not every paragraph.

## Status lozenge

```xml
<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">In progress</ac:parameter><ac:parameter ac:name="colour">Blue</ac:parameter></ac:structured-macro>
```

`colour`: Grey (default), Red, Yellow, Green, Blue; `subtle=true` for light style (docs; live 4161586, 196776). Title 1-2 words; full state goes in the adjacent cell. State marker only.

## Expand, TOC, code

```xml
<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Commands</ac:parameter><ac:rich-text-body><p>Hidden detail.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const x = a < b;]]></ac:plain-text-body></ac:structured-macro>
```

Live 4161586 (toc may be self-closing); task list inside expand live 7831553. Docs params: toc `type` list|flat, `minLevel`, `style`, `outline`, `include`/`exclude`; code `title`, `theme`, `linenumbers`, `firstline`, `collapse`. TOC only with 4+ headings. Critical warnings and decisions never only inside an expand.

## Properties, excerpts, includes, children

```xml
<ac:structured-macro ac:name="details"><ac:rich-text-body><table><tbody><tr><th>Owner</th><td>Treasury</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="excerpt"><ac:parameter ac:name="name">escalation</ac:parameter><ac:rich-text-body><p>Reusable text.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="excerpt-include"><ac:parameter ac:name=""><ac:link><ri:page ri:content-title="Runbook" /></ac:link></ac:parameter><ac:parameter ac:name="name">escalation</ac:parameter></ac:structured-macro>
<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ac:link><ri:page ri:space-key="ENG" ri:content-title="Runbook" /></ac:link></ac:parameter></ac:structured-macro>
<ac:structured-macro ac:name="children"><ac:parameter ac:name="depth">2</ac:parameter></ac:structured-macro>
```

`details`, `excerpt`, `excerpt-include`: live (7503873, 5898241, 5931009). `include`, `children`: docs only (children params `all depth sort reverse style excerpt first page`). Keep the unnamed parameter exactly as `ac:name=""`. `excerpt-include nopanel=true` drops the panel. Live dynamic macros: `recently-updated`, `blog-posts` (`max`, `content`; 163933). Readers need view permission on included pages.

## Jira

```xml
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="server">System Jira</ac:parameter><ac:parameter ac:name="columns">key,summary,status</ac:parameter><ac:parameter ac:name="maximumIssues">50</ac:parameter><ac:parameter ac:name="jqlQuery">project = NMS AND statusCategory != Done ORDER BY key</ac:parameter></ac:structured-macro>
<a href="https://SITE.atlassian.net/browse/KAN-7" data-card-appearance="inline">KAN-7</a>
```

Macro: live 6127617; copy `server` from an existing Jira macro on the site. Escape `"` as `&quot;` in `jqlQuery`. Single issue: `<ac:parameter ac:name="key">KAN-7</ac:parameter>` is a community example, not seen on the trial site; confirm with `--format view`. Smart link: live 4161586 (`block` for a card line).

## Layouts

```xml
<ac:layout><ac:layout-section ac:type="two_equal">
  <ac:layout-cell><h3>Current</h3><p>...</p></ac:layout-cell>
  <ac:layout-cell><h3>Target</h3><p>...</p></ac:layout-cell>
</ac:layout-section></ac:layout>
```

`ac:type` (docs): `single two_equal two_left_sidebar two_right_sidebar three_equal three_with_sidebars`; live also `fixed-width` + `ac:breakout-mode="default"` (196724). Cell count matches the type. Docs: `ac:layout` is the top-level element, so wrap the whole body or none. Columns only for real contrast.

## Tables

```xml
<table data-layout="default"><tbody>
  <tr><th><p>Area</p></th><th><p>Status</p></th></tr>
  <tr><td><p>Migration</p></td><td><p><ac:structured-macro ac:name="status"><ac:parameter ac:name="title">Ready</ac:parameter><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro></p></td></tr>
</tbody></table>
```

Header = first `<tr>` of `<th>` in `<tbody>` (docs form). `<thead>` survives (live 425990) but the editor does not write it. `colspan`/`rowspan` work (live 4161586). `data-layout="default"` is added by Confluence (327 of 337 live tables); copy or omit. Cells hold paragraphs, lists, macros. Split paragraph-heavy tables.

## Tasks and decisions

```xml
<ac:task-list>
  <ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Confirm owner</ac:task-body></ac:task>
  <ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Draft reviewed</ac:task-body></ac:task>
</ac:task-list>
```

Live 7831553, docs. `ac:task-id`: integer unique per page; continue numbering, never renumber. `ac:task-uuid` is on most saved tasks (332 of 352): copy, never invent. Toggle = `ac:task-status`. Decision lists are `ac:adf-extension` (`decision-list`, DECIDED|UNDECIDED, live 4161586): edit only `ac:adf-content` and its `ac:adf-fallback` item; new decisions go in a table.

## Mentions, dates, links

```xml
<p>Owner <ac:link><ri:user ri:account-id="62a219658783e7006f627f3b" /></ac:link>, due <time datetime="2026-11-16" />.</p>
<p><ac:link><ri:page ri:content-title="Runbook" /><ac:plain-text-link-body><![CDATA[Runbook]]></ac:plain-text-link-body></ac:link>
<ac:link><ri:page ri:space-key="ENG" ri:content-title="Runbook" /><ac:link-body>the <strong>runbook</strong></ac:link-body></ac:link>
<ac:link><ri:space ri:space-key="NMCORP" /><ac:link-body>Space home</ac:link-body></ac:link>
<ac:link ac:anchor="rollback"><ac:plain-text-link-body><![CDATA[Rollback]]></ac:plain-text-link-body></ac:link>
<a href="https://example.com">External</a></p>
<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">rollback</ac:parameter></ac:structured-macro>
```

Live: `ri:user ri:account-id`, `<time datetime="YYYY-MM-DD" />` (4161586); `ri:page` with/without `ri:space-key`, `ri:space` (1572892, 2818049, 7798785). Docs: `ac:anchor`, `anchor` macro, `ri:blog-post` (needs `ri:posting-day` YYYY/MM/DD). `ac:link-body` allows only `b strong em i code tt sub sup br span`. A link to a missing title renders broken, not as an error: check with `atl cql`. Mention only a known account id, else plain text.

## Images and attachments

```xml
<ac:image ac:align="center" ac:width="600"><ri:attachment ri:filename="diagram.png" /></ac:image>
<ac:image ac:alt="Logo"><ri:url ri:value="https://example.com/logo.png" /></ac:image>
<ac:link><ri:attachment ri:filename="report.pdf" /><ac:plain-text-link-body><![CDATA[Report]]></ac:plain-text-link-body></ac:link>
```

Live: `ri:attachment` image (196724), external image (4161586; re-emitted as `ac:src` plus `ri:url`). The file must already be attached; upload is a gap (editing.md). Docs attributes: `ac:align alt title width height border thumbnail`. Never `data:` URIs or local paths.

## Diagrams and app macros

Mermaid, draw.io, roadmap and other app macros are `ac:structured-macro` or `ac:adf-extension` blocks with opaque parameters. Preserve existing ones byte for byte (plan `check.removed` must not list them); never synthesize them (a hand-built Mermaid extension saved fine, then rendered "Error while loading diagram"). New diagram: source in a `code` macro; the user inserts the native macro.

## Round trip

- Save adds `ac:macro-id`, `ac:schema-version`, `ri:version-at-save`, `data-layout`; restore regenerates macro ids (live 7831553 v1 vs v2). Compare by intent.
- `<span style="color: ...">` and `background-color` survive as ADF `textColor`/`backgroundColor` (live 4161586).
- ADF view: panels, `status`, `expand`, `taskItem`, `layoutSection`, `mention`, `date`, `mediaSingle` are native nodes; `toc`, `details` stay `extension`/`bodiedExtension` (live 4161586). Markdown reads panels as `> **Warning:**` and macros as `<!-- macro:key -->`; writing that back loses them.
- Not live-tested (storage writes forbidden): unclosed tags or bare `&` fail XML parsing; `<script>`/`<style>` and unknown `class`/`data-*` are dropped or rejected (old HTML-dialect findings). `<details>`, `<section data-type>` are the old MCP dialect: use `expand`, `ac:layout`.

## Page design

Layers: metadata line (lozenge, owner, date, audience) > 1-2 framing panels > snapshot table > decisions > evidence tables > task list (human-checkable follow-ups only) > expands (commands, appendix) > related-content table (link, why it matters, owner/freshness).

| Reader need | Structure |
|---|---|
| Learn | context, guided steps, expected results |
| Do | prerequisites, numbered steps, validation, rollback, failure modes |
| Look up | reference tables, terse definitions, owners |
| Understand | explanation, diagram, tradeoffs, decision history |

One archetype per page; other modes go in expands or child pages. Archetypes: policy (scope panel, snapshot, decisions, pattern matrix, checklist); status (strip, milestones, blockers/risks columns, decisions, actions); runbook (purpose, prerequisites, warning panel, numbered procedure, validation, rollback expand); KB article (short answer, context, examples, related, owner/freshness); hub (purpose, links by user intent, key actions, ownership). Templates: `skill://atl/assets/runbook.xhtml`, `skill://atl/assets/status-report.xhtml`. No emoji, icons or CSS; columns only for contrast.

Gate before publishing: status, owner, main point on the first screen; headings answer reader questions; decisions apart from discussion, actions from docs; secondary detail in expands, critical warnings never; related links say why they matter.
