import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  formatJson,
  LINE_BUDGET,
  isPretty,
  keepRaw,
  project,
  prune,
  quietOnClosedStdout,
  splitList,
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

  test("a list item without the path stays in the list as {} through prune", () => {
    const result = {
      items: [{ key: "A-1", parent: { key: "A-0" } }, { key: "A-2" }],
      nextCursor: "c",
    };
    expect(prune(project(result, ["parent.key"]))).toEqual({
      items: [{ parent: { key: "A-0" } }, {}],
      nextCursor: "c",
    });
    expect(prune(project([{ a: 1 }, { b: 2 }], ["a"]))).toEqual([{ a: 1 }, {}]);
  });

  test("asking only for envelope fields drops the items instead of printing {} placeholders", () => {
    const result = { items: [{ seconds: 1 }, { seconds: 2 }], totalSeconds: 3, nextCursor: "c" };
    expect(prune(project(result, ["totalSeconds"]))).toEqual({ totalSeconds: 3, nextCursor: "c" });
    expect(prune(project(result, ["totalSeconds", "seconds"]))).toEqual({
      items: [{ seconds: 1 }, { seconds: 2 }],
      totalSeconds: 3,
      nextCursor: "c",
    });
  });

  test("an items. prefix addresses the items, unless items carry their own items field", () => {
    const result = { items: [{ key: "A-1", n: 1 }, { key: "A-2" }], nextCursor: "c" };
    expect(project(result, ["items.key"])).toEqual({
      items: [{ key: "A-1" }, { key: "A-2" }],
      nextCursor: "c",
    });
    const nested = { items: [{ items: [{ id: 1, x: 2 }], id: 9 }] };
    expect(project(nested, ["items.id"])).toEqual({ items: [{ items: [{ id: 1 }] }] });
  });

  test("numeric segments index arrays and keep the index as the key", () => {
    const value = { tiers: [{ rps: 1 }, { limits: { burst: { rps: 340 } } }] };
    expect(project(value, ["tiers.1.limits.burst.rps"])).toEqual({
      tiers: { "1": { limits: { burst: { rps: 340 } } } },
    });
    expect(project(value, ["tiers.5.rps"])).toEqual({});
  });

  test("values picked out of a raw payload keep nulls and empties through prune", () => {
    const raw = keepRaw({ value: { fallback: { chain: ["a", ["b", { d: null }]], none: [] } } });
    expect(prune(project(raw, ["value.fallback"]))).toEqual({
      value: { fallback: { chain: ["a", ["b", { d: null }]], none: [] } },
    });
    expect(prune(project(raw, ["value.fallback.chain", "value.fallback.none"]))).toEqual({
      value: { fallback: { chain: ["a", ["b", { d: null }]], none: [] } },
    });
  });

  test("paths that match nothing in the whole result are reported once", () => {
    const reported: string[][] = [];
    const onUnmatched = (paths: string[]) => reported.push(paths);
    project({ items: [{ key: "A" }, { key: "B", n: 1 }] }, ["key", "n", "nope"], onUnmatched);
    expect(reported).toEqual([["nope"]]);
    reported.length = 0;
    project({ items: [{ key: "A" }] }, ["key"], onUnmatched);
    project({ items: [] }, ["key"], onUnmatched);
    project({ items: [{ key: "A" }], nextCursor: "c" }, ["nextCursor"], onUnmatched);
    project({ comments: [{ id: 1 }] }, ["comments.nope"], onUnmatched);
    expect(reported).toEqual([["comments.nope"]]);
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

  test("a line whose enclosing brackets would pass the budget is split", () => {
    // 699 bytes inline fit, but the `]}` that close the list land on the same line: 701 bytes.
    const last = { a: "x".repeat(300), b: "y".repeat(384) };
    expect(Buffer.byteLength(JSON.stringify(last))).toBe(LINE_BUDGET - 1);
    const value = { items: [{ id: "first" }, last] };
    const text = formatJson(value, false);
    expect(JSON.parse(text)).toEqual(value);
    for (const line of text.split("\n")) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(LINE_BUDGET);
    }
  });

  test("invisible characters are escaped and parse back identical", () => {
    const value = {
      id: "ACME\u200B-7731",
      title: "Restart\u00A0Procedure\u00AD",
      flip: "a\u202Eb\u2066c\u2069\uFEFF\u180E\u2060\u2064\u200F\u2028",
      tag: "x\u{E0041}",
      "k\u200Dey": "plain é 日本",
    };
    for (const pretty of [false, true]) {
      const text = formatJson(value, pretty);
      expect(text).not.toMatch(
        /[\u00A0\u00AD\u180E\u2000-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/u,
      );
      expect(text).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
      expect(JSON.parse(text)).toEqual(value);
    }
    expect(formatJson({ a: "x\u200By" }, false)).toBe('{"a":"x\\u200by"}');
    expect(formatJson({ a: "plain é 日本" }, false)).toBe('{"a":"plain é 日本"}');
  });

  test("escaped characters count at their escaped width when splitting", () => {
    const value = { items: Array.from({ length: 6 }, () => ({ t: "\u200B".repeat(100) })) };
    for (const line of formatJson(value, false).split("\n")) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(LINE_BUDGET);
    }
  });

  test("a closed stdout (EPIPE) is ignored, any other stream error stays fatal", () => {
    const stream = new EventEmitter();
    quietOnClosedStdout(stream);
    expect(() =>
      stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(() => stream.emit("error", Object.assign(new Error("io"), { code: "EIO" }))).toThrow(
      "io",
    );
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

  test("splitList trims and drops empties", () => {
    expect(splitList(" a, b.c ,,d")).toEqual(["a", "b.c", "d"]);
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
