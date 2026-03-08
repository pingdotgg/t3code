import type { ProviderInteractionMode, ProviderPlanModeContext } from "@t3tools/contracts";

export function resolveEffectivePlanModeContext(input: {
  interactionMode: ProviderInteractionMode;
  storedPlanModeContext: ProviderPlanModeContext | null | undefined;
  hasActiveProposedPlan: boolean;
}): ProviderPlanModeContext | null {
  if (input.interactionMode !== "plan" || !input.hasActiveProposedPlan) {
    return null;
  }
  return input.storedPlanModeContext ?? "follow-up";
}

export function defaultPlanModeContextForInteractionMode(input: {
  interactionMode: ProviderInteractionMode;
  hasActiveProposedPlan: boolean;
}): ProviderPlanModeContext | null {
  if (input.interactionMode !== "plan" || !input.hasActiveProposedPlan) {
    return null;
  }
  return "follow-up";
}

export function nextPlanModeContextAfterSuccessfulPlanTurn(
  planModeContext: ProviderPlanModeContext | null | undefined,
): ProviderPlanModeContext | null {
  if (planModeContext === "new") {
    return "follow-up";
  }
  return planModeContext ?? null;
}
