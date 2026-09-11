import type { RuntimeMode } from "@t3tools/contracts";

const ALL_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

const OPENCODE_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** OpenCode has no automatic reviewer, so its picker omits Auto. */
export function runtimeModesForProvider(
  providerDriver: string | null | undefined,
): ReadonlyArray<RuntimeMode> {
  return providerDriver === "opencode" ? OPENCODE_RUNTIME_MODES : ALL_RUNTIME_MODES;
}

/**
 * Older OpenCode threads can retain a mode that is not available in its picker.
 * Auto behaves like supervised; auto-accept edits must retain its accurate label.
 */
export function visibleRuntimeModeForProvider(
  runtimeMode: RuntimeMode,
  providerDriver: string | null | undefined,
): RuntimeMode {
  return providerDriver === "opencode" && runtimeMode === "auto"
    ? "approval-required"
    : runtimeMode;
}
