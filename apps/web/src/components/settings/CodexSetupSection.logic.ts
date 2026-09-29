export function readCodexSetupMode(config: unknown): "managed" | "existing" {
  return config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "managed"
    ? "managed"
    : "existing";
}
