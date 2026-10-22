import { describe, expect, test } from "bun:test";
import {
  formatJson,
  LINE_BUDGET,
  isPretty,
  keepRaw,
  parseFieldList,
  project,
  prune,
  writeDiagnostic,
} from "../../src/core/output.ts";

describe("project", () => {
  const issue = {
    key: "ABC-1",
    fields: { summary: "S", status: { name: "Open", id: "1" }, labels: ["a"] },
    extra: true,
  };

  test("picks top-level and dotted paths from an object", () => {
    expect(project(issue, ["key", "fields.status.name"])).toEqual({
      key: "ABC-1",
      fields: { status: { name: "Open" } },
    });
  });

  test("merges sibling paths under the same parent", () => {
    expect(project(issue, ["fields.summary", "fields.status.id"])).toEqual({
      fields: { summary: "S", status: { id: "1" } },
    });
  });

  test("applies per item when the result has an items array and keeps the envelope", () => {
    const result = { items: [issue, { key: "ABC-2", fields: { summary: "T" } }], nextCursor: "c1" };
    expect(project(result, ["key", "fields.summary"])).toEqual({
      items: [
        { key: "ABC-1", fields: { summary: "S" } },
        { key: "ABC-2", fields: { summary: "T" } },
      ],
      nextCursor: "c1",
    });
  });

  test("omits missing paths and descends into arrays element-wise", () => {
    const value = {
      id: 1,
      comments: [
        { id: "a", body: "x" },
        { id: "b", body: "y" },
      ],
    };
    expect(project(value, ["nope", "comments.id"])).toEqual({
      comments: [{ id: "a" }, { id: "b" }],
    });
  });

  test("does not prototype-pollute through path segments", () => {
    expect(project({ a: 1 }, ["__proto__.x", "constructor.name"])).toEqual({});
  });

  test("projects a top-level array per element", () => {
    expect(project([{ a: 1, b: 2 }, { a: 3 }], ["a"])).toEqual([{ a: 1 }, { a: 3 }]);
  });
});

describe("output formatting", () => {
  test("compact by default, indented when pretty, undefined becomes null", () => {
    expect(formatJson({ a: [1] }, false)).toBe('{"a":[1]}');
    expect(formatJson({ a: 1 }, true)).toBe('{\n  "a": 1\n}');
    expect(formatJson(undefined, false)).toBe("null");
  });

  test("short values are byte-identical to JSON.stringify", () => {
    const value = { items: [{ id: "1", title: "t" }], nextCursor: "c" };
    expect(formatJson(value, false)).toBe(JSON.stringify(value));
    expect(formatJson(value, false)).not.toContain("\n");
  });

  test("a list over the line budget gets one item per line and parses back equal", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ id: index, title: "x".repeat(30) }));
    const text = formatJson({ items, nextCursor: "n" }, false);
    expect(JSON.parse(text)).toEqual({ items, nextCursor: "n" });
    const lines = text.split("\n");
    expect(lines).toHaveLength(items.length + 1);
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(LINE_BUDGET + 68);
    }
    expect(lines[1]).toBe(`${JSON.stringify(items[1])},`);
    expect(text).not.toMatch(/^ /m);
  });

  test("nested large objects break recursively and keep inline what fits", () => {
    const value = {
      id: "9",
      fields: {
        a: "a".repeat(400),
        b: "b".repeat(400),
        small: { k: 1 },
      },
    };
    const text = formatJson(value, false);
    expect(JSON.parse(text)).toEqual(value);
    expect(text.split("\n")).toEqual([
      '{"id":"9",',
      `"fields":{"a":"${"a".repeat(400)}",`,
      `"b":"${"b".repeat(400)}",`,
      '"small":{"k":1}}}',
    ]);
  });

  test("a scalar longer than the budget stays on one line", () => {
    const value = { text: "y".repeat(LINE_BUDGET * 2), n: 1 };
    const text = formatJson(value, false);
    expect(JSON.parse(text)).toEqual(value);
    expect(text.split("\n")).toHaveLength(2);
  });

  test("pretty output keeps its indentation for large values", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ id: index, title: "x".repeat(30) }));
    expect(formatJson(items, true)).toBe(JSON.stringify(items, null, 2));
  });

  test("isPretty honors the flag and ATL_PRETTY", () => {
    expect(isPretty(false, {})).toBe(false);
    expect(isPretty(true, {})).toBe(true);
    expect(isPretty(false, { ATL_PRETTY: "1" })).toBe(true);
    expect(isPretty(false, { ATL_PRETTY: "0" })).toBe(false);
  });

  test("writeDiagnostic emits exactly one JSONL line", () => {
    let written = "";
    writeDiagnostic({ type: "error", code: "x" }, (text) => {
      written += text;
    });
    expect(written).toBe('{"type":"error","code":"x"}\n');
  });

  test("parseFieldList trims and drops empties", () => {
    expect(parseFieldList(" a, b.c ,,d")).toEqual(["a", "b.c", "d"]);
  });
});

describe("prune", () => {
  test("drops null, undefined, empty strings, arrays and objects at every depth", () => {
    const value = {
      id: "1",
      note: null,
      text: "",
      none: undefined,
      list: [],
      obj: {},
      nested: { a: null, b: { c: [], d: "" }, keep: 0, flag: false },
      rows: [{ a: 1, b: null }, { c: "" }, null, [], { d: { e: [] } }],
      nextCursor: null,
    };
    expect(prune(value)).toEqual({
      id: "1",
      nested: { keep: 0, flag: false },
      rows: [{ a: 1 }],
    });
    expect(JSON.stringify(prune(value))).toBe(
      '{"id":"1","nested":{"keep":0,"flag":false},"rows":[{"a":1}]}',
    );
  });

  test("keeps top-level items even when empty, and drops an absent cursor", () => {
    expect(prune({ items: [], nextCursor: null })).toEqual({ items: [] });
    expect(JSON.stringify(prune({ items: [], nextCursor: null }))).toBe('{"items":[]}');
    expect(prune({ items: [{ a: null, b: 1 }], nextCursor: "c" })).toEqual({
      items: [{ b: 1 }],
      nextCursor: "c",
    });
  });

  test("only the top-level items list is exempt", () => {
    expect(prune({ data: { items: [] }, other: 1 })).toEqual({ other: 1 });
  });

  test("array elements keep empty strings (argv words in `next`)", () => {
    expect(prune({ next: [["atl", "search", ""]] })).toEqual({ next: [["atl", "search", ""]] });
  });

  test("keepRaw payloads are returned untouched, including nested empties", () => {
    const raw = { a: null, b: [], c: { d: "" } };
    expect(prune({ result: keepRaw(raw), gone: null })).toEqual({ result: raw });
    expect(prune(keepRaw(raw))).toBe(raw);
    expect(JSON.stringify(raw)).toBe('{"a":null,"b":[],"c":{"d":""}}');
  });

  test("scalars and null pass through; the input is not mutated", () => {
    expect(prune(null)).toBeNull();
    expect(prune(5)).toBe(5);
    const input = { a: null, b: { c: "" } };
    prune(input);
    expect(input).toEqual({ a: null, b: { c: "" } });
  });

  test("error diagnostics keep their fields but drop empties", () => {
    let written = "";
    writeDiagnostic({ type: "error", code: "x", hint: "", next: [], status: undefined }, (text) => {
      written += text;
    });
    expect(written).toBe('{"type":"error","code":"x"}\n');
  });
});
