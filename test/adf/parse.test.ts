import { describe, expect, test } from "bun:test";
import { AtlError } from "../../src/core/errors.ts";
import { parseAdfBody } from "../../src/adf/index.ts";

function failure(run: () => unknown): AtlError {
  try {
    run();
  } catch (error) {
    if (error instanceof AtlError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parseAdfBody to throw");
}

describe("parseAdfBody", () => {
  test("parses the JSON string Confluence v2 returns", () => {
    const value = JSON.stringify({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });
    expect(parseAdfBody(value)).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });
  });

  test("passes through an object (Jira v3) and normalises version and content", () => {
    expect(parseAdfBody({ type: "doc", version: 1, content: [] })).toEqual({
      type: "doc",
      version: 1,
      content: [],
    });
    expect(parseAdfBody('{"type":"doc"}')).toEqual({ type: "doc", version: 1, content: [] });
  });

  test("invalid JSON is an api error with code adf_parse_error", () => {
    const error = failure(() => parseAdfBody("{not json"));
    expect(error.code).toBe("adf_parse_error");
    expect(error.category).toBe("api");
    expect(error.exitCode).toBe(2);
  });

  test("valid JSON that is not an ADF doc is rejected with the same code", () => {
    for (const value of [
      '"text"',
      "42",
      "null",
      "[]",
      '{"type":"paragraph"}',
      '{"type":"doc","content":"x"}',
    ]) {
      const error = failure(() => parseAdfBody(value));
      expect(error.code).toBe("adf_parse_error");
      expect(error.category).toBe("api");
    }
  });
});
