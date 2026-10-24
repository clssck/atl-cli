import { skillTree } from "./embed.ts" with { type: "macro" };

/** Every file of `skills/atl/`, keyed by POSIX relative path; inlined at bundle time. */
export const BUNDLED_SKILL: ReadonlyMap<string, Uint8Array> = new Map(
  skillTree().map(([path, encoding, data]): [string, Uint8Array] => [
    path,
    encoding === "utf8" ? new TextEncoder().encode(data) : Buffer.from(data, "base64"),
  ]),
);
