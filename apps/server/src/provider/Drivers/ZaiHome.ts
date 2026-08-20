/**
 * ZaiHome — instance shaping for the Z.ai driver.
 *
 * Z.ai has no CLI of its own: the GLM Coding Plan is an Anthropic-compatible
 * endpoint that Claude Code talks to via `ANTHROPIC_BASE_URL` +
 * `ANTHROPIC_AUTH_TOKEN`. These helpers map {@link ZaiSettings} onto the
 * Claude settings + environment the shared Claude runtime already consumes,
 * keeping the endpoint env scoped to a single instance's spawns.
 *
 * @module provider/Drivers/ZaiHome
 */
import type {
  ClaudeSettings,
  ProviderInstanceEnvironment,
  ProviderInstanceEnvironmentVariable,
  ZaiSettings,
} from "@t3tools/contracts";

export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
export const ZAI_BASE_URL_ENV_VAR = "ANTHROPIC_BASE_URL";
export const ZAI_AUTH_TOKEN_ENV_VAR = "ANTHROPIC_AUTH_TOKEN";

/**
 * Z.ai sessions always get their own Claude config dir so credentials,
 * session files, and the continuation group key never collide with stock
 * Claude instances (empty `homePath` would resolve to the shared `~/.claude`).
 */
export const DEFAULT_ZAI_HOME_PATH = "~/.claude-zai";

export function resolveZaiApiEndpoint(config: Pick<ZaiSettings, "apiEndpoint">): string {
  const endpoint = config.apiEndpoint.trim();
  return endpoint.length > 0 ? endpoint : ZAI_ANTHROPIC_BASE_URL;
}

export function resolveZaiHomePath(config: Pick<ZaiSettings, "homePath">): string {
  const homePath = config.homePath.trim();
  return homePath.length > 0 ? homePath : DEFAULT_ZAI_HOME_PATH;
}

/** Map Z.ai settings onto the Claude settings consumed by the shared runtime. */
export function claudeSettingsForZai(
  config: ZaiSettings,
  enabled: boolean = config.enabled,
): ClaudeSettings {
  return {
    enabled,
    binaryPath: config.binaryPath,
    homePath: resolveZaiHomePath(config),
    customModels: config.customModels,
    launchArgs: config.launchArgs,
  };
}

/**
 * Instance environment for a Z.ai instance: the endpoint plus (when set in
 * config) the auth token, followed by the user's own entries so explicit
 * environment variables always win over config-derived values.
 */
export function zaiInstanceEnvironment(
  config: ZaiSettings,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
): ProviderInstanceEnvironment {
  const entries: Array<ProviderInstanceEnvironmentVariable> = [
    { name: ZAI_BASE_URL_ENV_VAR, value: resolveZaiApiEndpoint(config), sensitive: false },
  ];
  const apiKey = config.apiKey.trim();
  if (apiKey.length > 0) {
    entries.push({ name: ZAI_AUTH_TOKEN_ENV_VAR, value: apiKey, sensitive: true });
  }
  return [...entries, ...(instanceEnvironment ?? [])];
}
