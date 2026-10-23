// Release candidate lifecycle used by .github/workflows/release.yml:
//   prepare BUMP DIRECTORY  bump the version, build once, pack, and record a manifest
//                           plus a git bundle of the version commit and tag
//   restore DIRECTORY       check out the candidate commit on top of its base revision
//   verify DIRECTORY        read-only check that npm serves exactly the candidate tarball
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const packageName = "@clssck/atl-cli";
// npm pack names a scoped tarball `<scope>-<name>-<version>.tgz`; the registry serves it as `<name>-<version>.tgz`.
const packedBase = "clssck-atl-cli";
const tarballBase = "atl-cli";

export interface CandidateManifest {
  name: string;
  version: string;
  baseRevision: string;
  commit: string;
  bytes: number;
  integrity: string;
}

function run(argv: string[], cwd = root): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${argv.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

function isManifest(value: unknown): value is CandidateManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v: Record<string, unknown> = { ...value };
  const { name, version, commit, baseRevision, bytes } = v;
  const sri = v["integrity"];
  return (
    name === packageName &&
    typeof version === "string" &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    typeof commit === "string" &&
    /^[a-f0-9]{40}$/.test(commit) &&
    typeof baseRevision === "string" &&
    /^[a-f0-9]{40}$/.test(baseRevision) &&
    typeof sri === "string" &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(sri) &&
    typeof bytes === "number" &&
    Number.isSafeInteger(bytes) &&
    bytes >= 1
  );
}

export function readCandidate(directory: string): CandidateManifest {
  const manifestPath = path.join(directory, "manifest.json");
  if (fs.statSync(manifestPath).size > 4096) {
    throw new Error("Oversized release manifest");
  }
  const value: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!isManifest(value)) {
    throw new Error("Invalid release candidate manifest");
  }
  return value;
}

export function verifyCandidate(directory: string): CandidateManifest {
  const manifest = readCandidate(directory);
  const tarball = path.join(directory, "package.tgz");
  if (
    fs.statSync(tarball).size !== manifest.bytes ||
    integrity(fs.readFileSync(tarball)) !== manifest.integrity
  ) {
    throw new Error("Release candidate tarball integrity mismatch");
  }
  return manifest;
}

