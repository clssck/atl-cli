import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { withRefreshLock } from "../../src/auth/lock.ts";
import { isRecord } from "../../src/core/guards.ts";
import { refreshLockPath } from "../../src/core/paths.ts";
import { createSandbox, type Sandbox } from "./helpers.ts";

let sandbox: Sandbox;
let lockPath: string;
beforeEach(async () => {
  sandbox = await createSandbox();
  lockPath = refreshLockPath(sandbox.env);
  await mkdir(dirname(lockPath), { recursive: true });
});
afterEach(() => sandbox.cleanup());

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  if (child.pid === undefined) {
    throw new Error("spawn failed");
  }
  return child.pid;
}

function resolvedTrue(): Promise<boolean> {
  return Promise.resolve(true);
}

describe("refresh lock", () => {
  test("writes pid and acquiredAt while held, and removes the file afterwards", async () => {
    await withRefreshLock(
      async () => {
        const held: unknown = JSON.parse(await readFile(lockPath, "utf8"));
        expect(isRecord(held)).toBe(true);
        expect(held).toMatchObject({ pid: process.pid });
        const acquiredAt = isRecord(held) ? held["acquiredAt"] : undefined;
        expect(typeof acquiredAt).toBe("number");
        expect(Date.now() - Number(acquiredAt)).toBeLessThan(5000);
      },
      { env: sandbox.env },
    );
    expect(await stat(lockPath).catch(() => {})).toBeUndefined();
  });

  test("a lock held by a dead process is broken", async () => {
    await writeFile(lockPath, JSON.stringify({ pid: deadPid(), acquiredAt: Date.now() }));
    const ran = await withRefreshLock(resolvedTrue, {
      env: sandbox.env,
      timeoutMs: 1000,
    });
    expect(ran).toBe(true);
  });

  test("a lock older than staleMs is broken even if its pid is alive", async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 120_000 }),
    );
    expect(await withRefreshLock(resolvedTrue, { env: sandbox.env, timeoutMs: 1000 })).toBe(true);
  });

  test("an empty lock file is judged by its mtime", async () => {
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    expect(await withRefreshLock(resolvedTrue, { env: sandbox.env, timeoutMs: 1000 })).toBe(true);
  });

  test("a fresh lock held by a live process times out with refresh_lock_timeout", async () => {
    await writeFile(lockPath, JSON.stringify({ pid: process.ppid, acquiredAt: Date.now() }));
    const error = await withRefreshLock(resolvedTrue, {
      env: sandbox.env,
      timeoutMs: 150,
      pollMs: 20,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "refresh_lock_timeout", category: "transient" });
    expect(await readFile(lockPath, "utf8")).toContain(String(process.ppid));
  });

  test("concurrent callers in one process run strictly one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await readFile(lockPath, "utf8");
      active--;
    };
    await Promise.all([1, 2, 3, 4].map(() => withRefreshLock(work, { env: sandbox.env })));
    expect(maxActive).toBe(1);
  });

  test("the lock is released when the callback throws", async () => {
    await withRefreshLock(
      (): Promise<never> => {
        throw new Error("boom");
      },
      { env: sandbox.env },
    ).catch(() => {});
    expect(
      await withRefreshLock(() => Promise.resolve("ok"), { env: sandbox.env, timeoutMs: 500 }),
    ).toBe("ok");
  });
});
