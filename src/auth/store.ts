import { Type, type Static } from "../core/schema.ts";
import { AtlError } from "../core/errors.ts";
import { errnoCode, writePrivateFile } from "../core/fs.ts";
import { credentialsPath } from "../core/paths.ts";
import { check } from "../core/validate.ts";

const StoredEndpoints = Type.Object({
  authorization: Type.String(),
  token: Type.String(),
  registration: Type.Optional(Type.String()),
  revocation: Type.Optional(Type.String()),
});

const StoredClient = Type.Object({
  clientId: Type.String(),
  clientSecret: Type.Optional(Type.String()),
  redirectUri: Type.String(),
  /** Epoch milliseconds. */
  registeredAt: Type.Number(),
});

const StoredToken = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.Optional(Type.String()),
  /** Epoch milliseconds. */
  expiresAt: Type.Number(),
  /** Space-separated granted scopes. */
  scope: Type.String(),
  /** Epoch milliseconds. */
  obtainedAt: Type.Number(),
});

/**
 * `issuer`, `endpoints` and `client` are absent only for credentials created by `importToken`
 * before any login; they cannot be refreshed or revoked.
 */
const StoredCredentials = Type.Object({
  version: Type.Literal(1),
  resource: Type.String(),
  issuer: Type.Optional(Type.String()),
  endpoints: Type.Optional(StoredEndpoints),
  client: Type.Optional(StoredClient),
  token: Type.Optional(StoredToken),
});

export type StoredEndpoints = Static<typeof StoredEndpoints>;
export type StoredClient = Static<typeof StoredClient>;
export type StoredToken = Static<typeof StoredToken>;
export type StoredCredentials = Static<typeof StoredCredentials>;

/** Undefined when no credentials file exists. Corrupt content is a config error; contents are never echoed. */
export async function readCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredentials | undefined> {
  const path = credentialsPath(env);
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return undefined;
    }
    throw new AtlError(`Cannot read credentials file ${path}`, {
      code: "credentials_unreadable",
      category: "config",
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw corrupt(path, error);
  }
  if (!check(StoredCredentials, parsed)) {
    throw corrupt(path);
  }
  return parsed;
}

function corrupt(path: string, cause?: unknown): AtlError {
  return new AtlError(`Credentials file ${path} is corrupt or has an unsupported format`, {
    code: "credentials_corrupt",
    category: "config",
    hint: "Delete the file and log in again.",
    next: [["atl", "auth", "login"]],
    cause,
  });
}

/** Atomic private write: directory 0700 and file 0600 on POSIX. */
export async function writeCredentials(
  credentials: StoredCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writePrivateFile(credentialsPath(env), `${JSON.stringify(credentials, null, 2)}\n`);
}

export async function deleteCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await Bun.file(credentialsPath(env)).delete();
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
  }
}
