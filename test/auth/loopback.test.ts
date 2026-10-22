import { describe, expect, test } from "bun:test";
import { startCallbackServer } from "../../src/auth/loopback.ts";

describe("loopback callback server", () => {
  test("a bad state gets a 400 and is ignored; a good state resolves with the code", async () => {
    const listener = startCallbackServer({ port: 0, state: "good-state" });
    try {
      const bad = await fetch(`http://127.0.0.1:${listener.port}/callback?code=evil&state=wrong`);
      expect(bad.status).toBe(400);
      const missing = await fetch(`http://127.0.0.1:${listener.port}/callback?code=evil`);
      expect(missing.status).toBe(400);

      const good = await fetch(
        `http://127.0.0.1:${listener.port}/callback?code=the-code&state=good-state`,
      );
      expect(good.status).toBe(200);
      expect(await good.text()).toContain("close this tab");
      expect(await listener.result).toBe("the-code");
    } finally {
      listener.stop();
    }
  });

  const hasIpv6Loopback = (() => {
    try {
      void Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response() }).stop(true);
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!hasIpv6Loopback)(
    "the callback is also accepted on ::1 at the same port",
    async () => {
      const listener = startCallbackServer({ port: 0, state: "s6" });
      try {
        const res = await fetch(`http://[::1]:${listener.port}/callback?state=s6&code=v6-code`);
        expect(res.status).toBe(200);
        expect(await listener.result).toBe("v6-code");
      } finally {
        listener.stop();
      }
    },
  );

  test("redirectUri uses localhost and the bound port", () => {
    const listener = startCallbackServer({ port: 0, state: "s" });
    try {
      expect(listener.redirectUri).toBe(`http://localhost:${listener.port}/callback`);
    } finally {
      listener.stop();
    }
  });

  test("provider errors with the right state reject, mapped by kind, and HTML-escape the page", async () => {
    const denied = startCallbackServer({ port: 0, state: "s" });
    const deniedResult = denied.result.catch((e: unknown) => e);
    const page = await fetch(
      `http://127.0.0.1:${denied.port}/callback?state=s&error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}`,
    );
    expect(await page.text()).not.toContain("<script>x");
    expect(await deniedResult).toMatchObject({ code: "consent_denied", category: "auth" });

    const unavailable = startCallbackServer({ port: 0, state: "s" });
    const unavailableResult = unavailable.result.catch((e: unknown) => e);
    await fetch(
      `http://127.0.0.1:${unavailable.port}/callback?state=s&error=temporarily_unavailable`,
    );
    expect(await unavailableResult).toMatchObject({
      code: "consent_unreachable",
      category: "transient",
    });
  });

  test("unknown paths are 404 and do not settle the login", async () => {
    const listener = startCallbackServer({ port: 0, state: "s" });
    try {
      expect((await fetch(`http://127.0.0.1:${listener.port}/other?code=x&state=s`)).status).toBe(
        404,
      );
      await fetch(`http://127.0.0.1:${listener.port}/callback?code=ok&state=s`);
      expect(await listener.result).toBe("ok");
    } finally {
      listener.stop();
    }
  });

  test("times out with login_timeout and releases the port", async () => {
    // Real timer is the behavior under test: the server's own timeout.
    const listener = startCallbackServer({ port: 0, state: "s", timeoutMs: 30 });
    const port = listener.port;
    await expect(listener.result).rejects.toMatchObject({
      code: "login_timeout",
      category: "auth",
    });
    const reuse = startCallbackServer({ port, state: "s" });
    reuse.stop();
  });

  test("a busy port is a config error naming --port", () => {
    const first = startCallbackServer({ port: 0, state: "s" });
    try {
      expect(() => startCallbackServer({ port: first.port, state: "s" })).toThrow(
        expect.objectContaining({ code: "port_in_use", category: "config" }),
      );
    } finally {
      first.stop();
    }
  });

  test("aborting the signal rejects the login", async () => {
    const controller = new AbortController();
    const listener = startCallbackServer({ port: 0, state: "s", signal: controller.signal });
    controller.abort();
    await expect(listener.result).rejects.toMatchObject({ code: "aborted" });
  });
});
