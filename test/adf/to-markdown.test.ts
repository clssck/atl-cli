import { describe, expect, test } from "bun:test";
import { adfToMarkdown } from "../../src/adf/index.ts";
import type { AdfDoc, AdfMark, AdfNode } from "../../src/adf/index.ts";

function doc(...content: AdfNode[]): AdfDoc {
  return { type: "doc", version: 1, content };
}
function text(value: string, ...marks: AdfMark[]): AdfNode {
  return marks.length === 0 ? { type: "text", text: value } : { type: "text", text: value, marks };
}
function para(...content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}
function node(type: string, content?: AdfNode[], attrs?: Record<string, unknown>): AdfNode {
  const result: AdfNode = { type };
  if (attrs !== undefined) {
    result.attrs = attrs;
  }
  if (content !== undefined) {
    result.content = content;
  }
  return result;
}
const mark = (type: string, attrs?: Record<string, unknown>): AdfMark =>
  attrs === undefined ? { type } : { type, attrs };
const md = (...content: AdfNode[]): string => adfToMarkdown(doc(...content));
const panel = (panelType: string): string => md(node("panel", [para(text("body"))], { panelType }));
const cell = (type: string, ...content: AdfNode[]): AdfNode => node(type, content);

describe("adfToMarkdown: blocks", () => {
  test("empty doc", () => {
    expect(md()).toBe("");
  });

  test("paragraphs are separated by blank lines and empty ones are skipped", () => {
    expect(md(para(text("one")), para(), para(text("two")))).toBe("one\n\ntwo");
  });

  test("headings 1-6", () => {
    const headings = [1, 2, 3, 4, 5, 6].map((level) =>
      node("heading", [text(`H${level}`)], { level }),
    );
    expect(md(...headings)).toBe(
      ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6"].join("\n\n"),
    );
  });

  test("heading text that looks like an ordered list is not escaped inside a heading", () => {
    expect(md(node("heading", [text("1. Intro")], { level: 2 }))).toBe("## 1. Intro");
  });

  test("paragraph text that looks like block syntax is escaped", () => {
    expect(md(para(text("1. Intro")))).toBe("1\\. Intro");
    expect(md(para(text("# not a heading")))).toBe("\\# not a heading");
    expect(md(para(text("> not a quote")))).toBe("\\> not a quote");
    expect(md(para(text("- not a bullet")))).toBe("\\- not a bullet");
    expect(md(para(text("---")))).toBe("\\---");
  });

  test("bullet and ordered lists nest with marker-width indentation", () => {
    const nested = node("bulletList", [
      node("listItem", [
        para(text("a")),
        node(
          "orderedList",
          [node("listItem", [para(text("a1"))]), node("listItem", [para(text("a2"))])],
          {
            order: 9,
          },
        ),
      ]),
      node("listItem", [para(text("b"))]),
    ]);
    expect(md(nested)).toBe(["- a", "", "  9. a1", "  10. a2", "- b"].join("\n"));
  });

  test("ordered list honours attrs.order", () => {
    const list = node(
      "orderedList",
      [node("listItem", [para(text("x"))]), node("listItem", [para(text("y"))])],
      { order: 3 },
    );
    expect(md(list)).toBe("3. x\n4. y");
  });

  test("multi-paragraph and code content stays inside the list item", () => {
    const list = node("bulletList", [
      node("listItem", [
        para(text("first")),
        para(text("second")),
        node("codeBlock", [text("ls")], { language: "sh" }),
      ]),
    ]);
    expect(md(list)).toBe("- first\n\n  second\n\n  ```sh\n  ls\n  ```");
  });

  test("adjacent lists of the same kind use different markers so they do not merge", () => {
    const first = node("bulletList", [node("listItem", [para(text("a"))])]);
    const second = node("bulletList", [node("listItem", [para(text("b"))])]);
    expect(md(first, second)).toBe("- a\n\n* b");
  });

  test("a taskList after a bulletList keeps the '-' marker (they never merge on read)", () => {
    const bullets = node("bulletList", [node("listItem", [para(text("a"))])]);
    const tasks = node("taskList", [
      node("taskItem", [text("b")], { localId: "1", state: "TODO" }),
    ]);
    expect(md(bullets, tasks)).toBe("- a\n\n- [ ] b");
  });

  test("codeBlock with and without language, and with backticks inside", () => {
    expect(md(node("codeBlock", [text("const a = 1;")], { language: "ts" }))).toBe(
      "```ts\nconst a = 1;\n```",
    );
    expect(md(node("codeBlock", [text("plain")]))).toBe("```\nplain\n```");
    expect(md(node("codeBlock", [text("a\n```\nb")]))).toBe("````\na\n```\nb\n````");
    expect(md(node("codeBlock", [text("const x = 1;\n")], { language: "ts" }))).toBe(
      "```ts\nconst x = 1;\n```",
    );
    expect(md(node("codeBlock", [text("a\n\n")]))).toBe("```\na\n\n```");
  });

  test("blockquote and rule", () => {
    expect(md(node("blockquote", [para(text("q1")), para(text("q2"))]))).toBe("> q1\n>\n> q2");
    expect(md(para(text("a")), node("rule"), para(text("b")))).toBe("a\n\n---\n\nb");
  });

  test("panel types become labelled blockquotes", () => {
    expect(panel("info")).toBe("> **Info:** body");
    expect(panel("note")).toBe("> **Note:** body");
    expect(panel("warning")).toBe("> **Warning:** body");
    expect(panel("error")).toBe("> **Error:** body");
    expect(panel("success")).toBe("> **Success:** body");
  });

  test("panel whose first child is not a paragraph puts the label on its own line", () => {
    const list = node("bulletList", [node("listItem", [para(text("x"))])]);
    expect(md(node("panel", [list], { panelType: "note" }))).toBe("> **Note:**\n>\n> - x");
  });

  test("expand and nestedExpand render details/summary with escaped title", () => {
    expect(md(node("expand", [para(text("inner"))], { title: "A & <B>" }))).toBe(
      "<details><summary>A &amp; &lt;B&gt;</summary>\n\ninner\n\n</details>",
    );
    expect(md(node("nestedExpand", [para(text("n"))], { title: "T" }))).toBe(
      "<details><summary>T</summary>\n\nn\n\n</details>",
    );
  });

  test("taskList renders checkboxes, nested task lists are indented", () => {
    const list = node("taskList", [
      node("taskItem", [text("open")], { localId: "1", state: "TODO" }),
      node("taskItem", [text("done")], { localId: "2", state: "DONE" }),
      node("taskList", [node("taskItem", [text("child")], { localId: "4", state: "TODO" })], {
        localId: "3",
      }),
    ]);
    expect(md(list)).toBe("- [ ] open\n- [x] done\n  - [ ] child");
  });

  test("decisionList renders a documented [decision] form", () => {
    const list = node("decisionList", [
      node("decisionItem", [text("Ship it")], { localId: "1", state: "DECIDED" }),
    ]);
    expect(md(list)).toBe("- [decision] Ship it");
  });
});

