import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const AGY_DRIVER_KIND = ProviderDriverKind.make("agy");

function getGroupedAgyModelVariants(models: ReadonlyArray<ServerProviderModel>): {
  readonly canonicalSlugs: ReadonlySet<string>;
  readonly variantSlugs: ReadonlySet<string>;
} {
  const canonicalSlugs = new Set<string>();
  const variantSlugs = new Set<string>();
  for (const model of models) {
    const match = /^(.*)-(low|medium|high)$/.exec(model.slug);
    const isIndividualVariant = / \((Low|Medium|High)\)$/.test(model.name);
    const reasoning = model.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort" && descriptor.type === "select",
    );
    if (isIndividualVariant || !match?.[1] || !reasoning || reasoning.type !== "select") continue;

    canonicalSlugs.add(model.slug);
    for (const option of reasoning.options) {
      variantSlugs.add(`${match[1]}-${option.id}`);
    }
  }
  return { canonicalSlugs, variantSlugs };
}

export function getGroupedProviderModelVariantSlugs(
  models: ReadonlyArray<ServerProviderModel>,
  provider: ProviderDriverKind | null | undefined,
): ReadonlySet<string> {
  return provider === AGY_DRIVER_KIND ? getGroupedAgyModelVariants(models).variantSlugs : new Set();
}

export function getVisibleProviderModels(
  models: ReadonlyArray<ServerProviderModel>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  if (provider !== AGY_DRIVER_KIND) return models;

  const { canonicalSlugs, variantSlugs } = getGroupedAgyModelVariants(models);
  return models.filter((model) => !variantSlugs.has(model.slug) || canonicalSlugs.has(model.slug));
}

export function getBuiltInProviderModelSlugs(
  models: ReadonlyArray<ServerProviderModel>,
  provider: ProviderDriverKind,
): ReadonlySet<string> {
  const slugs = new Set(models.filter((model) => !model.isCustom).map((model) => model.slug));
  for (const slug of getGroupedProviderModelVariantSlugs(models, provider)) {
    slugs.add(slug);
  }
  return slugs;
}

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
  planModeEnabled = true,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  const caps =
    models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
  if (planModeEnabled) {
    return caps;
  }
  return withoutPlanAgentOption(caps);
}

// The opencode "plan" agent is only reachable while legacy plan mode is on.
// With it off, drop the option so it cannot be selected or dispatched, and
// drop the descriptor entirely when nothing remains selectable. currentValue
// is re-resolved against the surviving options so a stale or defaulted "plan"
// value cannot leak back into dispatch.
function withoutPlanAgentOption(caps: ModelCapabilities): ModelCapabilities {
  return {
    ...caps,
    optionDescriptors: (caps.optionDescriptors ?? []).flatMap((descriptor) => {
      if (descriptor.type !== "select" || descriptor.id !== "agent") {
        return [descriptor];
      }
      const options = descriptor.options.filter((option) => option.id !== "plan");
      if (options.length === 0) {
        return [];
      }
      const currentValue =
        descriptor.currentValue && options.some((option) => option.id === descriptor.currentValue)
          ? descriptor.currentValue
          : (options.find((option) => option.isDefault)?.id ?? options[0]?.id);
      return [{ ...descriptor, options, ...(currentValue ? { currentValue } : {}) }];
    }),
  };
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL
  );
}
