import { describe, expect, test } from "bun:test";
import { decodeJwtPayload, summarizeToken } from "../../src/auth/jwt.ts";
import { makeJwt, present } from "./helpers.ts";

describe("jwt summary", () => {
  const token = makeJwt({
    iss: "https://auth.atlassian.com",
    iat: 1000,
    exp: 29800,
    aud: [
      "client-id",
      "ari:cloud:confluence::site/be9e333b-6799-49ef-a7c7-8f6bbaf413d1",
      "ari:cloud:jira::site/be9e333b-6799-49ef-a7c7-8f6bbaf413d1",
      "ari:cloud:jira::site/11111111-2222-3333-4444-555555555555",
      "ari:cloud:confluence::workspace/ignored",
    ],
    scope: "read:me offline_access read:jira-work",
    "https://atlassian.com/3lo": true,
    "https://atlassian.com/firstParty": false,
    mcp: { rr: "http://localhost:3000/callback", ts: ["read_confluence", "write_jira"] },
  });

  test("parses site cloudIds from audience ARIs, deduplicated, and the other claims", () => {
    expect(summarizeToken(token)).toEqual({
      iss: "https://auth.atlassian.com",
      iat: 1000,
      exp: 29800,
      scopes: ["read:me", "offline_access", "read:jira-work"],
      threeLo: true,
      firstParty: false,
      audSites: ["be9e333b-6799-49ef-a7c7-8f6bbaf413d1", "11111111-2222-3333-4444-555555555555"],
      mcpToolsets: ["read_confluence", "write_jira"],
    });
  });

  test("the summary never contains the token string", () => {
    expect(JSON.stringify(summarizeToken(token))).not.toContain(
      present(token.split(".")[1], "payload segment"),
    );
  });

  test("a string aud and missing claims degrade without throwing", () => {
    const summary = summarizeToken(makeJwt({ aud: "ari:cloud:jira::site/abc" }));
    expect(summary).toEqual({ scopes: [], threeLo: false, firstParty: false, audSites: ["abc"] });
  });

  test("non-JWT input and non-object payloads are rejected", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeUndefined();
    expect(decodeJwtPayload(`a.${Buffer.from("[1]").toString("base64url")}.c`)).toBeUndefined();
    expect(decodeJwtPayload("a.%%%.c")).toBeUndefined();
  });
});
