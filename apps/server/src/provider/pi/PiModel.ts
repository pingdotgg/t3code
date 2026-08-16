import type { ServerProviderModel } from "@t3tools/contracts";

import type { PiThinkingLevel } from "./PiRpcSchema.ts";

export interface PiDiscoveredModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
  readonly thinkingLevels?: ReadonlyArray<string>;
}

export interface PiModelDefaults {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: PiThinkingLevel;
}

const validSegment = (value: string): boolean => value.length > 0 && value.trim() === value;
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function encodePiModelSlug(provider: string, modelId: string): string | undefined {
  if (!validSegment(provider) || !validSegment(modelId)) return undefined;
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
}

export function decodePiModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined {
  const delimiter = slug.indexOf("/");
  if (delimiter < 0 || delimiter !== slug.lastIndexOf("/")) return undefined;
  const encodedProvider = slug.slice(0, delimiter);
  const encodedModelId = slug.slice(delimiter + 1);
  if (!encodedProvider || !encodedModelId) return undefined;
  try {
    const provider = decodeURIComponent(encodedProvider);
    const modelId = decodeURIComponent(encodedModelId);
    if (!validSegment(provider) || !validSegment(modelId)) return undefined;
    if (encodePiModelSlug(provider, modelId) !== slug) return undefined;
    return { provider, modelId };
  } catch {
    return undefined;
  }
}

export function piDiscoveredModelToServerProviderModel(
  model: PiDiscoveredModel,
  defaults?: PiModelDefaults,
): ServerProviderModel | undefined {
  const slug = encodePiModelSlug(model.provider, model.id);
  if (!slug || !validSegment(model.name)) return undefined;
  const thinkingLevels =
    model.thinkingLevels?.filter(validSegment) ?? (model.reasoning ? PI_THINKING_LEVELS : []);
  const isDefault = defaults?.provider === model.provider && defaults.modelId === model.id;
  const defaultThinkingLevel =
    defaults?.thinkingLevel && thinkingLevels.includes(defaults.thinkingLevel)
      ? defaults.thinkingLevel
      : undefined;
  return {
    slug,
    name: model.name,
    subProvider: model.provider,
    isCustom: false,
    ...(isDefault ? { isDefault: true } : {}),
    capabilities:
      thinkingLevels.length === 0
        ? null
        : {
            optionDescriptors: [
              {
                id: "thinkingLevel",
                label: "Thinking level",
                type: "select",
                options: thinkingLevels.map((level) => ({ id: level, label: level })),
                ...(defaultThinkingLevel ? { currentValue: defaultThinkingLevel } : {}),
              },
            ],
          },
  };
}

export function mapPiDiscoveredModels(
  models: ReadonlyArray<PiDiscoveredModel>,
  defaults?: PiModelDefaults,
): ReadonlyArray<ServerProviderModel> {
  return models.flatMap((model) => {
    const mapped = piDiscoveredModelToServerProviderModel(model, defaults);
    return mapped ? [mapped] : [];
  });
}
