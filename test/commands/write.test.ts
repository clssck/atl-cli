import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyDeps, loadBody } from "../../src/commands/write.ts";
import { AtlError } from "../../src/core/errors.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atl-write-test-"));
});

afterEach(async () => {
  bodyDeps.readStdin = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function fileWith(bytes: Uint8Array): Promise<string> {
  const path = join(dir, "body.md");
  await Bun.write(path, bytes);
  return path;
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

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("loadBody: file encoding", () => {
  test("a Windows-1250 file is an input error naming the first bad byte, not U+FFFD text", async () => {
    // "ok \xf5 end": cp1250 for the Hungarian o-double-acute.
    const path = await fileWith(new Uint8Array([0x6f, 0x6b, 0x20, 0xf5, 0x20, 0x65, 0x6e, 0x64]));
    const error = await failure(loadBody({ file: path }, { allowStorage: false }));
    expect(error.code).toBe("body_not_utf8");
    expect(error.category).toBe("input");
    expect(error.message).toContain("byte 0xF5 at offset 3");
    expect(error.hint).toContain("iconv");
  });

  test("a truncated multi-byte sequence and an overlong lead are reported at their lead byte", async () => {
    const truncated = await fileWith(new Uint8Array([0x61, 0xc3]));
    expect(
      (await failure(loadBody({ file: truncated }, { allowStorage: false }))).message,
    ).toContain("offset 1");
    const overlong = await fileWith(new Uint8Array([0x61, 0x62, 0xc0, 0x80]));
    expect(
      (await failure(loadBody({ file: overlong }, { allowStorage: false }))).message,
    ).toContain("offset 2");
  });

  test("valid UTF-8 (with or without BOM) and UTF-16 with a BOM still load", async () => {
    const expected = expect.objectContaining({ kind: "adf" });
    for (const bytes of [
      text("h\u0151 \u{1F600}"),
      new Uint8Array([0xef, 0xbb, 0xbf, ...text("h\u0151")]),
      new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x51, 0x01]),
      new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x01, 0x51]),
    ]) {
      const loaded = await loadBody({ file: await fileWith(bytes) }, { allowStorage: false });
      expect(loaded).toEqual(expected);
    }
    const bom = await loadBody(
      { file: await fileWith(new Uint8Array([0xef, 0xbb, 0xbf, ...text("h\u0151")])) },
      { allowStorage: false },
    );
    expect(JSON.stringify(bom)).toContain("h\u0151");
    expect(JSON.stringify(bom)).not.toContain("\uFEFF");
  });

  test("stdin bytes are decoded strictly too", async () => {
    bodyDeps.readStdin = () => Promise.resolve(new Uint8Array([0x61, 0xff]));
    const error = await failure(loadBody({ file: "-" }, { allowStorage: false }));
    expect(error.code).toBe("body_not_utf8");
    expect(error.message).toContain("byte 0xFF at offset 1");
  });
});
