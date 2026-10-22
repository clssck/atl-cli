import { describe, expect, test } from "bun:test";
import { BODY_LINE_BYTES, bodyLines, renderAdf } from "../../src/commands/common.ts";
import { adfToMarkdown, type AdfDoc } from "../../src/adf/index.ts";
import { formatJson, LINE_BUDGET, prune } from "../../src/core/output.ts";

function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

function words(count: number, word = "lorem"): string {
  return Array.from({ length: count }, (_, index) => `${word}${index}`).join(" ");
}

describe("bodyLines", () => {
  test("an empty body is an empty array, which prune drops", () => {
    expect(bodyLines("")).toEqual([]);
    expect(prune({ id: "1", body: bodyLines("") })).toEqual({ id: "1" });
  });

  test("a short body is still an array: one element per line, blank lines kept", () => {
    expect(bodyLines("Hello")).toEqual(["Hello"]);
    expect(bodyLines("# Title\n\nfirst\nsecond")).toEqual(["# Title", "", "first", "second"]);
  });

  test("round trip: joining with a newline restores the markdown when nothing was wrapped", () => {
    const markdown =
      "# Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```";
    expect(bodyLines(markdown).join("\n")).toBe(markdown);
  });

  test("a prose line over the byte budget is soft-wrapped at spaces without losing words", () => {
    const line = words(400);
    expect(jsonBytes(line)).toBeGreaterThan(BODY_LINE_BYTES);
    const lines = bodyLines(line);
    expect(lines.length).toBeGreaterThan(1);
    for (const piece of lines) {
      expect(jsonBytes(piece)).toBeLessThanOrEqual(BODY_LINE_BYTES);
      expect(piece.startsWith(" ") || piece.endsWith(" ")).toBe(false);
    }
    expect(lines.join(" ")).toBe(line);
  });

  test("the budget counts UTF-8 bytes after JSON escaping, not characters", () => {
    const line = Array.from({ length: 60 }, (_, index) => `日本語${index}"q"`).join(" ");
    expect(line.length).toBeLessThan(BODY_LINE_BYTES);
    expect(jsonBytes(line)).toBeGreaterThan(BODY_LINE_BYTES);
    const lines = bodyLines(line);
    expect(lines.length).toBeGreaterThan(1);
    for (const piece of lines) {
      expect(jsonBytes(piece)).toBeLessThanOrEqual(BODY_LINE_BYTES);
    }
    expect(lines.join(" ")).toBe(line);
  });

  test("a wrap never starts a line with a block marker", () => {
    const filler = words(95);
    for (const marker of ["-", "1.", "#", ">", "---", "```", "|", "<div>"]) {
      const line = `${filler} ${marker} tail ${words(120)}`;
      const lines = bodyLines(line);
      expect(lines.join(" ")).toBe(line);
      for (const piece of lines.slice(1)) {
        expect(/^(?:#{1,6}$|[-+*]$|>|\||\d+[.)]$|`{3,}|~{3,}|-{2,}$|<)/.test(piece)).toBe(false);
      }
    }
  });

  test("fenced code is never wrapped; an over-long line is hard-split between code points", () => {
    const long = `const text = "${words(200)}";`;
    const markdown = `intro\n\n\`\`\`ts\n${long}\n\`\`\`\n\nafter`;
    const lines = bodyLines(markdown);
    const open = lines.indexOf("```ts");
    expect(lines.slice(0, open + 1)).toEqual(["intro", "", "```ts"]);
    const close = lines.lastIndexOf("```");
    expect(lines.slice(close)).toEqual(["```", "", "after"]);
    const code = lines.slice(open + 1, close);
    expect(code.length).toBeGreaterThan(1);
    for (const piece of code) {
      expect(jsonBytes(piece)).toBeLessThanOrEqual(BODY_LINE_BYTES);
    }
    expect(code.join("")).toBe(long);
  });

  test("a short fenced line with spaces stays one element, and a long prose line after the fence wraps", () => {
    const lines = bodyLines(`~~~\na  b   c\n~~~\n${words(300)}`);
    expect(lines.slice(0, 3)).toEqual(["~~~", "a  b   c", "~~~"]);
    expect(lines.length).toBeGreaterThan(4);
  });

  test("a fence only closes on the same character with at least the opening length", () => {
    const long = words(200);
    const lines = bodyLines(`\`\`\`\`\n\`\`\`\n${long}\n\`\`\`\``);
    expect(lines.slice(0, 2)).toEqual(["````", "```"]);
    expect(lines.at(-1)).toBe("````");
    expect(lines.slice(2, -1).join("")).toBe(long);
  });

  test("table rows and headings are not wrapped; an over-long one is hard-split", () => {
    const row = `| ${words(150, "cell")} | b |`;
    const heading = `## ${words(150, "head")}`;
    for (const line of [row, heading]) {
      const lines = bodyLines(line);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.join("")).toBe(line);
      for (const piece of lines) {
        expect(jsonBytes(piece)).toBeLessThanOrEqual(BODY_LINE_BYTES);
      }
    }
    expect(bodyLines("| a | b |\n| --- | --- |")).toEqual(["| a | b |", "| --- | --- |"]);
  });

  test("an unbreakable token is hard-split without cutting a surrogate pair", () => {
    const token = "😀".repeat(400);
    const lines = bodyLines(`see ${token} end`);
    for (const piece of lines) {
      expect(jsonBytes(piece)).toBeLessThanOrEqual(BODY_LINE_BYTES);
      expect(piece).toBe(piece.toWellFormed());
    }
    expect(lines.join(" ").replaceAll(" ", "")).toBe(`see${token}end`);
  });

  test("a trailing hard-break marker stays on the last piece and the indent on the first", () => {
    const line = `  ${words(300)}  `;
    const lines = bodyLines(line);
    expect(lines[0]?.startsWith("  l")).toBe(true);
    expect(lines.at(-1)?.endsWith("  ")).toBe(true);
  });

  test("every element prints on a line under the stdout budget", () => {
    const markdown = [words(500), "", "```", `x ${words(200)}`, "```"].join("\n");
    const text = formatJson(prune({ id: "1", body: bodyLines(markdown) }), false);
    for (const line of text.split("\n")) {
      expect(Buffer.byteLength(line)).toBeLessThan(LINE_BUDGET);
    }
    const parsed: { body: string[] } = JSON.parse(text);
    expect(Array.isArray(parsed.body)).toBe(true);
    expect(parsed.body.length).toBeGreaterThan(5);
  });
});

describe("renderAdf", () => {
  const doc: AdfDoc = {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: words(300) }] }],
  };

  test("md renders lines; adf returns the parsed document", () => {
    const lines = renderAdf(doc, "md");
    expect(Array.isArray(lines)).toBe(true);
    expect(Array.isArray(lines) ? lines.join(" ") : "").toBe(adfToMarkdown(doc));
    expect(renderAdf(doc, "adf")).toEqual(doc);
  });
});
