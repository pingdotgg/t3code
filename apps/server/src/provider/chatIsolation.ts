import type * as Path from "effect/Path";

export function resolveChatIsolationConfig<Config>(
  config: Config,
  driver: string,
  instanceId: string,
  stateDir: string,
  path: Path.Path,
): Config {
  if (
    (driver !== "codex" && driver !== "claudeAgent") ||
    typeof config !== "object" ||
    config === null ||
    !("isolateChats" in config) ||
    config.isolateChats !== true
  )
    return config;

  return {
    ...config,
    homePath: path.join(
      stateDir,
      "providers",
      driver,
      encodeURIComponent(instanceId),
      "isolated-home",
    ),
    // A Codex shadow home links sessions and databases back to its shared home.
    ...(driver === "codex" ? { shadowHomePath: "" } : {}),
  };
}
