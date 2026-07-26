import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "./providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudex");

export const CLAUDEX_DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER[DRIVER_KIND] ?? "claudex-luna";
export const CLAUDEX_MODEL_SLUGS = new Set(
  Object.values(MODEL_SLUG_ALIASES_BY_PROVIDER[DRIVER_KIND] ?? {}),
);
export const CLAUDEX_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;

type ClaudexEffort = (typeof CLAUDEX_EFFORT_VALUES)[number];

function createClaudexCapabilities(defaultEffort: ClaudexEffort): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
          { value: "max", label: "Max" },
          { value: "ultracode", label: "Ultracode" },
        ].map((option) => ({
          ...option,
          ...(option.value === defaultEffort ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

export const CLAUDEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claudex-luna",
    name: "Claudex Luna",
    isCustom: false,
    capabilities: createClaudexCapabilities("max"),
  },
  {
    slug: "claudex-sol",
    name: "Claudex Sol",
    isCustom: false,
    capabilities: createClaudexCapabilities("high"),
  },
];

export function getClaudexModel(model: string | undefined): ServerProviderModel | undefined {
  return CLAUDEX_MODELS.find((candidate) => candidate.slug === model);
}

export function getClaudexModelCapabilities(
  model: string | undefined,
): ModelCapabilities | undefined {
  const capabilities = getClaudexModel(model)?.capabilities;
  return capabilities ? (capabilities as ModelCapabilities) : undefined;
}

export function withClaudexModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const claudexModel = getClaudexModel(model.slug);
    if (!claudexModel) return model;
    return {
      ...model,
      name: claudexModel.name,
      capabilities: claudexModel.capabilities,
    };
  });
}

export function normalizeClaudexEffort(
  effort: string | null | undefined,
  _model?: string | null | undefined,
): string | undefined {
  if (
    !effort ||
    !CLAUDEX_EFFORT_VALUES.includes(effort as (typeof CLAUDEX_EFFORT_VALUES)[number])
  ) {
    return undefined;
  }

  // `ultracode` is a Claudex/Claude Code workflow setting layered on top
  // of the maximum API effort level, not a literal SDK/CLI effort value.
  return effort === "ultracode" ? "xhigh" : effort;
}
