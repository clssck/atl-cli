import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** Atlassian's Cloudflare edge 403s default library user agents; always send this. */
export const USER_AGENT = `atl/${VERSION}`;
