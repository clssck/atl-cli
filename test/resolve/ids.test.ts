import { describe, expect, test } from "bun:test";
import { AtlError } from "../../src/core/errors.ts";
import {
  decodeTinyLink,
  encodeTinyLink,
  parseAnyRef,
  parseConfluenceRef,
  parseJiraRef,
  parseDisplayLink,
  parseSite,
  parseSpaceRef,
} from "../../src/resolve/index.ts";
import type { ConfluenceRef } from "../../src/resolve/index.ts";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AtlError);
    expect(error).toMatchObject({ code, category: "input" });
    return;
  }
  throw new Error(`expected ${code}`);
}

const S = "acme.atlassian.net";

describe("parseSite", () => {
  test.each([
    ["acme", S],
    ["ACME", S],
    ["acme.atlassian.net", S],
    ["https://acme.atlassian.net", S],
    ["https://acme.atlassian.net/wiki/spaces/X/pages/1", S],
    ["https://acme.atlassian.net/browse/X-1", S],
    ["https://wiki.example.com/foo", "wiki.example.com"],
  ])("%s", (input, want) => expect(parseSite(input)).toBe(want));

  test.each(["", "not a site", "acme_.net!", "https://"])("invalid %p", (input) =>
    expectCode(() => parseSite(input), "invalid_site"),
  );
});

describe("tiny links", () => {
  test("decode vector", () => {
    expect(decodeTinyLink("Fc1bBw")).toBe("123456789");
    expect(encodeTinyLink(123456789)).toBe("Fc1bBw");
  });
  test.each(["123456789", "67623913027", "4294967295", "1", "4398046511103"])(
    "round-trip %s",
    (id) => expect(decodeTinyLink(encodeTinyLink(id))).toBe(id),
  );
  test("alphabet variants", () => {
    const tiny = encodeTinyLink("4294967295");
    expect(tiny).toBe("-----w");
    expect(decodeTinyLink("/////w")).toBe("4294967295");
    expect(decodeTinyLink("-----w=")).toBe("4294967295");
    expect(decodeTinyLink("_____w")).toBe(decodeTinyLink("+++++w"));
  });
  test.each(["", "A", "Fc1b!w", "AAAAAAAAAAAAA", "ZZZZZZZZ", "__________w"])(
    "invalid %p",
    (input) => expectCode(() => decodeTinyLink(input), "invalid_tiny_link"),
  );
  test("invalid encode", () => expectCode(() => encodeTinyLink("abc"), "invalid_tiny_link"));
});