describe("adfToMarkdown: tables", () => {
  test("header row, separator, body rows", () => {
    const table = node("table", [
      node("tableRow", [
        cell("tableHeader", para(text("A"))),
        cell("tableHeader", para(text("B"))),
      ]),
      node("tableRow", [cell("tableCell", para(text("1"))), cell("tableCell", para(text("2")))]),
    ]);
    expect(md(table)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  test("pipes are escaped and block content is flattened with <br>", () => {
    const list = node("bulletList", [
      node("listItem", [para(text("x"))]),
      node("listItem", [para(text("y"))]),
    ]);
    const table = node("table", [
      node("tableRow", [cell("tableHeader", para(text("H")))]),
      node("tableRow", [cell("tableCell", para(text("a|b")), para(text("second")), list)]),
      node("tableRow", [cell("tableCell", para(text("code", mark("code")), text("|")))]),
    ]);
    expect(md(table)).toBe(
      ["| H |", "| --- |", "| a\\|b<br>second<br>- x<br>- y |", "| `code`\\| |"].join("\n"),
    );
  });

  test("short rows are padded and hard breaks use <br>", () => {
    const table = node("table", [
      node("tableRow", [
        cell("tableHeader", para(text("A"))),
        cell("tableHeader", para(text("B"))),
      ]),
      node("tableRow", [cell("tableCell", para(text("l1"), node("hardBreak"), text("l2")))]),
    ]);
    expect(md(table)).toBe("| A | B |\n| --- | --- |\n| l1<br>l2 |   |");
  });
});

describe("adfToMarkdown: inline", () => {
  test("strong, em, code, strike, link", () => {
    expect(
      md(
        para(
          text("b", mark("strong")),
          text(" "),
          text("e", mark("em")),
          text(" "),
          text("c", mark("code")),
          text(" "),
          text("s", mark("strike")),
          text(" "),
          text("l", mark("link", { href: "https://x.y/z" })),
        ),
      ),
    ).toBe("**b** *e* `c` ~~s~~ [l](https://x.y/z)");
  });

  test("link with title and a destination containing parentheses", () => {
    expect(md(para(text("w", mark("link", { href: "https://x.y/a_(b)", title: 'T "q"' }))))).toBe(
      '[w](https://x.y/a_\\(b\\) "T \\"q\\"")',
    );
  });

  test("link whose text is the URL becomes an autolink", () => {
    expect(md(para(text("https://x.y", mark("link", { href: "https://x.y" }))))).toBe(
      "<https://x.y>",
    );
  });

  test("link text with brackets is escaped", () => {
    expect(md(para(text("see [1] and [2]", mark("link", { href: "https://x.y" }))))).toBe(
      "[see \\[1\\] and \\[2\\]](https://x.y)",
    );
  });

  test("underline, sub and sup render as visible tags; colour has no syntax and stays plain", () => {
    expect(
      md(
        para(
          text("u", mark("underline")),
          text("2", mark("subsup", { type: "sub" })),
          text("c", mark("textColor", { color: "#ff0000" })),
        ),
      ),
    ).toBe("<u>u</u><sub>2</sub>c");
    expect(
      md(
        para(
          text("x"),
          text("2", mark("subsup", { type: "sup" })),
          text(" and "),
          text("bold", mark("strong"), mark("underline")),
        ),
      ),
    ).toBe("x<sup>2</sup> and **<u>bold</u>**");
  });

  test("whitespace is moved outside emphasis delimiters", () => {
    expect(md(para(text("a"), text(" bold ", mark("strong")), text("b")))).toBe("a **bold** b");
  });

  test("nested and adjacent marks", () => {
    expect(md(para(text("x", mark("strong"), mark("em"))))).toBe("**_x_**");
    expect(
      md(para(text("a ", mark("strong")), text("b", mark("strong"), mark("link", { href: "u" })))),
    ).toBe("**a [b](u)**");
  });

  test("code spans containing backticks use a longer fence", () => {
    expect(md(para(text("a`b", mark("code"))))).toBe("``a`b``");
    expect(md(para(text("`x", mark("code"))))).toBe("`` `x ``");
  });

  test("special characters are escaped", () => {
    expect(md(para(text("*a* _b_ `c` [d] <e> ~f~ \\g")))).toBe(
      "\\*a\\* \\_b\\_ \\`c\\` \\[d\\] \\<e> \\~f\\~ \\\\g",
    );
    expect(md(para(text("snake_case_name")))).toBe("snake_case_name");
    expect(md(para(text("&amp; & https://example.com")))).toBe("\\&amp; & https\\://example.com");
  });

  test("hardBreak", () => {
    expect(md(para(text("a"), node("hardBreak"), text("b")))).toBe("a\\\nb");
  });

  test("mention uses display text, then falls back to the account id", () => {
    expect(md(para(node("mention", undefined, { id: "712020:abc", text: "@Jane Doe" })))).toBe(
      "@Jane Doe",
    );
    expect(md(para(node("mention", undefined, { id: "712020:abc" })))).toBe("@<712020:abc>");
  });

  test("emoji prefers shortName and falls back to text", () => {
    expect(md(para(node("emoji", undefined, { shortName: ":smile:", text: "x" })))).toBe(":smile:");
    expect(md(para(node("emoji", undefined, { text: "\u{1F600}" })))).toBe("\u{1F600}");
  });

  test("inlineCard, blockCard and embedCard render autolinks", () => {
    expect(md(para(node("inlineCard", undefined, { url: "https://a.b/c" })))).toBe(
      "<https://a.b/c>",
    );
    expect(md(node("blockCard", undefined, { url: "https://a.b/d" }))).toBe("<https://a.b/d>");
    expect(md(node("embedCard", undefined, { url: "https://a.b/e" }))).toBe("<https://a.b/e>");
    expect(md(para(node("inlineCard", undefined, { data: { url: "https://a.b/f" } })))).toBe(
      "<https://a.b/f>",
    );
    expect(md(para(node("inlineCard", undefined, {})))).toBe("<!-- adf:inlineCard -->");
  });

  test("status renders as upper-case brackets", () => {
    expect(md(para(node("status", undefined, { text: "in progress", color: "blue" })))).toBe(
      "[IN PROGRESS]",
    );
  });

  test("date renders the ISO day from a millisecond timestamp", () => {
    expect(md(para(node("date", undefined, { timestamp: "1700000000000" })))).toBe("2023-11-14");
    expect(md(para(node("date", undefined, { timestamp: 1700000000000 })))).toBe("2023-11-14");
  });

  test("placeholder renders nothing", () => {
    expect(md(para(text("a"), node("placeholder", undefined, { text: "type here" })))).toBe("a");
  });

  test("inline nodes directly under a block container are wrapped into a paragraph", () => {
    expect(md(node("taskList", [node("taskItem", [text("a "), text("b", mark("strong"))])]))).toBe(
      "- [ ] a **b**",
    );
  });
});

describe("adfToMarkdown: media, extensions, unknown", () => {
  test("mediaSingle and mediaGroup keep the media id in a placeholder URL", () => {
    expect(
      md(
        node("mediaSingle", [
          node("media", undefined, { type: "file", id: "abc-1", collection: "" }),
        ]),
      ),
    ).toBe("![file](media:abc-1)");
    expect(
      md(
        node("mediaSingle", [
          node("media", undefined, {
            type: "file",
            id: "abc-2",
            collection: "contentId-9",
            alt: "Diagram [1]",
          }),
        ]),
      ),
    ).toBe("![Diagram \\[1\\]](media:abc-2?collection=contentId-9)");
    expect(
      md(
        node("mediaGroup", [
          node("media", undefined, { type: "file", id: "m1" }),
          node("media", undefined, { type: "file", id: "m2" }),
        ]),
      ),
    ).toBe("![file](media:m1)\n\n![file](media:m2)");
  });

  test("external media keeps its URL and caption text follows", () => {
    expect(
      md(
        node("mediaSingle", [
          node("media", undefined, { type: "external", url: "https://x.y/i.png", alt: "pic" }),
          node("caption", [text("A caption")]),
        ]),
      ),
    ).toBe("![pic](https://x.y/i.png)\n\nA caption");
  });

  test("extension, bodiedExtension and inlineExtension render macro comments", () => {
    expect(
      md(
        node("extension", undefined, {
          extensionKey: "toc",
          extensionType: "com.atlassian.confluence.macro.core",
        }),
      ),
    ).toBe("<!-- macro:toc -->");
    expect(md(node("bodiedExtension", [para(text("body"))], { extensionKey: "excerpt" }))).toBe(
      "<!-- macro:excerpt -->\n\nbody\n\n<!-- /macro:excerpt -->",
    );
    expect(md(para(text("a "), node("inlineExtension", undefined, { extensionKey: "jira" })))).toBe(
      "a <!-- macro:jira -->",
    );
  });

  test("unknown nodes render their children, else an adf comment", () => {
    expect(
      md(
        node("layoutSection", [
          node("layoutColumn", [para(text("left"))]),
          node("layoutColumn", [para(text("right"))]),
        ]),
      ),
    ).toBe("left\n\nright");
    expect(md(node("somethingNew"))).toBe("<!-- adf:somethingNew -->");
    expect(md(para(text("a"), node("weirdInline")))).toBe("a<!-- adf:weirdInline -->");
  });
});

describe("adfToMarkdown: nightmare fidelity", () => {
  const nestedTable = node("table", [
    node("tableRow", [cell("tableHeader", para(text("a"))), cell("tableHeader", para(text("b")))]),
    node("tableRow", [cell("tableCell", para(text("1"))), cell("tableCell", para(text("2")))]),
  ]);
  const legacy = (parameters: Record<string, unknown>): AdfNode =>
    node("extension", undefined, {
      extensionType: "com.atlassian.confluence.migration",
      extensionKey: "legacy-content",
      parameters,
    });

  test("legacy-content renders its nested content instead of hiding it", () => {
    const nestedContent = doc(nestedTable);
    expect(
      md(node("bulletList", [node("listItem", [para(text("a")), legacy({ nestedContent })])])),
    ).toBe("- a\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |");
    expect(
      md(
        legacy({
          nestedContent: doc(
            node("taskList", [node("taskItem", [text("task in quote")], { state: "TODO" })]),
          ),
        }),
      ),
    ).toBe("- [ ] task in quote");
  });

  test("legacy-content without nested ADF shows its storage markup in a fence", () => {
    expect(md(legacy({ cxhtml: "<table><tr><td>x</td></tr></table>" }))).toBe(
      "```xml\n<table><tr><td>x</td></tr></table>\n```",
    );
    expect(md(legacy({}))).toBe("<!-- macro:legacy-content -->");
  });

  test("merged table cells repeat their text so values stay under the right headers", () => {
    const span = (type: string, attrs: Record<string, unknown>, value: string): AdfNode =>
      node(type, [para(text(value))], attrs);
    expect(
      md(
        node("table", [
          node("tableRow", [
            span("tableHeader", { colspan: 1 }, "Region"),
            span("tableHeader", { colspan: 2 }, "Q1"),
          ]),
          node("tableRow", [
            span("tableCell", { rowspan: 2 }, "EU"),
            span("tableCell", {}, "10"),
            span("tableCell", {}, "20"),
          ]),
          node("tableRow", [span("tableCell", {}, "30"), span("tableCell", {}, "40")]),
        ]),
      ),
    ).toBe("| Region | Q1 | Q1 |\n| --- | --- | --- |\n| EU | 10 | 20 |\n| EU | 30 | 40 |");
  });

  test("an external image without alt text renders an empty alt, not the file placeholder", () => {
    expect(
      md(
        node("mediaSingle", [
          node("media", undefined, { type: "external", url: "https://e/i.png" }),
        ]),
      ),
    ).toBe("![](https://e/i.png)");
  });

  test("a linked image reads back as [![alt](src)](href)", () => {
    const media = node("media", undefined, { type: "external", url: "https://e/i.png", alt: "l" });
    media.marks = [mark("link", { href: "https://x.example" })];
    expect(md(node("mediaSingle", [media]))).toBe("[![l](https://e/i.png)](https://x.example)");
  });
});
