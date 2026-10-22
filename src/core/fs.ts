// node:fs/promises only where Bun has no equivalent: mkdir with mode, chmod, rename, and a
// create-time file mode (Bun.write ignores `mode`).
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const isWindows = process.platform === "win32";

export function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Atomic private write: temp file in the same directory, then rename. The directory is created
 * and tightened to 0700 and the file is 0600 (POSIX); the temp file never outlives a failure.
 */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) {
    await chmod(dir, 0o700);
  }
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    if (!isWindows) {
      await chmod(tmp, 0o600);
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
