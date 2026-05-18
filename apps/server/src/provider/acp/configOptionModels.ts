import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { createModelCapabilities } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

interface AcpRegistrySessionSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<AcpRegistrySessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies AcpRegistrySessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies AcpRegistrySessionSelectOption,
        ),
  );
}

export function buildModelsFromAcpConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  // ACP spec: `category` is OPTIONAL. Some agents (Junie) omit it and only set `id: "model"`.
  // Per https://agentclientprotocol.com/protocol/schema#sessionconfigoptioncategory — clients
  // MUST handle missing/unknown categories gracefully. Match either signal.
  const modelOption = configOptions?.find(
    (option) => option.category === "model" || option.id === "model",
  );
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  const seen = new Set<string>();
  return modelChoices.flatMap((choice) => {
    if (!choice.value || seen.has(choice.value)) {
      return [];
    }
    seen.add(choice.value);
    return [
      {
        slug: choice.value,
        name: choice.name || choice.value,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

export function buildModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState?.availableModels?.length) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name?.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

export function buildModelsFromSessionSetup(setup: {
  readonly models?: EffectAcpSchema.SessionModelState | null;
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
}): ReadonlyArray<ServerProviderModel> {
  const fromConfigOptions = buildModelsFromAcpConfigOptions(setup.configOptions);
  if (fromConfigOptions.length > 0) {
    return fromConfigOptions;
  }
  return buildModelsFromSessionModelState(setup.models);
}
