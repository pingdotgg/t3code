import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

export const isNonMutatingInteractionMode = (mode: ProviderInteractionMode): boolean =>
  mode === "advisor";

export const resolveEffectiveRuntimeMode = (
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode | undefined,
): RuntimeMode =>
  interactionMode !== undefined && isNonMutatingInteractionMode(interactionMode)
    ? "approval-required"
    : runtimeMode;