describe("parseConfluenceRef", () => {
  const base = `https://${S}/wiki`;
  test.each<[string, ConfluenceRef]>([
    ["12345", { kind: "page", id: "12345" }],
    [`${base}/spaces/ENG/pages/12345`, { kind: "page", id: "12345", site: S, spaceKey: "ENG" }],
    [
      `${base}/spaces/ENG/pages/12345/My+Title`,
      { kind: "page", id: "12345", site: S, spaceKey: "ENG" },
    ],
    [
      `${base}/spaces/ENG/pages/edit-v2/12345`,
      { kind: "page", id: "12345", site: S, spaceKey: "ENG" },
    ],
    [
      `${base}/spaces/ENG/blog/2024/05/06/777/Post`,
      { kind: "blogpost", id: "777", site: S, spaceKey: "ENG" },
    ],
    [`${base}/spaces/ENG/blog/777`, { kind: "blogpost", id: "777", site: S, spaceKey: "ENG" }],
    [`${base}/pages/viewpage.action?pageId=999`, { kind: "unknown-content", id: "999", site: S }],
    [`${base}/x/Fc1bBw`, { kind: "unknown-content", id: "123456789", site: S }],
    [
      `${base}/pages/viewpage.action?pageId=999&pageVersion=20`,
      { kind: "unknown-content", id: "999", site: S, version: 20 },
    ],
    [
      `${base}/spaces/ENG/pages/12345/T?pageVersion=7`,
      { kind: "page", id: "12345", site: S, spaceKey: "ENG", version: 7 },
    ],
    [`${base}/spaces/ENG/history/12345`, { kind: "page", id: "12345", site: S, spaceKey: "ENG" }],
    [`${base}/pages/resumedraft.action?draftId=42`, { kind: "unknown-content", id: "42", site: S }],
    [
      `${base}/spaces/ENG/pages/12345/Q&A+100%+quotes`,
      { kind: "page", id: "12345", site: S, spaceKey: "ENG" },
    ],
    [`<${base}/spaces/ENG/pages/12345/T>`, { kind: "page", id: "12345", site: S, spaceKey: "ENG" }],
    [
      `[the page](${base}/spaces/ENG/pages/12345/T)`,
      { kind: "page", id: "12345", site: S, spaceKey: "ENG" },
    ],
    [
      `${base}/spaces/ENG/pages/12345/T?focusedCommentId=55#comment-55`,
      { kind: "page", id: "12345", site: S, spaceKey: "ENG", commentId: "55" },
    ],
    ["ari:cloud:confluence:abc-123:page/42", { kind: "page", id: "42", cloudId: "abc-123" }],
    [
      "ari:cloud:confluence:abc-123:blogpost/42",
      { kind: "blogpost", id: "42", cloudId: "abc-123" },
    ],
    ["ari:cloud:confluence:abc-123:comment/42", { kind: "comment", id: "42", cloudId: "abc-123" }],
    [
      "ari:cloud:confluence:abc-123:content/42",
      { kind: "unknown-content", id: "42", cloudId: "abc-123" },
    ],
  ])("%s", (input, want) => expect(parseConfluenceRef(input)).toEqual(want));

  test.each([
    "hello",
    `${base}/spaces/ENG/overview`,
    "ari:cloud:jira:abc:issue/1",
    "ari:cloud:confluence:abc:space/1",
  ])("invalid %p", (input) => expectCode(() => parseConfluenceRef(input), "invalid_content_ref"));
  test("bad tiny", () => expectCode(() => parseConfluenceRef(`${base}/x/!!`), "invalid_tiny_link"));
  test("an out-of-range tiny link is rejected", () =>
    expectCode(() => parseConfluenceRef(`${base}/x/ZZZZZZZZ`), "invalid_tiny_link"));
  test("a legacy /display/ link has no id and points at the title lookup", () => {
    try {
      parseConfluenceRef(`${base}/display/ENG/My+Title`);
    } catch (error) {
      expect(error).toBeInstanceOf(AtlError);
      expect(error instanceof AtlError && error.code).toBe("invalid_content_ref");
      expect(error instanceof AtlError && error.hint).toContain("space pages");
      return;
    }
    throw new Error("expected invalid_content_ref");
  });
});

describe("a page title is not a reference", () => {
  test("the error points at the title lookups", () => {
    try {
      parseConfluenceRef("atl smoke nm corp Release Process");
    } catch (error) {
      expect(error instanceof AtlError && error.code).toBe("invalid_content_ref");
      expect(error instanceof AtlError && error.hint).toContain("space pages <SPACE> --title");
      expect(error instanceof AtlError && error.hint).toContain("cql");
      return;
    }
    throw new Error("expected invalid_content_ref");
  });
});

describe("parseJiraRef", () => {
  const base = `https://${S}`;
  test.each([
    ["ABC-123", { key: "ABC-123" }],
    ["abc-123", { key: "ABC-123" }],
    ["A_B2-7", { key: "A_B2-7" }],
    ["10001", { id: "10001" }],
    [`${base}/browse/abc-1`, { key: "ABC-1", site: S }],
    [`${base}/jira/software/c/projects/XY/boards/1?selectedIssue=XY-9`, { key: "XY-9", site: S }],
    [`${base}/jira/software/c/projects/XY/issues/XY-12`, { key: "XY-12", site: S }],
    [`${base}/jira/servicedesk/projects/SD/queues/custom/1/SD-4`, { key: "SD-4", site: S }],
    ["ari:cloud:jira:cid:issue/10001", { id: "10001", cloudId: "cid" }],
  ])("%s", (input, want) => expect(parseJiraRef(input)).toEqual(want));

  test.each([
    "A-1",
    "1ABC-1",
    "ABC-",
    "ari:cloud:jira:cid:project/1",
    `${base}/wiki/spaces/X`,
    "nope",
  ])("invalid %p", (input) => expectCode(() => parseJiraRef(input), "invalid_issue_ref"));
});

