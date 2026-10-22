import { describe, expect, test } from "bun:test";
import { Type } from "../../src/core/schema.ts";
import { check, firstIssue } from "../../src/core/validate.ts";

const schema = Type.Object({
  name: Type.String({ minLength: 2 }),
  mode: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("adf")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  ratio: Type.Optional(Type.Number()),
  flag: Type.Optional(Type.Boolean()),
  nothing: Type.Optional(Type.Null()),
  tags: Type.Optional(Type.Array(Type.String())),
  sites: Type.Optional(
    Type.Record(Type.String(), Type.Object({ url: Type.String(), n: Type.Number() })),
  ),
  any: Type.Optional(Type.Unknown()),
  version: Type.Optional(Type.Literal(1)),
});

const strict = Type.Object({ a: Type.String() }, { additionalProperties: false });

type Expected = { path: string; keyword: string; message: string } | undefined;

const cases: [string, unknown, Expected][] = [
  ["ok", { name: "ab" }, undefined],
  [
    "full",
    { name: "ab", mode: "md", limit: 3, ratio: 0.5, flag: true, nothing: null, tags: ["x"] },
    undefined,
  ],
  ["not an object", 1, { path: "", keyword: "type", message: "must be object" }],
  ["array root", [], { path: "", keyword: "type", message: "must be object" }],
  ["null root", null, { path: "", keyword: "type", message: "must be object" }],
  [
    "missing required",
    {},
    { path: "", keyword: "required", message: "must have required properties name" },
  ],
  [
    "short string",
    { name: "a" },
    { path: "/name", keyword: "minLength", message: "must not have fewer than 2 characters" },
  ],
  [
    "astral string counts one code point",
    { name: "😀" },
    { path: "/name", keyword: "minLength", message: "must not have fewer than 2 characters" },
  ],
  [
    "bad literal union",
    { name: "ab", mode: "storage" },
    { path: "/mode", keyword: "const", message: "must be equal to constant" },
  ],
  [
    "below minimum",
    { name: "ab", limit: 0 },
    { path: "/limit", keyword: "minimum", message: "must be >= 1" },
  ],
  [
    "above maximum",
    { name: "ab", limit: 6 },
    { path: "/limit", keyword: "maximum", message: "must be <= 5" },
  ],
  [
    "non-integer",
    { name: "ab", limit: 1.5 },
    { path: "/limit", keyword: "type", message: "must be integer" },
  ],
  [
    "NaN number",
    { name: "ab", ratio: Number.NaN },
    { path: "/ratio", keyword: "type", message: "must be number" },
  ],
  [
    "Infinity number",
    { name: "ab", ratio: Number.POSITIVE_INFINITY },
    { path: "/ratio", keyword: "type", message: "must be number" },
  ],
  [
    "wrong boolean",
    { name: "ab", flag: "true" },
    { path: "/flag", keyword: "type", message: "must be boolean" },
  ],
  [
    "wrong null",
    { name: "ab", nothing: 0 },
    { path: "/nothing", keyword: "type", message: "must be null" },
  ],
  [
    "array item",
    { name: "ab", tags: ["x", 2] },
    { path: "/tags/1", keyword: "type", message: "must be string" },
  ],
  [
    "array not array",
    { name: "ab", tags: "x" },
    { path: "/tags", keyword: "type", message: "must be array" },
  ],
  ["record ok", { name: "ab", sites: { a: { url: "u", n: 1 } } }, undefined],
  [
    "record value shape",
    { name: "ab", sites: { "a/b~c": { url: "u" } } },
    {
      path: "/sites/a~1b~0c",
      keyword: "required",
      message: "must have required properties n",
    },
  ],
  [
    "record not object",
    { name: "ab", sites: [] },
    { path: "/sites", keyword: "type", message: "must be object" },
  ],
  ["unknown any", { name: "ab", any: { deep: [1] } }, undefined],
  [
    "literal number",
    { name: "ab", version: 2 },
    { path: "/version", keyword: "const", message: "must be equal to constant" },
  ],
  ["undefined optional", { name: "ab", mode: undefined }, undefined],
  [
    "undefined required",
    { name: undefined },
    { path: "/name", keyword: "type", message: "must be string" },
  ],
  [
    "null optional",
    { name: "ab", mode: null },
    { path: "/mode", keyword: "type", message: "must be string" },
  ],
  ["extra keys allowed", { name: "ab", extra: 1 }, undefined],
];

describe("validate", () => {
  test.each(cases)("%s", (_label, value, expected) => {
    expect(check(schema, value)).toBe(expected === undefined);
    const issue = firstIssue(schema, value);
    expect(issue && { path: issue.path, keyword: issue.keyword, message: issue.message }).toEqual(
      expected,
    );
  });

  test("lists every missing required property", () => {
    const two = Type.Object({
      a: Type.String(),
      b: Type.String(),
      c: Type.Optional(Type.String()),
    });
    expect(firstIssue(two, {})?.missing).toEqual(["a", "b"]);
  });

  test("additionalProperties: false rejects extra keys at their path", () => {
    expect(check(strict, { a: "x" })).toBe(true);
    expect(check(strict, { a: "x", q: 1 })).toBe(false);
    expect(firstIssue(strict, { a: "x", q: 1 })?.path).toBe("/q");
  });

  test("builders emit plain JSON Schema with required keys", () => {
    const shared = Type.String();
    const built = Type.Object({ a: Type.Optional(shared), b: shared });
    expect(JSON.stringify(built)).toBe(
      '{"type":"object","required":["b"],"properties":{"a":{"type":"string"},"b":{"type":"string"}}}',
    );
    expect(JSON.stringify(Type.Object({ x: Type.Optional(Type.Unknown()) }))).toBe(
      '{"type":"object","properties":{"x":{}}}',
    );
  });
});
