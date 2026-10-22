import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraAttachmentCommands } from "../../src/commands/jira-attachments.ts";
import { jiraDeps } from "../../src/commands/jira.ts";
import type { CommandContext, CommandSpec } from "../../src/core/cli.ts";
import { saveConfig } from "../../src/core/config.ts";
import { AtlError } from "../../src/core/errors.ts";
import { isRecord } from "../../src/core/guards.ts";
import { makeContext } from "../helpers/context.ts";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const API = "https://api.atlassian.com";
const JIRA = `${API}/ex/jira/${CLOUD}`;
const MEDIA = "https://api.media.atlassian.com/file/abc/binary";

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  form?: FormData;
}

interface Reply {
  status: number;
  body?: string | Uint8Array | null;
  headers?: Record<string, string>;
}

const json = (body: unknown, status = 200): Reply => ({
  status,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

let root: string;
let env: NodeJS.ProcessEnv;
let sent: Sent[];

/** Routes are keyed `METHOD <absolute url without query>`. */
function serve(routes: Record<string, Reply>): void {
  jiraDeps.fetch = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const headers = isRecord(init?.headers)
      ? Object.fromEntries(
          Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
        )
      : {};
    sent.push({
      method,
      url: input,
      headers,
      ...(init?.body instanceof FormData ? { form: init.body } : {}),
    });
    const reply = routes[`${method} ${url.origin}${url.pathname}`];
    if (reply === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ errorMessages: ["no route"] }), { status: 404 }),
      );
    }
    return Promise.resolve(
      new Response(reply.body ?? null, {
        status: reply.status,
        ...(reply.headers === undefined ? {} : { headers: reply.headers }),
      }),
    );
  };
}

function command(name: string): CommandSpec {
  const spec = jiraAttachmentCommands.find((c) => c.name === name);
  if (spec === undefined) {
    throw new Error(`missing command ${name}`);
  }
  return spec;
}

function run(
  name: string,
  args: Record<string, string>,
  flags: Record<string, unknown> = {},
  options: { rest?: string[]; ctx?: Partial<CommandContext> } = {},
): Promise<unknown> {
  return command(name).run(makeContext(env, options.ctx), {
    args,
    rest: options.rest ?? [],
    flags,
  });
}

async function failure(promise: Promise<unknown>): Promise<AtlError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof AtlError)) {
    throw new Error("expected an AtlError rejection");
  }
  return error;
}

