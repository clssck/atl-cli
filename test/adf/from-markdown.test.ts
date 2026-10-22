import { describe, expect, test } from "bun:test";
import { markdownToAdf } from "../../src/adf/index.ts";
import type { AdfNode } from "../../src/adf/index.ts";

function taskItems(list: AdfNode | undefined): unknown[] {
  return (list?.content ?? []).map((item) => [item.attrs?.state, item.content]);
}

function blocks(markdown: string): AdfNode[] {
  return markdownToAdf(markdown).content;
}

function first(markdown: string): AdfNode {
  const node = blocks(markdown)[0];
  if (node === undefined) {
    throw new Error("no blocks produced");
  }
  return node;
}

function walk(nodes: AdfNode[], visit: (node: AdfNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.content ?? [], visit);
  }
}

describe("markdownToAdf: document shape", () => {
  test("empty input yields an empty doc", () => {
    expect(markdownToAdf("")).toEqual({ type: "doc", version: 1, content: [] });
    expect(markdownToAdf("\n\n  \n").content).toEqual([]);
  });

  test("CRLF line endings are accepted", () => {
    expect(blocks("a\r\n\r\nb")).toHaveLength(2);
  });
});

describe("markdownToAdf: blocks", () => {
  test("headings keep level and text, including a leading number", () => {
    expect(first("### Title")).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Title" }],
    });
    expect(first("# 1. Intro")).toEqual({
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "1. Intro" }],
    });
  });

  test("paragraph with marks", () => {
    expect(first("a **b** *c* `d` ~~e~~ [f](https://x.y)").content).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: "b", marks: [{ type: "strong" }] },
      { type: "text", text: " " },
      { type: "text", text: "c", marks: [{ type: "em" }] },
      { type: "text", text: " " },
      { type: "text", text: "d", marks: [{ type: "code" }] },
      { type: "text", text: " " },
      { type: "text", text: "e", marks: [{ type: "strike" }] },
      { type: "text", text: " " },
      { type: "text", text: "f", marks: [{ type: "link", attrs: { href: "https://x.y" } }] },
    ]);
  });

  test("marks nest inside links and combine on one text node", () => {
    expect(first("[**bold** plain](https://x.y)").content).toEqual([
      {
        type: "text",
        text: "bold",
        marks: [{ type: "link", attrs: { href: "https://x.y" } }, { type: "strong" }],
      },
      { type: "text", text: " plain", marks: [{ type: "link", attrs: { href: "https://x.y" } }] },
    ]);
    expect(first("***both***").content).toEqual([
      { type: "text", text: "both", marks: [{ type: "em" }, { type: "strong" }] },
    ]);
  });

  test("code is only combined with link marks", () => {
    expect(first("**`x`**").content).toEqual([
      { type: "text", text: "x", marks: [{ type: "code" }] },
    ]);
  });

  test("link title, bracketed link text, autolinks and bare URLs", () => {
    expect(first('[t](https://x.y "Title")').content).toEqual([
      {
        type: "text",
        text: "t",
        marks: [{ type: "link", attrs: { href: "https://x.y", title: "Title" } }],
      },
    ]);
    expect(first("[a \\[b\\] c](https://x.y)").content).toEqual([
      { type: "text", text: "a [b] c", marks: [{ type: "link", attrs: { href: "https://x.y" } }] },
    ]);
    expect(first("<https://auto.link>").content).toEqual([
      {
        type: "text",
        text: "https://auto.link",
        marks: [{ type: "link", attrs: { href: "https://auto.link" } }],
      },
    ]);
    expect(first("see https://bare.example/x").content?.[1]).toEqual({
      type: "text",
      text: "https://bare.example/x",
      marks: [{ type: "link", attrs: { href: "https://bare.example/x" } }],
    });
  });

  test("hard breaks from backslash, trailing spaces and <br>; soft breaks become spaces", () => {
    const hard = { type: "hardBreak" };
    expect(first("a\\\nb").content).toEqual([
      { type: "text", text: "a" },
      hard,
      { type: "text", text: "b" },
    ]);
    expect(first("a  \nb").content).toEqual([
      { type: "text", text: "a" },
      hard,
      { type: "text", text: "b" },
    ]);
    expect(first("a<br>b").content).toEqual([
      { type: "text", text: "a" },
      hard,
      { type: "text", text: "b" },
    ]);
    expect(first("a\nb").content).toEqual([{ type: "text", text: "a b" }]);
  });

  test("escapes and character references are decoded", () => {
    expect(first("\\*not em\\* &amp; &lt;b&gt; &#65;").content).toEqual([
      { type: "text", text: "*not em* & <b> A" },
    ]);
  });

  test("bullet list with nested bullet list", () => {
    expect(first("- a\n  - b\n- c")).toEqual({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "a" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
        },
      ],
    });
  });

  test("ordered list records its start number; start 1 omits attrs", () => {
    const three = first("3. x\n4. y");
    expect(three.type).toBe("orderedList");
    expect(three.attrs).toEqual({ order: 3 });
    expect(three.content).toHaveLength(2);
    expect(first("1. x\n2. y").attrs).toBeUndefined();
  });

  test("list items can hold several paragraphs and code fences", () => {
    const list = first("1. step\n\n   second\n\n   ```sh\n   ls\n   ```\n2. next");
    const item = list.content?.[0];
    expect(item?.content?.map((child) => child.type)).toEqual([
      "paragraph",
      "paragraph",
      "codeBlock",
    ]);
  });

  test("task lists become taskList/taskItem with unique localIds and state", () => {
    const list = first("- [ ] todo **now**\n- [x] done");
    expect(list.type).toBe("taskList");
    expect(typeof list.attrs?.localId).toBe("string");
    const [open, done] = list.content ?? [];
    expect(open?.type).toBe("taskItem");
    expect(open?.attrs?.state).toBe("TODO");
    expect(open?.content).toEqual([
      { type: "text", text: "todo " },
      { type: "text", text: "now", marks: [{ type: "strong" }] },
    ]);
    expect(done?.attrs?.state).toBe("DONE");
    expect(done?.content).toEqual([{ type: "text", text: "done" }]);

    const ids = new Set<unknown>();
    walk([list], (node) => {
      if (node.attrs?.localId !== undefined) {
        ids.add(node.attrs.localId);
      }
    });
    expect(ids.size).toBe(3);
    expect(new Set(ids).size).toBe(ids.size);
    const again = first("- [ ] todo **now**\n- [x] done");
    expect(again.attrs?.localId).not.toBe(list.attrs?.localId);
  });

  test("nested task items become a nested taskList; task and plain items split into separate lists", () => {
    const list = first("- [ ] a\n  - [x] b");
    expect(list.content?.map((node) => node.type)).toEqual(["taskItem", "taskList"]);
    expect(list.content?.[1]?.content?.[0]?.attrs?.state).toBe("DONE");

    const mixed = blocks("- [ ] a\n- plain");
    expect(mixed.map((node) => node.type)).toEqual(["taskList", "bulletList"]);
  });

  test("a task list after a bullet list (loose, merged by the parser) strips the checkbox from text", () => {
    const expected = [
      ["TODO", [{ type: "text", text: "todo item" }]],
      ["DONE", [{ type: "text", text: "done item" }]],
    ];
    for (const markdown of [
      "- outer two\n\n- [ ] todo item\n- [x] done item",
      "- outer\n  - inner\n\n- [ ] todo item\n- [x] done item",
    ]) {
      expect(blocks(markdown).map((node) => node.type)).toEqual(["bulletList", "taskList"]);
      expect(taskItems(blocks(markdown)[1])).toEqual(expected);
    }
  });

  test("loose task lists keep the checkbox out of the text", () => {
    const list = first("- [ ] a\n\n- [x] b");
    expect(list.type).toBe("taskList");
    expect(taskItems(list)).toEqual([
      ["TODO", [{ type: "text", text: "a" }]],
      ["DONE", [{ type: "text", text: "b" }]],
    ]);
  });

  test("code fences keep language and content verbatim", () => {
    expect(first("```ts\nconst a = 1;\n\nlet b;\n```")).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;\n\nlet b;" }],
    });
    expect(first("```\nplain\n```")).toEqual({
      type: "codeBlock",
      content: [{ type: "text", text: "plain" }],
    });
  });

  test("a blank line before the closing fence is not stored as a trailing newline", () => {
    expect(first("```ts\nconst x = 1;\n\n```")).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
  });

  test("blockquote and thematic break", () => {
    expect(blocks("> quote\n\n---")).toEqual([
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }],
      },
      { type: "rule" },
    ]);
  });

  test("headings and rules inside blockquotes are rewritten to ADF-legal paragraphs", () => {
    const quote = first("> # Title\n>\n> ---");
    expect(quote.content).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Title", marks: [{ type: "strong" }] }],
      },
      { type: "paragraph", content: [{ type: "text", text: "---" }] },
    ]);
  });

  test("GFM tables: first row is tableHeader, the rest tableCell", () => {
    const table = first("| A | **B** |\n|:--|--:|\n| 1 | a\\|b |\n| x |  |");
    expect(table.type).toBe("table");
    const rows = table.content ?? [];
    expect(rows.map((row) => row.type)).toEqual(["tableRow", "tableRow", "tableRow"]);
    expect(rows[0]?.content?.map((cell) => cell.type)).toEqual(["tableHeader", "tableHeader"]);
    expect(rows[1]?.content?.map((cell) => cell.type)).toEqual(["tableCell", "tableCell"]);
    expect(rows[0]?.content?.[1]?.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "B", marks: [{ type: "strong" }] }] },
    ]);
    expect(rows[1]?.content?.[1]?.content?.[0]?.content).toEqual([{ type: "text", text: "a|b" }]);
    expect(rows[2]?.content?.[1]?.content).toEqual([{ type: "paragraph", content: [] }]);
  });

  test("<br> inside a table cell becomes a hardBreak", () => {
    const table = first("| A |\n|---|\n| x<br>y |");
    expect(table.content?.[1]?.content?.[0]?.content?.[0]?.content).toEqual([
      { type: "text", text: "x" },
      { type: "hardBreak" },
      { type: "text", text: "y" },
    ]);
  });

  test("raw HTML is kept as text, never dropped", () => {
    expect(first("<div>raw</div>")).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "<div>raw</div>" }],
    });
    expect(first("text <b>inline</b> end").content).toEqual([
      { type: "text", text: "text <b>inline</b> end" },
    ]);
    const multi = first("<details>\n<summary>S</summary>\n</details>");
    expect(multi.content).toEqual([
      { type: "text", text: "<details>" },
      { type: "hardBreak" },
      { type: "text", text: "<summary>S</summary>" },
      { type: "hardBreak" },
      { type: "text", text: "</details>" },
    ]);
  });

  test("images: external, media placeholder, inline in a paragraph, and heading fallback", () => {
    expect(first("![alt](https://x.y/i.png)")).toEqual({
      type: "mediaSingle",
      attrs: { layout: "center" },
      content: [
        { type: "media", attrs: { type: "external", url: "https://x.y/i.png", alt: "alt" } },
      ],
    });
    expect(first("![file](media:abc-1?collection=contentId-9)")).toEqual({
      type: "mediaSingle",
      attrs: { layout: "center" },
      content: [{ type: "media", attrs: { type: "file", id: "abc-1", collection: "contentId-9" } }],
    });
    expect(blocks("before ![a](https://x.y/i.png) after")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          {
            type: "text",
            text: "a",
            marks: [{ type: "link", attrs: { href: "https://x.y/i.png" } }],
          },
          { type: "text", text: " after" },
        ],
      },
    ]);
    expect(first("# ![logo](https://x.y/l.png) Title").content).toEqual([
      {
        type: "text",
        text: "logo",
        marks: [{ type: "link", attrs: { href: "https://x.y/l.png" } }],
      },
      { type: "text", text: " Title" },
    ]);
  });
});

