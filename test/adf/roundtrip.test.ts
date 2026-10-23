import { describe, expect, test } from "bun:test";
import { adfToMarkdown, markdownToAdf } from "../../src/adf/index.ts";
import type { AdfNode } from "../../src/adf/index.ts";

const REPRESENTATIVE = `# 1. Project **Plan**

## Overview

Intro with *emphasis*, **strong**, ~~strike~~, \`inline code\`, a [link with \\[brackets\\]](https://example.com/a_(b)) and <https://auto.example.com>.
Second line after a soft break.\\
After a hard break.

1. 1. Not a heading but literal text
2. Second item
   - nested bullet
     - deeper bullet
   - sibling bullet

3. Starts at three
4. Four

- [ ] open task
- [x] finished task
  - [ ] nested task

\`\`\`ts
const answer: number = 42;
\`\`\`

> quoted text
> with *emphasis*

---

| Name | Value |
| --- | --- |
| alpha | 1 |
| beta | a\\|b |

Literal \\* star, \\_ underscore, \\# hash, 1\\. dot, and snake_case_word.
`;

describe("markdown -> ADF -> markdown", () => {
  test("is stable after one pass for a representative document", () => {
    const once = adfToMarkdown(markdownToAdf(REPRESENTATIVE));
    const twice = adfToMarkdown(markdownToAdf(once));
    expect(twice).toBe(once);
  });

  test("the second pass preserves the ADF structure (modulo generated localIds)", () => {
    const first = markdownToAdf(REPRESENTATIVE);
    const second = markdownToAdf(adfToMarkdown(first));
    expect(stripIds(second)).toBe(stripIds(first));
  });

  test("lists followed by task lists and code fences are byte-stable", () => {
    const markdown = `- outer one
- outer two

- [ ] todo item
- [x] done item

- outer
  - inner

- [ ] after nested
- [x] also done

\`\`\`ts
const x = 1;
\`\`\`
`;
    expect(`${adfToMarkdown(markdownToAdf(markdown))}\n`).toBe(markdown);
  });

  test("a heading like `1. Intro` stays a heading in both directions", () => {
    const adf = markdownToAdf("# 1. Intro");
    expect(adf.content.map((node) => node.type)).toEqual(["heading"]);
    expect(adf.content[0]?.content).toEqual([{ type: "text", text: "1. Intro" }]);
    const markdown = adfToMarkdown(adf);
    expect(markdown).toBe("# 1. Intro");
    expect(markownTypes(markdown)).toEqual(["heading"]);
  });

  test("a paragraph that starts with `1. ` stays a paragraph", () => {
    const markdown = adfToMarkdown({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "1. Intro" }] }],
    });
    expect(markdownToAdf(markdown).content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "1. Intro" }] },
    ]);
  });

  test("link text containing brackets round-trips", () => {
    const adf = markdownToAdf("[a [b] c](https://x.y)");
    const markdown = adfToMarkdown(adf);
    expect(markdown).toBe("[a \\[b\\] c](https://x.y)");
    expect(markdownToAdf(markdown)).toEqual(adf);
  });

  test("text that would otherwise be syntax survives a trip through markdown", () => {
    const samples = [
      "*not em*",
      "_not em_",
      "`not code`",
      "[not](a link)",
      "# not heading",
      "> not quote",
      "- not list",
      "+ not list",
      "1) not list",
      "---",
      "===",
      "<div>not html</div>",
      "&amp; not entity",
      "https://not.a.link/path",
      "www.example.com",
      "mail me@example.com",
      "~~not strike~~",
      "a | b",
      "back\\slash",
      "![not](image)",
    ];
    for (const sample of samples) {
      const adf = {
        type: "doc" as const,
        version: 1 as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: sample }] }],
      };
      expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
    }
  });

  test("marks round-trip through their markdown forms", () => {
    const link = { type: "link", attrs: { href: "https://x.y" } };
    const adf = {
      type: "doc" as const,
      version: 1 as const,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "both", marks: [{ type: "strong" }, { type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "em-link", marks: [link, { type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "a`b", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            { type: "text", text: "gone", marks: [{ type: "strike" }] },
          ],
        },
      ],
    };
    const roundTripped = markdownToAdf(adfToMarkdown(adf));
    expect(normalize(roundTripped)).toBe(normalize(adf));
  });

  test("marks next to punctuation or a word re-parse to the same marks", () => {
    const strike = [{ type: "strike" }];
    const strong = [{ type: "strong" }];
    const em = [{ type: "em" }];
    const cases: { text: string; marks?: { type: string }[] }[][] = [
      // `**` then em then a digit: `_i_1` would not close.
      [{ text: "**" }, { text: "i", marks: em }, { text: "1" }],
      // intraword and punctuation-edge strike, which `~~` cannot express
      [{ text: "a" }, { text: "b", marks: strike }, { text: "c" }],
      [{ text: "1" }, { text: "(x)", marks: strike }, { text: "é" }],
      // strong whose content starts or ends with punctuation beside a word
      [{ text: "Name" }, { text: ":", marks: strong }, { text: " value" }],
      [{ text: "a" }, { text: '"q"', marks: strong }, { text: "b" }],
      [{ text: "x" }, { text: "y z", marks: [{ type: "strong" }, { type: "em" }] }, { text: "w" }],
      [{ text: "word" }, { text: ",", marks: em }, { text: " next" }],
    ];
    for (const content of cases) {
      const adf = {
        type: "doc" as const,
        version: 1 as const,
        content: [
          {
            type: "paragraph",
            content: content.map(({ text, marks }) =>
              marks === undefined ? { type: "text", text } : { type: "text", text, marks },
            ),
          },
        ],
      };
      expect(normalize(markdownToAdf(adfToMarkdown(adf)))).toBe(normalize(adf));
    }
  });

  test("plain delimiters stay when they re-parse, tags only where they would not", () => {
    const cases: [AdfNode[], string][] = [
      [
        [
          { type: "text", text: "a " },
          { type: "text", text: "b", marks: [{ type: "strike" }] },
          { type: "text", text: " c" },
        ],
        "a ~~b~~ c",
      ],
      [
        [
          { type: "text", text: "a" },
          { type: "text", text: "b", marks: [{ type: "strike" }] },
          { type: "text", text: "c" },
        ],
        "a<del>b</del>c",
      ],
      [
        [
          { type: "text", text: "a" },
          { type: "text", text: "b", marks: [{ type: "strong" }] },
          { type: "text", text: "c" },
        ],
        "a**b**c",
      ],
    ];
    for (const [content, markdown] of cases) {
      expect(
        adfToMarkdown({ type: "doc", version: 1, content: [{ type: "paragraph", content }] }),
      ).toBe(markdown);
    }
  });

  test("a leading or trailing no-break space is content, not blank", () => {
    const adf = {
      type: "doc" as const,
      version: 1 as const,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "\u00A0\u00A0indented\u00A0" }] },
      ],
    };
    expect(markdownToAdf(adfToMarkdown(adf))).toEqual(adf);
  });
});

function markownTypes(markdown: string): string[] {
  return markdownToAdf(markdown).content.map((node) => node.type);
}

function stripIds(value: unknown): string {
  return JSON.stringify(value).replaceAll(/"localId":"[^"]+"/g, '"localId":"_"');
}

function normalize(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) =>
    key === "marks" && Array.isArray(v) ? [...v].map((m) => JSON.stringify(m)).toSorted() : v,
  );
}
