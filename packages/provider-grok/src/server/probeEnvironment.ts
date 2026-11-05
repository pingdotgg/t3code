/** Suppress probe-time updater consoles on Windows; preserve update settings for other invocations. */
export function grokProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, GROK_DISABLE_AUTOUPDATER: "1" };
}
