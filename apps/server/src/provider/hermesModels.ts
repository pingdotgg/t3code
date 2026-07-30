import {
  DEFAULT_HERMES_MODEL,
  type HermesGatewayCatalogModel,
  type HermesGatewayModelsListResponse,
  type HermesGatewayRequestedModelSelection,
  type HermesGatewayReasoningEffort,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

const HERMES_MODEL_SLUG_PREFIX = "hermes-model:";

const REASONING_LABELS: Readonly<Record<HermesGatewayReasoningEffort, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/**
 * T3 model slugs are opaque UI/persistence identifiers. Hermes model ids are
 * only unique inside a provider, so both components are encoded rather than
 * exposing the ambiguous bare model id as the slug.
 */
export function encodeHermesModelSlug(input: {
  readonly provider: string;
  readonly model: string;
}) {
  return `${HERMES_MODEL_SLUG_PREFIX}${encodeURIComponent(input.provider)}:${encodeURIComponent(input.model)}`;
}

/** Translate a persisted T3 slug into the structured gateway selection. */
export function decodeHermesModelSlug(
  slug: string,
): HermesGatewayRequestedModelSelection | undefined {
  if (slug === DEFAULT_HERMES_MODEL) return { mode: "default" };
  if (!slug.startsWith(HERMES_MODEL_SLUG_PREFIX)) return undefined;
  const encoded = slug.slice(HERMES_MODEL_SLUG_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return undefined;
  try {
    const provider = decodeURIComponent(encoded.slice(0, separator)).trim();
    const model = decodeURIComponent(encoded.slice(separator + 1)).trim();
    return provider && model ? { mode: "specific", provider, model } : undefined;
  } catch {
    return undefined;
  }
}

function reasoningCapabilities(input: {
  readonly catalog: HermesGatewayModelsListResponse | undefined;
  readonly enabled: boolean;
}): ModelCapabilities {
  const efforts = input.catalog?.reasoningEfforts ?? [];
  if (!input.enabled || efforts.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  // The catalog's currentReasoningEffort is Hermes' global setting, not the
  // effective default for every model: per-model reasoning_overrides may win.
  // Leave the descriptor unresolved so an untouched T3 control delegates to
  // Hermes; only an explicit user selection becomes a session override.
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: efforts.map((effort) => ({
          id: effort,
          label: REASONING_LABELS[effort],
        })),
      },
    ],
  });
}

function isCurrentCatalogModel(
  entry: HermesGatewayCatalogModel,
  catalog: HermesGatewayModelsListResponse,
) {
  return entry.provider === catalog.currentProvider && entry.model === catalog.currentModel;
}

/** Build the normal T3 picker models from one Hermes catalog response. */
export function hermesServerModels(input: {
  readonly reportedModel: string | null | undefined;
  readonly catalog: HermesGatewayModelsListResponse | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const currentModel = input.catalog?.currentModel ?? input.reportedModel ?? undefined;
  const currentEntry = input.catalog?.models.find((entry) =>
    isCurrentCatalogModel(entry, input.catalog!),
  );
  const defaultCapabilities = reasoningCapabilities({
    catalog: input.catalog,
    // Hermes treats uncatalogued models as reasoning-capable. Preserve that
    // graceful fallback so a partial/older inventory does not hide the dial.
    enabled: currentEntry?.supportsReasoning ?? true,
  });
  const models: ServerProviderModel[] = [
    {
      slug: DEFAULT_HERMES_MODEL,
      name: currentModel ? `${currentModel} (Hermes default)` : "Hermes default",
      isCustom: false,
      isDefault: true,
      capabilities: defaultCapabilities,
    },
  ];
  if (!input.catalog) return models;

  const seen = new Set([DEFAULT_HERMES_MODEL]);
  for (const entry of input.catalog.models) {
    const slug = encodeHermesModelSlug(entry);
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: entry.model,
      subProvider: entry.providerName,
      isCustom: false,
      capabilities: reasoningCapabilities({
        catalog: input.catalog,
        enabled: entry.supportsReasoning,
      }),
    });
  }
  return models;
}