describe("markdownToAdf: ADF validity", () => {
  test("every text node is non-empty, every list item has content, and code carries no foreign marks", () => {
    const adf = markdownToAdf(
      [
        "# H",
        "",
        "- a",
        "-",
        "- [ ]",
        "",
        "> - q",
        "",
        "| a |",
        "|---|",
        "|   |",
        "",
        "**`code`** and *[l](u)*",
      ].join("\n"),
    );
    walk(adf.content, (node) => {
      if (node.type === "text") {
        expect(node.text?.length ?? 0).toBeGreaterThan(0);
        if (node.marks?.some((mark) => mark.type === "code")) {
          expect(node.marks.every((mark) => mark.type === "code" || mark.type === "link")).toBe(
            true,
          );
        }
      }
      if (node.type === "listItem") {
        expect(node.content?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });
});

/** Every ADF child rule these tests defend: where may a block live. */
function misplaced(nodes: AdfNode[], parent: string, found: string[] = []): string[] {
  for (const node of nodes) {
    const inQuote = parent === "blockquote" && (node.type === "table" || node.type === "taskList");
    const inItem = parent === "listItem" && node.type === "table";
    const inTask =
      parent === "taskItem" &&
      !["text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date"].includes(
        node.type,
      );
    if (inQuote || inItem || inTask) {
      found.push(`${node.type} in ${parent}`);
    }
    misplaced(node.content ?? [], node.type, found);
  }
  return found;
}

const TABLE = "| x | y |\n|---|---|\n| 1 | 2 |";

describe("markdownToAdf: ADF-legal containers", () => {
  test("a table or task list in a blockquote, and a table in a list item, never nest", () => {
    for (const markdown of [
      `> ${TABLE.replaceAll("\n", "\n> ")}`,
      "> - [ ] t",
      `- a\n\n  ${TABLE.replaceAll("\n", "\n  ")}`,
      `> - a\n>\n>   ${TABLE.replaceAll("\n", "\n>   ")}`,
      `1. a\n\n   ${TABLE.replaceAll("\n", "\n   ")}`,
      "- [ ] a\n  ```\n  c\n  ```",
      "- [ ] a\n  > q\n  - b",
    ]) {
      expect(misplaced(blocks(markdown), "doc")).toEqual([]);
    }
  });

  test("the hoisted block follows the text before it; a quote with only a table is dropped", () => {
    expect(blocks(`> ${TABLE.replaceAll("\n", "\n> ")}`).map((node) => node.type)).toEqual([
      "table",
    ]);
    expect(blocks("> - [ ] t").map((node) => node.type)).toEqual(["taskList"]);
    expect(
      blocks(`> before\n>\n> ${TABLE.replaceAll("\n", "\n> ")}\n>\n> after`).map(
        (node) => node.type,
      ),
    ).toEqual(["blockquote", "table", "blockquote"]);
    expect(
      blocks(`- a\n\n  ${TABLE.replaceAll("\n", "\n  ")}\n- b`).map((node) => node.type),
    ).toEqual(["bulletList", "table", "bulletList"]);
  });

  test("an ordered list split around a table continues its numbering", () => {
    const parts = blocks(`1. a\n\n   ${TABLE.replaceAll("\n", "\n   ")}\n2. b`);
    expect(parts.map((node) => node.type)).toEqual(["orderedList", "table", "orderedList"]);
    expect(parts[0]?.attrs).toBeUndefined();
    expect(parts[2]?.attrs).toEqual({ order: 2 });
  });

  test("a code fence in a task item becomes a code block after the task", () => {
    const parts = blocks("- [ ] a\n  ```\n  c\n  ```\n- [x] b");
    expect(parts.map((node) => node.type)).toEqual(["taskList", "codeBlock", "taskList"]);
    expect(parts[1]?.content).toEqual([{ type: "text", text: "c" }]);
    expect(parts[0]?.content?.[0]?.content).toEqual([{ type: "text", text: "a" }]);
  });

  test("a nested plain bullet in a task item stays a bullet; ordered tasks are unnumbered", () => {
    const parts = blocks("- [ ] a\n  - b");
    expect(parts.map((node) => node.type)).toEqual(["taskList", "bulletList"]);
    expect(parts[1]?.content?.[0]?.content?.[0]?.content).toEqual([{ type: "text", text: "b" }]);
    const ordered = first("1. [ ] x\n2. [x] y");
    expect(ordered.type).toBe("taskList");
    expect(ordered.content?.map((item) => item.attrs?.state)).toEqual(["TODO", "DONE"]);
  });
});

describe("markdownToAdf: text fidelity", () => {
  test("tabs inside fenced code survive, at top level and inside a list item", () => {
    expect(first("```\n\tx\n\ty\tz\n```").content).toEqual([{ type: "text", text: "\tx\n\ty\tz" }]);
    const list = first("- a\n  ```\n  \tx\n  ```");
    expect(list.content?.[0]?.content?.[1]?.content).toEqual([{ type: "text", text: "\tx" }]);
    expect(first("a\tb").content).toEqual([{ type: "text", text: "a\tb" }]);
  });

  test("an image in a sentence stays in one paragraph; alone it is a block", () => {
    const one = blocks("Inline image mid-sentence ![mid](https://e.com/i.png) continues.");
    expect(one).toHaveLength(1);
    expect(one[0]?.content?.map((node) => node.text)).toEqual([
      "Inline image mid-sentence ",
      "mid",
      " continues.",
    ]);
    const many = blocks(
      "Image: ![a](https://e/a.png) and ![b](https://e/b.png) and ![](https://e/c.png).",
    );
    expect(many).toHaveLength(1);
    expect(many[0]?.content?.map((node) => node.text)).toEqual([
      "Image: ",
      "a",
      " and ",
      "b",
      " and ",
      "https://e/c.png",
      ".",
    ]);
    expect(blocks("![a](https://e/a.png) ![b](https://e/b.png)").map((node) => node.type)).toEqual([
      "mediaSingle",
      "mediaSingle",
    ]);
    const file = first("see ![f](media:abc-1?collection=c-9) here");
    expect(file.content?.[1]).toEqual({
      type: "mediaInline",
      attrs: { type: "file", id: "abc-1", collection: "c-9" },
    });
  });

  test("an image inside a link keeps the link", () => {
    const linked = first("[![l](https://e/i.png)](https://x.example)");
    expect(linked).toEqual({
      type: "mediaSingle",
      attrs: { layout: "center" },
      content: [
        {
          type: "media",
          attrs: { type: "external", url: "https://e/i.png", alt: "l" },
          marks: [{ type: "link", attrs: { href: "https://x.example" } }],
        },
      ],
    });
    expect(first("go [![l](https://e/i.png)](https://x.example) now").content?.[1]).toEqual({
      type: "text",
      text: "l",
      marks: [{ type: "link", attrs: { href: "https://x.example" } }],
    });
  });

  test("bare URLs with parentheses are linked whole; an escaped scheme stays text", () => {
    const wiki = first("See https://en.wikipedia.org/wiki/Foo_(bar) end.").content;
    expect(wiki).toEqual([
      { type: "text", text: "See " },
      {
        type: "text",
        text: "https://en.wikipedia.org/wiki/Foo_(bar)",
        marks: [{ type: "link", attrs: { href: "https://en.wikipedia.org/wiki/Foo_(bar)" } }],
      },
      { type: "text", text: " end." },
    ]);
    expect(first("https://e.com/(x)").content?.[0]?.marks).toEqual([
      { type: "link", attrs: { href: "https://e.com/(x)" } },
    ]);
    expect(first("(see https://e.com/a_(b)).").content?.[1]?.text).toBe("https://e.com/a_(b)");
    expect(first("https\\://x.y/(z)").content).toEqual([{ type: "text", text: "https://x.y/(z)" }]);
  });

  test("sub, sup and underline tags become marks; links without a destination are text", () => {
    expect(first("H<sub>2</sub>O <u>u</u> x<sup>2</sup>").content).toEqual([
      { type: "text", text: "H" },
      { type: "text", text: "2", marks: [{ type: "subsup", attrs: { type: "sub" } }] },
      { type: "text", text: "O " },
      { type: "text", text: "u", marks: [{ type: "underline" }] },
      { type: "text", text: " x" },
      { type: "text", text: "2", marks: [{ type: "subsup", attrs: { type: "sup" } }] },
    ]);
    expect(first("[x]() and [y](<a b>)").content).toEqual([{ type: "text", text: "x and y" }]);
  });
});
