/**
 * Grok checks for a newer CLI when it launches. T3's health probes
 * (`grok --version`, `grok models`, `grok inspect --json`, ACP `initialize`)
 * run periodically in the background, so an update they start is invisible,
 * and on Windows it opens a console window for npm. Grok documents
 * `GROK_DISABLE_AUTOUPDATER=1` as process-scoped suppression, so probes set it
 * on a copy of the caller's environment. Sessions, text generation, and
 * `grok update` keep the caller's environment and update as the user configured.
 */
export function grokProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, GROK_DISABLE_AUTOUPDATER: "1" };
}
