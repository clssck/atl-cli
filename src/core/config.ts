import { Type, type Static } from "./schema.ts";
import { AtlError } from "./errors.ts";
import { writePrivateFile } from "./fs.ts";
import { configPath } from "./paths.ts";
import { check, firstIssue } from "./validate.ts";

const SiteEntry = Type.Object({
  cloudId: Type.String(),
  name: Type.String(),
  url: Type.String(),
  scopes: Type.Array(Type.String()),
  cachedAt: Type.String(),
});

const ConfigSchema = Type.Object({
  defaultSite: Type.Optional(Type.String()),
  sites: Type.Optional(Type.Record(Type.String(), SiteEntry)),
});

export type SiteEntry = Static<typeof SiteEntry>;
export type AtlConfig = Static<typeof ConfigSchema>;

/** Read the config file; a missing file is an empty config, a malformed one is a `config` error. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AtlConfig> {
  const path = configPath(env);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (error) {
    throw new AtlError(`Config file is not valid JSON: ${path}`, {
      code: "config_malformed",
      category: "config",
      hint: "Fix or delete the file; `atl sites` rebuilds the site cache.",
      cause: error,
    });
  }
  if (!check(ConfigSchema, parsed)) {
    const at = firstIssue(ConfigSchema, parsed)?.path;
    const where = at === undefined || at === "" ? "root" : at;
    throw new AtlError(`Config file has an invalid shape at ${where}: ${path}`, {
      code: "config_malformed",
      category: "config",
      hint: "Fix or delete the file; `atl sites` rebuilds the site cache.",
    });
  }
  return parsed;
}

/** Atomically write the config (tmp file + rename); directory mode 0700, file mode 0600. */
export async function saveConfig(
  config: AtlConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writePrivateFile(configPath(env), `${JSON.stringify(config, null, 2)}\n`);
}
