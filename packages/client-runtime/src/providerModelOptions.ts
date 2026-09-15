import type {
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

/** Resolve display and dispatch together so both clients preserve exact native variant choices. */
export function resolveProviderModelOptions(
  capabilities: ModelCapabilities | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  modelPolicy: ServerProvider["modelPolicy"],
) {
  const exact = modelPolicy?.optionSelection === "exact";
  const descriptors = getProviderOptionDescriptors({
    caps: capabilities ?? {},
    selections,
    preserveUnavailableSelections: exact,
  });
  return {
    descriptors,
    selections:
      exact || !capabilities
        ? (selections ?? undefined)
        : buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections),
  };
}

/** The web composer defaults to Normal even when ACP defaults to Fast; native variants keep their defaults. */
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  modelPolicy?: ServerProvider["modelPolicy"],
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (
    modelPolicy?.optionSelection === "exact" ||
    selections?.some((selection) => selection.id === "fastMode") ||
    !caps.optionDescriptors?.some(
      (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
    )
  ) {
    return selections ?? undefined;
  }
  return [...(selections ?? []), { id: "fastMode", value: false }];
}
