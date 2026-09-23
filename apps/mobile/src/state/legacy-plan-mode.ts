import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";

type InteractionModeProvider = Pick<ServerProvider, "showInteractionModeToggle">;

/** Normalize saved T3 mode choices without changing native slash commands. */
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
    // Only an existing queued task may retain its previous mode while the
    // preference is unknown. A fresh draft still defaults to Build so a stale
    // persisted Plan selection cannot bypass a disabled preference at launch.
    return input.queuedInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  return DEFAULT_PROVIDER_INTERACTION_MODE;
}
