/** Default browser launcher. Callers treat failures as non-fatal because the URL is also reported. */
export function openInBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  proc.unref();
  return Promise.resolve();
}
