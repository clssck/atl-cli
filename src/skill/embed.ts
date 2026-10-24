// Bun macro: imported `with { type: "macro" }`, it runs when `src/skill/bundle.ts` is transpiled
// (from source, `bun build` and `bun build --compile`) and only its return value reaches the
// bundle. Every file under `skills/atl/` is carried, so new skill files need no code change.
// Synchronous on purpose: `--bytecode` compiles cannot hold a top-level await.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isIgnoredFile } from "./ignored.ts";

/** `[relative POSIX path, encoding, data]`; UTF-8 text stays readable, other bytes are base64. */
export type EmbeddedFile = [path: string, encoding: "utf8" | "base64", data: string];

const SKILL_DIR = join(import.meta.dir, "..", "..", "skills", "atl");
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function skillTree(): EmbeddedFile[] {
  const files: EmbeddedFile[] = [];
  for (const entry of readdirSync(SKILL_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || isIgnoredFile(entry.name)) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(SKILL_DIR, absolute).split(sep).join("/");
    const bytes = readFileSync(absolute);
    let text: string | undefined;
    try {
      text = UTF8.decode(bytes);
    } catch {
      text = undefined;
    }
    files.push(
      text === undefined ? [path, "base64", bytes.toString("base64")] : [path, "utf8", text],
    );
  }
  return files.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
