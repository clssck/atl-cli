// Runs from the npm `version` lifecycle (after package.json is bumped): moves the
// `## [Unreleased]` entries under a `## [<version>] - <date>` heading so every
// published version has its own section. `--check` fails when the current
// version has no section. 0.0.0 is the never-released source version and has
// no section to check.
const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const { version }: { version: string } = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();
const text = await Bun.file(changelogUrl).text();
const headingPrefix = `## [${version}]`;
const unreleased = /^## \[Unreleased\]\n\n([\s\S]*?)(?=^## |(?![\s\S]))/m;

const match = unreleased.exec(text);
if (!match) {
  throw new Error("CHANGELOG.md must contain a `## [Unreleased]` section.");
}
const pending = (match[1] ?? "").trim();
const hasHeading = text
  .split("\n")
  .some((line) => line === headingPrefix || line.startsWith(`${headingPrefix} - `));

if (process.argv.includes("--check")) {
  if (!hasHeading && version !== "0.0.0") {
    process.stderr.write(`CHANGELOG.md has no ${headingPrefix} section.\n`);
    process.exitCode = 1;
  }
} else {
  if (hasHeading) {
    throw new Error(`CHANGELOG.md already has ${headingPrefix}.`);
  }
  if (pending === "") {
    throw new Error(`No Unreleased entries to release as ${version}.`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const cut = text.replace(
    unreleased,
    `## [Unreleased]\n\n${headingPrefix} - ${date}\n\n${pending}\n\n`,
  );
  await Bun.write(changelogUrl, cut);
}
