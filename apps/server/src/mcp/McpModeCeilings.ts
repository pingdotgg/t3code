import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

export function runtimeModeWithinMcpCeiling(
  callerMode: RuntimeMode,
  targetMode: RuntimeMode,
): boolean {
  return runtimeModeRank(targetMode) <= runtimeModeRank(callerMode);
}

export function interactionModeWithinMcpCeiling(
  callerMode: ProviderInteractionMode,
  targetMode: ProviderInteractionMode,
): boolean {
  return interactionModeRank(targetMode) <= interactionModeRank(callerMode);
}
