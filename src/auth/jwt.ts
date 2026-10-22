/**
 * Unverified JWT payload decoding, for status display only. Nothing here
 * authenticates a token, and no summary ever carries the token string.
 */
import { Type, type Static } from "../core/schema.ts";
import { check } from "../core/validate.ts";

const THREE_LO = "https://atlassian.com/3lo";
const FIRST_PARTY = "https://atlassian.com/firstParty";

/** Claims read for status; every field stays `unknown` so odd tokens degrade instead of failing. */
const JwtPayload = Type.Object({
  iss: Type.Optional(Type.Unknown()),
  exp: Type.Optional(Type.Unknown()),
  iat: Type.Optional(Type.Unknown()),
  aud: Type.Optional(Type.Unknown()),
  scope: Type.Optional(Type.Unknown()),
  mcp: Type.Optional(Type.Unknown()),
  [THREE_LO]: Type.Optional(Type.Unknown()),
  [FIRST_PARTY]: Type.Optional(Type.Unknown()),
});
export type JwtPayload = Static<typeof JwtPayload>;

export interface TokenSummary {
  iss?: string;
  /** Seconds since epoch. */
  exp?: number;
  /** Seconds since epoch. */
  iat?: number;
  scopes: string[];
  threeLo: boolean;
  firstParty: boolean;
  /** cloudIds from `ari:cloud:(confluence|jira)::site/<cloudId>` audiences, deduplicated. */
  audSites: string[];
  /** Toolsets from the `mcp.ts` claim, when present. */
  mcpToolsets?: string[];
}

const SITE_ARI = /^ari:cloud:(?:confluence|jira)::site\/([^/\s]+)$/;

/** Decode the payload segment; undefined when the value is not a JWT with a JSON object payload. */
export function decodeJwtPayload(token: string): JwtPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  return check(JwtPayload, parsed) ? parsed : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter((s) => s.length > 0);
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export function audienceSites(aud: unknown): string[] {
  const sites = new Set<string>();
  for (const entry of stringList(aud)) {
    const match = SITE_ARI.exec(entry);
    if (match?.[1]) {
      sites.add(match[1]);
    }
  }
  return [...sites];
}

export function summarizeClaims(payload: JwtPayload): TokenSummary {
  const summary: TokenSummary = {
    scopes: stringList(payload.scope),
    threeLo: payload[THREE_LO] === true,
    firstParty: payload[FIRST_PARTY] === true,
    audSites: audienceSites(payload.aud),
  };
  if (typeof payload.iss === "string") {
    summary.iss = payload.iss;
  }
  if (typeof payload.exp === "number") {
    summary.exp = payload.exp;
  }
  if (typeof payload.iat === "number") {
    summary.iat = payload.iat;
  }
  const mcp = payload.mcp;
  if (typeof mcp === "object" && mcp !== null && "ts" in mcp && Array.isArray(mcp.ts)) {
    summary.mcpToolsets = stringList(mcp.ts);
  }
  return summary;
}

export function summarizeToken(token: string): TokenSummary | undefined {
  const payload = decodeJwtPayload(token);
  return payload === undefined ? undefined : summarizeClaims(payload);
}
