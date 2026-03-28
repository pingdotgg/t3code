import { homedir } from "node:os";
import { join } from "node:path";

export type EnvAlias = readonly [preferred: string, legacy: string];

export const TERO_HOME_DIRNAME = ".tero";
export const TERO_DEV_HOME_DIRNAME = ".tero-dev";

export const TERO_RUNTIME_ENV_ALIASES = [
  ["TERO_MODE", "T3CODE_MODE"],
  ["TERO_PORT", "T3CODE_PORT"],
  ["TERO_HOST", "T3CODE_HOST"],
  ["TERO_HOME", "T3CODE_HOME"],
  ["TERO_NO_BROWSER", "T3CODE_NO_BROWSER"],
  ["TERO_AUTH_TOKEN", "T3CODE_AUTH_TOKEN"],
  ["TERO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD"],
  ["TERO_LOG_WS_EVENTS", "T3CODE_LOG_WS_EVENTS"],
] as const satisfies ReadonlyArray<EnvAlias>;

export const TERO_DEV_RUNNER_ENV_ALIASES = [
  ["TERO_PORT_OFFSET", "T3CODE_PORT_OFFSET"],
  ["TERO_DEV_INSTANCE", "T3CODE_DEV_INSTANCE"],
  ...TERO_RUNTIME_ENV_ALIASES,
  ["TERO_DESKTOP_WS_URL", "T3CODE_DESKTOP_WS_URL"],
] as const satisfies ReadonlyArray<EnvAlias>;

export function getDefaultTeroHomePath(
  runtime: "development" | "production",
  homeDirectory = homedir(),
): string {
  return join(homeDirectory, runtime === "development" ? TERO_DEV_HOME_DIRNAME : TERO_HOME_DIRNAME);
}

export function normalizeEnvAliases(
  aliases: ReadonlyArray<EnvAlias>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly onConflict?: (alias: { preferred: string; legacy: string }) => void;
  } = {},
): void {
  const env = options.env ?? process.env;

  for (const [preferred, legacy] of aliases) {
    const preferredValue = env[preferred]?.trim();
    const legacyValue = env[legacy]?.trim();
    if (
      preferredValue !== undefined &&
      legacyValue !== undefined &&
      preferredValue.length > 0 &&
      legacyValue.length > 0 &&
      preferredValue !== legacyValue
    ) {
      options.onConflict?.({ preferred, legacy });
    }
  }

  for (const [preferred, legacy] of aliases) {
    if (env[preferred] === undefined && env[legacy] !== undefined) {
      env[preferred] = env[legacy];
    }
  }
}
