import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";

type InteractionModeProvider = Pick<ServerProvider, "showInteractionModeToggle">;

export function resolveProviderInteractionMode(
  provider: InteractionModeProvider | null | undefined,
  interactionMode: ProviderInteractionMode | null | undefined,
): ProviderInteractionMode {
  return provider?.showInteractionModeToggle === false
    ? DEFAULT_PROVIDER_INTERACTION_MODE
    : (interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE);
}

export function resolveLegacyPlanModeEnabled(input: {
  readonly loaded: boolean;
  readonly preference: boolean | undefined;
}): boolean {
  return input.loaded && input.preference === true;
}

export function resolvePendingTaskInteractionMode(input: {
  readonly preferenceLoaded: boolean;
  readonly planModeEnabled: boolean;
  readonly draftInteractionMode: ProviderInteractionMode | undefined;
  readonly queuedInteractionMode: ProviderInteractionMode | undefined;
  readonly provider?: InteractionModeProvider | null;
}): ProviderInteractionMode {
  if (input.provider?.showInteractionModeToggle === false) {
    return DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  if (input.planModeEnabled) {
    return input.draftInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  if (!input.preferenceLoaded) {
    return input.queuedInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  return DEFAULT_PROVIDER_INTERACTION_MODE;
}
