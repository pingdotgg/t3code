/**
 * The product name this server belongs to, for messages a user reads.
 *
 * The desktop app passes its brand down when it starts the backend, so a
 * Munim build says "MT Code" where the official build says "T3 Code". A
 * standalone server (CLI, SSH, WSL) has no brand to inherit and keeps the
 * upstream name.
 *
 * @module provider-core/server/appDisplayName
 */

export const DEFAULT_APP_DISPLAY_NAME = "T3 Code";

export function resolveAppDisplayName(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.T3CODE_APP_DISPLAY_NAME?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_APP_DISPLAY_NAME;
}

/** "<Provider> is disabled in <App> settings." */
export function providerDisabledMessage(
  providerLabel: string,
  env?: Record<string, string | undefined>,
): string {
  return `${providerLabel} is disabled in ${resolveAppDisplayName(env)} settings.`;
}
