import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { providerInteractionModeControlsEnabled } from "@t3tools/shared/model";

export function resolveMobileThreadInteractionMode(input: {
  readonly preferenceLoaded: boolean;
  readonly planModeEnabled: boolean;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">
  >;
  readonly modelSelection: Pick<ModelSelection, "instanceId"> | null | undefined;
  readonly preferredMode: ProviderInteractionMode | null | undefined;
  readonly fallbackMode: ProviderInteractionMode | null | undefined;
}): ProviderInteractionMode {
  const providerSupportsInteractionMode = providerInteractionModeControlsEnabled({
    planModeEnabled: true,
    providers: input.providers,
    modelSelection: input.modelSelection,
  });
  if (!providerSupportsInteractionMode || (input.preferenceLoaded && !input.planModeEnabled)) {
    return DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  return input.preferredMode ?? input.fallbackMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
}
