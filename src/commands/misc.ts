import { Type } from "../core/schema.ts";
import { COMMENT_LOOKUP_KIND_FLAG } from "./confluence.ts";
import { defineCommand, type CommandContext, type CommandSpec } from "../core/cli.ts";
import { AtlError } from "../core/errors.ts";
import { parseAnyRef, parseDisplayLink } from "../resolve/index.ts";

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

function target(ctx: CommandContext, name: string): CommandSpec {
  const spec = ctx.registry.get(name);
  if (spec === undefined) {
    throw new AtlError(`Command ${name} is not registered`, {
      code: "command_missing",
      category: "internal",
    });
  }
  return spec;
}

const GetFlags = Type.Object({
  format: Type.Optional(
    Type.Union([Type.Literal("md"), Type.Literal("adf"), Type.Literal("storage")], {
      description: "Body format: markdown (default), raw ADF, or storage XHTML (Confluence pages)",
    }),
  ),
  kind: COMMENT_LOOKUP_KIND_FLAG,
  comments: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100,
      description: "Jira issues: include the N newest comments",
    }),
  ),
});

const get = defineCommand({
  name: "get",
  summary: "Get a Confluence page, comment, or Jira issue from a URL, ARI, or issue key",
  mcpTools: ["fetch"],
  args: [{ name: "ref", description: "Confluence/Jira URL, ARI, or issue key", required: true }],
  flags: GetFlags,
  sideEffects: "none",
  examples: [
    "atl get ENG-123",
    "atl get https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Title",
    "atl get ari:cloud:jira:<cloudId>:issue/10000",
    "atl get 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123?focusedCommentId=789'",
  ],
  async run(ctx, input) {
    const text = input.args.ref ?? "";
    const { flags } = input;
    const parsed = parseDisplayLink(text) === undefined ? parseAnyRef(text) : undefined;
    const format = flags.format === undefined ? {} : { format: flags.format };

    if (parsed === undefined) {
      // A legacy /display/ link names a page by title; page.get resolves it.
      return await target(ctx, "page.get").run(ctx, {
        args: { page: text },
        rest: [],
        flags: format,
      });
    }

    if (
      flags.format === "storage" &&
      (parsed.product === "jira" ||
        parsed.ref.kind === "comment" ||
        parsed.ref.commentId !== undefined)
    ) {
      throw new AtlError("Storage format is only available for Confluence pages", {
        code: "unsupported_body_format",
        category: "input",
        hint: "Use --format md or --format adf.",
      });
    }
    if (parsed.product === "jira") {
      return await target(ctx, "issue.get").run(ctx, {
        args: { issue: text },
        rest: [],
        flags: { ...format, ...(flags.comments === undefined ? {} : { comments: flags.comments }) },
      });
    }
    if (parsed.ref.kind === "comment" || parsed.ref.commentId !== undefined) {
      return await target(ctx, "comment.get").run(ctx, {
        args: { comment: text },
        rest: [],
        flags: { ...format, ...(flags.kind === undefined ? {} : { kind: flags.kind }) },
      });
    }
    return await target(ctx, "page.get").run(ctx, {
      args: { page: text },
      rest: [],
      flags: format,
    });
  },
});

// ---------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------

// Keyed maps rather than arrays of {markdown, adf} rows: each row's keys would repeat per entry.
const MARKDOWN_TO_ADF: Record<string, string> = {
  "# H1 ... ###### H6": "heading (level 1-6)",
  "plain paragraph": "paragraph; a soft line break becomes a space",
  "line ending in two spaces or a backslash, or <br>": "hardBreak inside the paragraph",
  "**bold**": "text with mark strong",
  "*italic* or _italic_": "text with mark em",
  "~~strike~~": "text with mark strike",
  "`code`":
    "text with mark code; only a link mark can be combined with it, other marks are dropped",
  '[text](https://url "title")': "text with mark link (href, optional title)",
  "- item / * item": "bulletList > listItem",
  "1. item": "orderedList > listItem",
  "- [ ] todo / - [x] done":
    "taskList > taskItem with state TODO / DONE; nested task items become nested taskLists; a code fence, table or plain nested list inside a task item follows it as its own block; there is no numbering (1. [ ] x is an unordered task)",
  "> quote":
    "blockquote; headings and rules inside become bold paragraphs; a table or task list inside follows the quote (ADF forbids it inside)",
  "```lang\ncode\n```": "codeBlock with attrs.language when a language is given; tabs are kept",
  "---": "rule",
  "| a | b |\n| --- | --- |\n| 1 | 2 |":
    "table; the first row becomes tableHeader cells, the rest tableCell; a table inside a list item follows the list item",
  "![alt](https://host/img.png)":
    "mediaSingle > media (type external, url, alt) when alone in its paragraph; inside text it stays inline as a link on the alt text; in headings and task items it is a link",
  "[![alt](https://host/img.png)](https://url)": "the media keeps the link as a link mark",
  "![alt](media:<id>?collection=<c>)":
    "mediaSingle > media (type file, id, collection); reuses an existing attachment; inside text it becomes mediaInline",
  "https://host/a_(b)":
    "text with mark link; bare http(s) URLs are linked, balanced parentheses included",
  "[text]() / [text](<a b>)": "plain text without a link (empty or whitespace destination)",
  "<sub>x</sub> / <sup>x</sup> / <u>x</u> / <strong>x</strong> / <em>x</em> / <del>x</del>":
    "text with mark subsup (sub / sup) / underline / strong / em / strike",
  "other raw HTML (not <br>, <sub>, <sup>, <u>, <strong>, <em>, <del>)":
    "kept as literal text, not interpreted",
};

