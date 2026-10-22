/** Run `fn` and return its result with the JSONL diagnostics written to stderr meanwhile. */
export async function withDiagnostics<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; diagnostics: unknown[] }> {
  const original = process.stderr.write.bind(process.stderr);
  let written = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    written += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    const diagnostics = written
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line));
    return { result, diagnostics };
  } finally {
    process.stderr.write = original;
  }
}