describe("parseAnyRef", () => {
  test.each([
    ["ari:cloud:confluence:c:page/1", "confluence"],
    ["ari:cloud:jira:c:issue/1", "jira"],
    [`https://${S}/wiki/spaces/X/pages/1`, "confluence"],
    [`https://${S}/browse/XY-1`, "jira"],
    [`https://${S}/jira/software/c/projects/XY/issues/XY-1`, "jira"],
    ["xy-5", "jira"],
  ] as [string, string][])("%s", (input, product) =>
    expect<string>(parseAnyRef(input).product).toBe(product),
  );

  test("numeric is ambiguous", () => expectCode(() => parseAnyRef("123"), "ambiguous_ref"));
  test.each(["junk", "ari:cloud:bitbucket:c:repo/1", "https://example.com/other"])(
    "invalid %p",
    (input) => expectCode(() => parseAnyRef(input), "invalid_ref"),
  );
});

describe("references pasted from chat and docs", () => {
  const page = `https://${S}/wiki/spaces/ENG/pages/12345/Title`;
  test.each([
    [`<${page}>`, "confluence"],
    [`[title](${page})`, "confluence"],
    [`${page}:`, "confluence"],
    ["KAN-1:", "jira"],
    ["[KAN-1]", "jira"],
    [`<https://${S}/browse/KAN-1>`, "jira"],
  ] as [string, string][])("%s", (input, product) =>
    expect<string>(parseAnyRef(input).product).toBe(product),
  );

  test("wrapped Jira keys parse to the key", () => {
    expect(parseJiraRef("[kan-7]")).toEqual({ key: "KAN-7" });
    expect(parseJiraRef(`[x](https://${S}/browse/KAN-7)`)).toEqual({ key: "KAN-7", site: S });
  });

  test("a raw % in a path is not a crash", () => {
    expect(parseJiraRef(`https://${S}/browse/KAN-7?x=100%`)).toEqual({ key: "KAN-7", site: S });
    expectCode(() => parseJiraRef(`https://${S}/browse/KAN-274%`), "invalid_issue_ref");
    expect(parseSpaceRef(`https://${S}/wiki/spaces/E%/overview`)).toEqual({ key: "E%" });
  });
});

describe("parseDisplayLink", () => {
  test("decodes space and title; + is a space, %2B a plus", () => {
    expect(parseDisplayLink(`https://${S}/wiki/display/ENG/C%2B%2B+Style%3A+Guide`)).toEqual({
      site: S,
      spaceKey: "ENG",
      title: "C++ Style: Guide",
    });
  });
  test("personal space keys and wrappers", () => {
    expect(parseDisplayLink(`<https://${S}/wiki/display/~jdoe/Notes>`)).toEqual({
      site: S,
      spaceKey: "~jdoe",
      title: "Notes",
    });
  });
  test("other links are not display links", () => {
    expect(parseDisplayLink(`https://${S}/wiki/spaces/ENG/pages/1`)).toBeUndefined();
    expect(parseDisplayLink("12345")).toBeUndefined();
  });
});

describe("parseSpaceRef", () => {
  test.each([
    ["123", { id: "123" }],
    ["ENG", { key: "ENG" }],
    ["~user", { key: "~user" }],
    [`https://${S}/wiki/spaces/ENG/overview`, { key: "ENG" }],
  ])("%s", (input, want) => expect(parseSpaceRef(input)).toEqual(want));
  test.each(["a b", `https://${S}/browse/X-1`])("invalid %p", (input) =>
    expectCode(() => parseSpaceRef(input), "invalid_space_ref"),
  );
});