const ADF_TO_MARKDOWN: Record<string, string> = {
  heading: "# ... ######",
  "strong / em / strike / code / link marks":
    "**x** / *x* / ~~x~~ / `x` / [x](url); `<strong>` / `<em>` / `<del>` where the delimiters would not re-parse (next to a word or punctuation)",
  "<u>x</u> / <sub>x</sub> / <sup>x</sup>":
    "underline / subsup marks (textColor and other marks have no syntax: plain text)",
  "bulletList / orderedList": "- item / 1. item",
  "taskList > taskItem": "- [ ] / - [x]",
  "decisionList > decisionItem": "- [decision] text",
  table:
    "GFM pipe table; the first row is the header, cell line breaks become <br>; a merged cell (colspan/rowspan) repeats its text in each position it covers",
  codeBlock: "fenced block with the language",
  blockquote: "> quote",
  "panel (info, note, warning, error, success)":
    "blockquote whose first line starts with a bold label: > **Info:** text",
  "expand / nestedExpand": "<details><summary>title</summary> ... </details>",
  rule: "---",
  mention: "@Name, or @<accountId> when the name is missing",
  emoji: "its shortName text",
  status: "[TEXT] in upper case",
  date: "YYYY-MM-DD",
  "inlineCard / blockCard / embedCard": "<url> autolink, or [url](url) when the URL has spaces",
  "media / mediaSingle / mediaGroup / mediaInline":
    "![alt or file](media:<id>?collection=<c>) placeholder; external media keeps its URL (empty alt stays empty) and its link as [![alt](src)](href)",
  extension:
    "<!-- macro:<key> -->; legacy-content (a table or task list Confluence kept as a macro) renders its content",
  "inlineExtension (macros)": "<!-- macro:<key> -->",
  bodiedExtension: "<!-- macro:<key> --> body <!-- /macro:<key> -->",
  "unknown node": "its children, or <!-- adf:<type> --> when it has none",
};

const FORMAT_ENTRIES = {
  confluence: {
    write:
      "any command with --body/--file: [--body-format md|adf|storage] (find them: atl commands run --contains body-format)",
    read: "atl page get <page> --format md|adf|storage (default md)",
    formats: {
      md: "Markdown converted locally to ADF (default for any file but .json/.html/.xhtml/.xml)",
      adf: "ADF JSON document {type:'doc', version:1, content:[...]}; default for .json files",
      storage: "Confluence storage-format XHTML sent as-is; default for .html/.xhtml/.xml files",
    },
    notes: [
      "Pass short bodies inline with --body '<text>' or pipe them with --file -; longer ones go in --file <path>. --body and --file are mutually exclusive.",
      "Macros, mentions, panels, expands, statuses and dates cannot be authored from markdown; use --body-format adf or storage.",
      "Round trip: reading a page as md and writing it back preserves text, marks, lists, tables and code, but macros come back as <!-- macro:key --> comments that are written as literal text.",
    ],
  },
  jira: {
    write:
      "any command with --body/--file (or --comment/--comment-file): [--body-format md|adf] (find them: atl commands run --contains body-format)",
    read: "atl issue get <issue> --format md|adf (default md)",
    formats: {
      md: "Markdown converted locally to ADF (default)",
      adf: "ADF JSON document; default for .json files",
    },
    notes: [
      "Jira rich-text fields are ADF; storage format is rejected.",
      "Mentions, panels, expands and statuses cannot be authored from markdown; use --body-format adf.",
    ],
  },
};

const formats = defineCommand({
  name: "formats",
  summary: "Describe the body formats atl accepts and how markdown maps to ADF and back",
  mcpTools: ["getContentFormatGuide"],
  args: [],
  flags: Type.Object({
    product: Type.Optional(
      Type.Union([Type.Literal("confluence"), Type.Literal("jira")], {
        description: "Limit the guide to one product",
      }),
    ),
  }),
  sideEffects: "none",
  examples: ["atl formats", "atl formats --product jira"],
  run: (_ctx, input) =>
    Promise.resolve({
      products:
        input.flags.product === undefined
          ? FORMAT_ENTRIES
          : { [input.flags.product]: FORMAT_ENTRIES[input.flags.product] },
      markdownToAdf: MARKDOWN_TO_ADF,
      adfToMarkdown: ADF_TO_MARKDOWN,
    }),
});

export const miscCommands: readonly CommandSpec[] = [get, formats];
