// No Bun equivalents: os.homedir (falls back to the passwd entry) and path.join (win32-aware).
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config directory: $ATL_CONFIG_DIR, else %APPDATA%\atl on Windows,
 * else $XDG_CONFIG_HOME/atl, else ~/.config/atl.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ATL_CONFIG_DIR) {
    return env.ATL_CONFIG_DIR;
  }
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "atl");
  }
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "atl");
  }
  return join(homedir(), ".config", "atl");
}

/** OAuth client registration + tokens. Written with mode 0600. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

/** Lock file guarding refresh-token rotation across processes. */
export function refreshLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "refresh.lock");
}

/** User settings (default site) and the cloudId cache. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}
