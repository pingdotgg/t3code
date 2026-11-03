// A harness-native install (`pstack@<marketplace>`) that T3's pack replaces.
const isNativePstackPluginKey = (key: string) => key.startsWith("pstack@");

/** Codex app-server `-c` overrides that switch off the pstack plugins a config.toml declares. */
export function codexPstackPluginOverrideArgs(configToml: string): ReadonlyArray<string> {
  return (
    [...configToml.matchAll(/^\s*\[plugins\."([^"]+)"\]/gm)]
      .map((match) => match[1]!)
      // Codex splits -c keys on every dot and keeps quotes, so only dot-free keys are addressable.
      .filter((key) => isNativePstackPluginKey(key) && !key.includes("."))
      .flatMap((key) => ["-c", `plugins.${key}.enabled=false`])
  );
}

/** Claude flag-settings `enabledPlugins` entries that switch off enabled pstack plugins. */
export function claudePstackPluginOverrides(
  enabledPlugins: ReadonlyMap<string, boolean>,
): Record<string, false> | undefined {
  const keys = [...enabledPlugins]
    .filter(([key, enabled]) => enabled && isNativePstackPluginKey(key))
    .map(([key]) => key);
  return keys.length === 0 ? undefined : Object.fromEntries(keys.map((key) => [key, false]));
}
