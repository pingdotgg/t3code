import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
} from "@t3tools/contracts";

export function resolveNewTaskInteractionMode(
  interactionMode: ProviderInteractionMode | undefined,
): ProviderInteractionMode {
  return interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
}

export function interactionModeFromPlanToggle(enabled: boolean): ProviderInteractionMode {
  return enabled ? "plan" : DEFAULT_PROVIDER_INTERACTION_MODE;
}