async function prepareCandidate(bump: string, directory: string): Promise<void> {
  if (!["patch", "minor", "major"].includes(bump)) {
    throw new Error("Expected patch, minor, or major");
  }
  if (run(["git", "status", "--porcelain"])) {
    throw new Error("Release preparation requires a clean checkout");
  }
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length > 0) {
    throw new Error("Candidate directory must be empty");
  }
  const baseRevision = run(["git", "rev-parse", "HEAD"]);
  // The npm `version` lifecycle syncs plugin.json and cuts the changelog into the commit.
  run(["npm", "version", bump, "-m", "v%s"]);
  const pkg: { name: string; version: string } = await Bun.file(
    path.join(root, "package.json"),
  ).json();
  if (pkg.name !== packageName) {
    throw new Error("Unexpected package name");
  }
  const commit = run(["git", "rev-parse", "HEAD"]);
  run([process.execPath, "run", "build"]);
  // Build once, then pack without lifecycle scripts rebuilding the candidate.
  run(["npm", "pack", "--ignore-scripts", "--pack-destination", directory]);
  const packed = path.join(directory, `${packedBase}-${pkg.version}.tgz`);
  const tarball = path.join(directory, "package.tgz");
  fs.renameSync(packed, tarball);
  const bytes = await Bun.file(tarball).bytes();
  const manifest: CandidateManifest = {
    name: packageName,
    version: pkg.version,
    baseRevision,
    commit,
    bytes: bytes.length,
    integrity: integrity(bytes),
  };
  await Bun.write(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  run([
    "git",
    "bundle",
    "create",
    path.join(directory, "source.bundle"),
    "HEAD",
    `refs/tags/v${pkg.version}`,
    `^${baseRevision}`,
  ]);
  verifyCandidate(directory);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

function restoreCandidate(directory: string): void {
  const manifest = verifyCandidate(directory);
  if (run(["git", "rev-parse", "HEAD"]) !== manifest.baseRevision) {
    throw new Error("Candidate base differs from the checked-out revision");
  }
  run([
    "git",
    "fetch",
    path.join(directory, "source.bundle"),
    "HEAD",
    `refs/tags/v${manifest.version}:refs/tags/v${manifest.version}`,
  ]);
  run(["git", "checkout", "--detach", "FETCH_HEAD"]);
  if (
    run(["git", "rev-parse", "HEAD"]) !== manifest.commit ||
    run(["git", "rev-parse", `v${manifest.version}^{commit}`]) !== manifest.commit ||
    run(["git", "rev-parse", "HEAD^"]) !== manifest.baseRevision
  ) {
    throw new Error("Candidate source/tag does not match its manifest");
  }
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

class PublicationMismatch extends Error {}

async function registryJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new PublicationMismatch("Registry metadata body is missing");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1_048_576) {
      throw new PublicationMismatch("Registry metadata exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new PublicationMismatch("Invalid registry metadata JSON");
  }
}

interface RegistryVersion {
  name?: unknown;
  version?: unknown;
  gitHead?: unknown;
  dist?: { integrity?: unknown; tarball?: unknown };
}

/** Read-only, bounded verification. Never publishes or retries publication. */
export async function verifyPublishedCandidate(
  directory: string,
  {
    registry = "https://registry.npmjs.org/",
    timeoutMs = 600_000,
    pollMs = 5000,
  }: { registry?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<CandidateManifest> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error("Invalid publication verification timing");
  }
  const manifest = verifyCandidate(directory);
  const registryUrl = new URL(registry);
  if (
    !["http:", "https:"].includes(registryUrl.protocol) ||
    registryUrl.username ||
    registryUrl.password
  ) {
    throw new Error("Registry must be an HTTP(S) URL without credentials");
  }
  const metadataUrl = new URL(`${packageName}/${manifest.version}`, registryUrl);
  const tarballUrl = new URL(
    `${packageName}/-/${tarballBase}-${manifest.version}.tgz`,
    registryUrl,
  );
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "not yet available";
  while (Date.now() < deadline) {
    try {
      const options: RequestInit = {
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
        redirect: "error",
        headers: { "cache-control": "no-cache" },
      };
      const response = await fetch(metadataUrl, options);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Metadata HTTP ${response.status}`);
      }
      const raw = await registryJson(response);
      const metadata: RegistryVersion | null =
        typeof raw === "object" && raw !== null ? { ...raw } : null;
      if (
        metadata === null ||
        metadata.name !== manifest.name ||
        metadata.version !== manifest.version ||
        metadata.dist?.integrity !== manifest.integrity ||
        metadata.dist.tarball !== tarballUrl.href ||
        (metadata.gitHead !== undefined && metadata.gitHead !== manifest.commit)
      ) {
        throw new PublicationMismatch(
          "Published version has different content or source identity; do not republish",
        );
      }
      // npm's CDN caches a tarball 404 for 300 s; a fresh query per attempt
      // skips a 404 cached before the tarball replicated. Integrity is still
      // checked against the candidate, and dist.tarball against the canonical URL.
      const attemptUrl = new URL(tarballUrl);
      attemptUrl.searchParams.set("attempt", `${Date.now()}`);
      const tarball = await fetch(attemptUrl, options);
      if (!tarball.ok) {
        await tarball.body?.cancel();
        throw new Error(`Tarball HTTP ${tarball.status}`);
      }
      if (!tarball.body) {
        throw new PublicationMismatch("Published tarball body is missing");
      }
      const hash = new Bun.CryptoHasher("sha512");
      let size = 0;
      for await (const chunk of tarball.body) {
        size += chunk.length;
        if (size > manifest.bytes) {
          throw new PublicationMismatch("Published tarball exceeds candidate size");
        }
        hash.update(chunk);
      }
      if (size !== manifest.bytes || `sha512-${hash.digest("base64")}` !== manifest.integrity) {
        throw new PublicationMismatch("Published tarball integrity mismatch");
      }
      return manifest;
    } catch (error) {
      if (error instanceof PublicationMismatch) {
        throw error;
      }
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
  }
  throw new Error(
    `Publication not confirmed: ${lastFailure}. Preserve the candidate and investigate npm; do not blindly republish.`,
  );
}

if (import.meta.main) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "prepare" && first && second) {
    await prepareCandidate(first, path.resolve(second));
  } else if (command === "restore" && first) {
    restoreCandidate(path.resolve(first));
  } else if (command === "verify" && first) {
    process.stdout.write(
      `${JSON.stringify(await verifyPublishedCandidate(path.resolve(first)))}\n`,
    );
  } else {
    throw new Error(
      "Usage: release-candidate.ts prepare BUMP DIRECTORY | restore DIRECTORY | verify DIRECTORY",
    );
  }
}
