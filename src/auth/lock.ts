// node:fs/promises only where Bun has no equivalent: mkdir with mode, exclusive create
// (open "wx") for the lock file, and idempotent rm.
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "../core/schema.ts";
import { AtlError } from "../core/errors.ts";
import { errnoCode } from "../core/fs.ts";
import { refreshLockPath } from "../core/paths.ts";
import { check } from "../core/validate.ts";

export interface LockOptions {
  env?: NodeJS.ProcessEnv;
  /** A lock older than this is broken. Default 60s. */
  staleMs?: number;
  /** Give up waiting after this long. Default 30s. */
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 50;

const LockContents = Type.Object({ pid: Type.Integer(), acquiredAt: Type.Number() });

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

/** Raw file text when the lock can be judged stale, else undefined. */
async function staleLockText(path: string, staleMs: number): Promise<string | undefined> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (check(LockContents, parsed)) {
    if (Date.now() - parsed.acquiredAt > staleMs || !isProcessAlive(parsed.pid)) {
      return text;
    }
    return undefined;
  }
  // Empty or half-written file: the owner may be between open() and write(); fall back to mtime.
  try {
    const { mtimeMs } = await Bun.file(path).stat();
    return Date.now() - mtimeMs > staleMs ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the lock only when it still holds the contents judged stale, so a fresh lock is not clobbered. */
async function breakStaleLock(path: string, staleText: string): Promise<void> {
  let current: string;
  try {
    current = await Bun.file(path).text();
  } catch {
    return;
  }
  if (current === staleText) {
    await rm(path, { force: true });
  }
}

async function tryCreate(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      return undefined;
    }
    throw error;
  }
  const contents = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  return contents;
}

async function acquire(path: string, options: LockOptions): Promise<string> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    const contents = await tryCreate(path);
    if (contents !== undefined) {
      return contents;
    }
    const stale = await staleLockText(path, staleMs);
    if (stale !== undefined) {
      await breakStaleLock(path, stale);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new AtlError(
        "Timed out waiting for another atl process to finish refreshing credentials",
        {
          code: "refresh_lock_timeout",
          category: "transient",
          hint: `If no other atl process is running, delete ${path} and retry.`,
        },
      );
    }
    await Bun.sleep(pollMs);
  }
}

async function release(path: string, contents: string): Promise<void> {
  try {
    if ((await Bun.file(path).text()) === contents) {
      await rm(path, { force: true });
    }
  } catch {
    // Lock already gone or replaced after being judged stale; nothing of ours to remove.
  }
}

/** Callers in this process queue here so they never poll the file against each other. */
const processQueues = new Map<string, Promise<void>>();

/** Runs `fn` while holding the cross-process refresh lock. */
export async function withRefreshLock<T>(
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const path = refreshLockPath(options.env);
  const previous = processQueues.get(path) ?? Promise.resolve();
  const { promise: turn, resolve: finish } = Promise.withResolvers<void>();
  const tail = previous.then(() => turn);
  processQueues.set(path, tail);
  await previous;
  try {
    const contents = await acquire(path, options);
    try {
      return await fn();
    } finally {
      await release(path, contents);
    }
  } finally {
    finish();
    if (processQueues.get(path) === tail) {
      processQueues.delete(path);
    }
  }
}