const ATTACHMENT = {
  id: "10001",
  filename: "report.pdf",
  size: 4,
  mimeType: "application/pdf",
  created: "2026-10-22T12:33:34.123+0200",
  author: { accountId: "u1", displayName: "Ada" },
  content: "https://example.invalid/content/10001",
  self: "https://example.invalid/attachment/10001",
};
const BYTES = new Uint8Array([0, 255, 128, 10]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atl-jira-attach-test-"));
  env = { ATL_CONFIG_DIR: join(root, "atl"), ATL_ACCESS_TOKEN: "test-token" };
  await saveConfig(
    {
      sites: {
        "acme.atlassian.net": {
          cloudId: CLOUD,
          name: "acme",
          url: "https://acme.atlassian.net",
          scopes: ["write:jira-work"],
          cachedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    },
    env,
  );
  sent = [];
});

afterEach(async () => {
  jiraDeps.fetch = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("issue.attachments", () => {
  test("requests only the attachment field and returns compact rows", async () => {
    serve({
      [`GET ${JIRA}/rest/api/3/issue/ABC-1`]: json({ fields: { attachment: [ATTACHMENT] } }),
    });
    const result = await run("issue.attachments", { issue: "ABC-1" });
    expect(new URL(sent[0]?.url ?? "").searchParams.get("fields")).toBe("attachment");
    expect(result).toEqual({
      items: [
        {
          id: "10001",
          filename: "report.pdf",
          size: 4,
          mimeType: "application/pdf",
          author: "Ada",
          created: "2026-10-22T12:33:34+0200",
        },
      ],
    });
  });

  test("an issue without attachments gives an empty list; --full returns raw objects", async () => {
    serve({ [`GET ${JIRA}/rest/api/3/issue/ABC-1`]: json({ fields: {} }) });
    expect(await run("issue.attachments", { issue: "ABC-1" })).toEqual({ items: [] });
    serve({
      [`GET ${JIRA}/rest/api/3/issue/ABC-1`]: json({ fields: { attachment: [ATTACHMENT] } }),
    });
    expect(await run("issue.attachments", { issue: "ABC-1" }, {}, { ctx: { full: true } })).toEqual(
      {
        items: [ATTACHMENT],
        nextCursor: null,
      },
    );
  });
});

describe("issue.attachment.download", () => {
  const ROUTES: Record<string, Reply> = {
    [`GET ${JIRA}/rest/api/3/attachment/10001`]: json(ATTACHMENT),
    [`GET ${JIRA}/rest/api/3/attachment/content/10001`]: {
      status: 303,
      headers: { location: `${MEDIA}?token=signed` },
    },
    [`GET ${MEDIA}`]: { status: 200, body: BYTES, headers: { "content-type": "application/pdf" } },
  };

  test("follows the media redirect, keeps the bytes intact and reports {path, bytes, mimeType}", async () => {
    serve(ROUTES);
    const path = join(root, "out", "saved.bin");
    const result = await run("issue.attachment.download", { id: "10001" }, { output: path });
    expect(result).toEqual({ path, bytes: 4, mimeType: "application/pdf" });
    expect(await Bun.file(path).bytes()).toEqual(BYTES);
  });

  test("the bearer token goes only to api.atlassian.com, never to the redirect target", async () => {
    serve(ROUTES);
    await run("issue.attachment.download", { id: "10001" }, { output: join(root, "a.bin") });
    const byOrigin = sent.map((s) => [new URL(s.url).origin, s.headers.authorization]);
    expect(byOrigin).toEqual([
      [API, "Bearer test-token"],
      [API, "Bearer test-token"],
      ["https://api.media.atlassian.com", undefined],
    ]);
  });

  test("an existing directory receives the attachment's filename, stripped of path parts", async () => {
    serve({
      ...ROUTES,
      [`GET ${JIRA}/rest/api/3/attachment/10001`]: json({
        ...ATTACHMENT,
        filename: "../../evil.txt",
      }),
    });
    const dir = join(root, "dl");
    await mkdir(dir);
    const result = await run("issue.attachment.download", { id: "10001" }, { output: dir });
    expect(result).toEqual({ path: join(dir, "evil.txt"), bytes: 4, mimeType: "application/pdf" });
  });

  test("without --output the file is named after the attachment in the current directory", async () => {
    serve(ROUTES);
    const previous = process.cwd();
    process.chdir(root);
    try {
      const result = await run("issue.attachment.download", { id: "10001" });
      expect(result).toEqual({ path: "report.pdf", bytes: 4, mimeType: "application/pdf" });
      expect(await Bun.file(join(root, "report.pdf")).bytes()).toEqual(BYTES);
    } finally {
      process.chdir(previous);
    }
  });

  test("an existing file is never overwritten without --force", async () => {
    serve(ROUTES);
    const path = join(root, "taken.bin");
    await Bun.write(path, "keep");
    const error = await failure(
      run("issue.attachment.download", { id: "10001" }, { output: path }),
    );
    expect(error.code).toBe("file_exists");
    expect(error.category).toBe("input");
    expect(error.next).toEqual([
      ["atl", "issue", "attachment", "download", "10001", "--output", "10001-report.pdf"],
    ]);
    expect(await Bun.file(path).text()).toBe("keep");
    expect(sent.map((s) => new URL(s.url).pathname)).not.toContain("/file/abc/binary");

    const forced = await run(
      "issue.attachment.download",
      { id: "10001" },
      { output: path, force: true },
    );
    expect(forced).toEqual({ path, bytes: 4, mimeType: "application/pdf" });
    expect(await Bun.file(path).bytes()).toEqual(BYTES);
  });

  test("a default-named download colliding with a file in the directory is refused", async () => {
    serve(ROUTES);
    await Bun.write(join(root, "report.pdf"), "keep");
    const error = await failure(
      run("issue.attachment.download", { id: "10001" }, { output: root }),
    );
    expect(error.code).toBe("file_exists");
    expect(await Bun.file(join(root, "report.pdf")).text()).toBe("keep");
  });

  test("--plan downloads nothing and prints the target path and whether it exists", async () => {
    serve(ROUTES);
    const path = join(root, "planned.bin");
    const plan = await run(
      "issue.attachment.download",
      { id: "10001" },
      { output: path },
      { ctx: { plan: true, argv: ["issue", "attachment", "download", "10001", "--plan"] } },
    );
    expect(plan).toMatchObject({ type: "plan", method: "GET", path, exists: false });
    expect(await Bun.file(path).exists()).toBe(false);
    expect(sent.map((s) => s.url)).toEqual([`${JIRA}/rest/api/3/attachment/10001`]);
  });

  test("a missing attachment is an api error and writes nothing", async () => {
    serve({});
    const error = await failure(
      run("issue.attachment.download", { id: "10001" }, { output: join(root, "never.bin") }),
    );
    expect(error.code).toBe("http_404");
    expect(await Bun.file(join(root, "never.bin")).exists()).toBe(false);
  });

  test("a failing content request is mapped like any other API error", async () => {
    serve({
      [`GET ${JIRA}/rest/api/3/attachment/10001`]: json(ATTACHMENT),
      [`GET ${JIRA}/rest/api/3/attachment/content/10001`]: json({ errorMessages: ["gone"] }, 403),
    });
    const error = await failure(
      run("issue.attachment.download", { id: "10001" }, { output: join(root, "x.bin") }),
    );
    expect(error.code).toBe("http_403");
    expect(error.category).toBe("auth");
  });

  test("refuses a redirect to a non-https location", async () => {
    serve({
      ...ROUTES,
      [`GET ${JIRA}/rest/api/3/attachment/content/10001`]: {
        status: 303,
        headers: { location: "http://insecure.example/file" },
      },
    });
    const error = await failure(
      run("issue.attachment.download", { id: "10001" }, { output: join(root, "x.bin") }),
    );
    expect(error.code).toBe("insecure_url");
  });
});

describe("issue.attachment.add", () => {
  const route = `POST ${JIRA}/rest/api/3/issue/ABC-1/attachments`;

  test("uploads every file as multipart `file` parts with the no-check header", async () => {
    serve({ [route]: json([ATTACHMENT, { ...ATTACHMENT, id: "10002", filename: "b.txt" }]) });
    const a = join(root, "a.pdf");
    const b = join(root, "b.txt");
    await Bun.write(a, BYTES);
    await Bun.write(b, "hello");
    const result = await run("issue.attachment.add", { issue: "ABC-1" }, {}, { rest: [a, b] });

    const request = sent[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers["x-atlassian-token"]).toBe("no-check");
    expect(request?.headers["content-type"]).toBeUndefined();
    expect(request?.headers.authorization).toBe("Bearer test-token");
    const parts = request?.form?.getAll("file") ?? [];
    expect(parts.map((p) => (p instanceof File ? p.name : null))).toEqual(["a.pdf", "b.txt"]);
    const first = parts[0];
    expect(first instanceof File ? await first.bytes() : null).toEqual(BYTES);
    expect(result).toEqual({
      issue: "ABC-1",
      items: [
        {
          id: "10001",
          filename: "report.pdf",
          size: 4,
          mimeType: "application/pdf",
          author: "Ada",
          created: "2026-10-22T12:33:34+0200",
        },
        {
          id: "10002",
          filename: "b.txt",
          size: 4,
          mimeType: "application/pdf",
          author: "Ada",
          created: "2026-10-22T12:33:34+0200",
        },
      ],
      next: [["atl", "issue", "attachments", "ABC-1"]],
    });
  });

  test("--full returns the raw API array", async () => {
    serve({ [route]: json([ATTACHMENT]) });
    const a = join(root, "a.pdf");
    await Bun.write(a, BYTES);
    expect(
      await run("issue.attachment.add", { issue: "ABC-1" }, {}, { rest: [a], ctx: { full: true } }),
    ).toEqual([ATTACHMENT]);
  });

  test("--plan lists the files and sends nothing", async () => {
    serve({});
    const a = join(root, "a.pdf");
    await Bun.write(a, BYTES);
    const result = await run(
      "issue.attachment.add",
      { issue: "ABC-1" },
      {},
      {
        rest: [a],
        ctx: { plan: true, argv: ["issue", "attachment", "add", "ABC-1", a, "--plan"] },
      },
    );
    expect(sent).toEqual([]);
    expect(result).toMatchObject({
      type: "plan",
      method: "POST",
      url: `${JIRA}/rest/api/3/issue/ABC-1/attachments`,
      body: { preview: '{"files":[{"filename":"a.pdf","bytes":4}]}' },
      next: [["atl", "issue", "attachment", "add", "ABC-1", a]],
    });
  });

  test("a quote or newline in the file name is stored as Jira stores it (`_`), not as a percent escape", async () => {
    serve({ [route]: json([ATTACHMENT]) });
    const dir = join(root, "q");
    await mkdir(dir);
    const odd = join(dir, 'we"ird;name.txt');
    await Bun.write(odd, BYTES);
    await run("issue.attachment.add", { issue: "ABC-1" }, {}, { rest: [odd] });
    const file = sent[0]?.form?.get("file");
    expect(file instanceof File ? file.name : undefined).toBe("we_ird;name.txt");
  });

  test("a missing file or a directory fails before any request", async () => {
    serve({});
    const missing = await failure(
      run("issue.attachment.add", { issue: "ABC-1" }, {}, { rest: [join(root, "nope.txt")] }),
    );
    expect(missing.code).toBe("input_file_unreadable");
    const dir = await failure(
      run("issue.attachment.add", { issue: "ABC-1" }, {}, { rest: [root] }),
    );
    expect(dir.code).toBe("input_file_unreadable");
    expect(sent).toEqual([]);
  });

  test("API rejections surface as errors", async () => {
    serve({ [route]: json({ errorMessages: ["too large"] }, 413) });
    const a = join(root, "a.pdf");
    await Bun.write(a, BYTES);
    const error = await failure(run("issue.attachment.add", { issue: "ABC-1" }, {}, { rest: [a] }));
    expect(error.code).toBe("http_413");
  });
});

describe("issue.attachment.delete", () => {
  const route = `DELETE ${JIRA}/rest/api/3/attachment/10001`;

  test("needs --yes and sends nothing without it", async () => {
    serve({ [route]: { status: 204 } });
    const error = await failure(run("issue.attachment.delete", { id: "10001" }));
    expect(error.code).toBe("confirmation_required");
    expect(sent).toEqual([]);
  });

  test("--yes deletes by id", async () => {
    serve({ [route]: { status: 204 } });
    expect(await run("issue.attachment.delete", { id: "10001" }, { yes: true })).toEqual({
      deleted: "10001",
    });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `DELETE ${JIRA}/rest/api/3/attachment/10001`,
    ]);
  });

  test("--plan needs no --yes, sends nothing, and its next adds --yes", async () => {
    serve({});
    const result = await run(
      "issue.attachment.delete",
      { id: "10001" },
      {},
      {
        ctx: { plan: true, argv: ["issue", "attachment", "delete", "10001", "--plan"] },
      },
    );
    expect(sent).toEqual([]);
    expect(result).toMatchObject({
      type: "plan",
      method: "DELETE",
      next: [["atl", "issue", "attachment", "delete", "10001", "--yes"]],
    });
  });
});
