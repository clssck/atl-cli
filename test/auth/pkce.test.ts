import { describe, expect, test } from "bun:test";
import { codeChallengeS256, createCodeVerifier, createState } from "../../src/auth/pkce.ts";

describe("pkce", () => {
  test("S256 challenge matches the RFC 7636 appendix B vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("verifier is 32 random bytes as unpadded base64url", () => {
    const verifier = createCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(verifier, "base64url")).toHaveLength(32);
    expect(createCodeVerifier()).not.toBe(verifier);
  });

  test("state values are unique and URL-safe", () => {
    const a = createState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createState()).not.toBe(a);
  });
});
