import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

export interface PiRpcModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export interface PiModelCatalogEntry {
  readonly model: PiRpcModel;
  readonly thinkingLevels: ReadonlyArray<string>;
  readonly currentThinkingLevel?: string | undefined;
}

export interface PiModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function makePiModelSlug(input: PiModelSelection): string {
  return `${encodeURIComponent(input.provider)}/${encodeURIComponent(input.modelId)}`;
}

export function parsePiModelSlug(value: string): PiModelSelection | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }

  try {
    const provider = decodeURIComponent(value.slice(0, separator)).trim();
    const modelId = decodeURIComponent(value.slice(separator + 1)).trim();
    return provider && modelId ? { provider, modelId } : undefined;
  } catch {
    return undefined;
  }
}

function thinkingLabel(level: string): string {
  return THINKING_LEVEL_LABELS[level] ?? level;
}

function distinctThinkingLevels(levels: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const rawLevel of levels) {
    const level = rawLevel.trim();
    if (!level || seen.has(level)) {
      continue;
    }
    seen.add(level);
    valid.push(level);
  }
  return valid;
}

function modelCapabilities(input: PiModelCatalogEntry) {
  const levels = distinctThinkingLevels(input.thinkingLevels);
  // Pi reports `["off"]` for models without reasoning support. There is no
  // selectable alternative in that case, so omit the picker control rather
  // than fabricating a reasoning capability.
  if (levels.length <= 1) {
    return createModelCapabilities({ optionDescriptors: [] });
  }

  const current =
    input.currentThinkingLevel !== undefined && levels.includes(input.currentThinkingLevel)
      ? input.currentThinkingLevel
      : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: thinkingLabel(level),
          ...(level === current ? { isDefault: true } : {}),
        })),
        ...(current ? { currentValue: current } : {}),
      },
    ],
  });
}

/** Convert Pi's provider-scoped catalog into the normal T3 model picker shape. */
export function mapPiModelCatalog(
  catalog: ReadonlyArray<PiModelCatalogEntry>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const entry of catalog) {
    const provider = entry.model.provider.trim();
    const modelId = entry.model.id.trim();
    const name = entry.model.name.trim() || modelId;
    if (!provider || !modelId || !name) {
      continue;
    }

    const slug = makePiModelSlug({ provider, modelId });
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name,
      shortName: modelId,
      subProvider: provider,
      isCustom: false,
      capabilities: modelCapabilities(entry),
    });
  }

  return models;
}
