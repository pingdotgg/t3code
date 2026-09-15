import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, resolveSelectableModel } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

// Brand labels for driver slugs the contracts map does not cover (yet). `piAgent`
// is the pre-rename Pi driver slug still present in persisted thread sessions;
// both it and `omp` must read as the configured "Oh My Pi" display name. Kept
// beside the formatter (not in contracts) so web can cover legacy slugs
// without widening the server's driver union.
const LEGACY_PROVIDER_DRIVER_KIND_LABELS: Readonly<Record<string, string>> = {
  piAgent: "Oh My Pi",
  omp: "Oh My Pi",
};

function humanizeProviderSlug(slug: string): string {
  const humanized = slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return humanized.length > 0 ? humanized : slug;
}

// User-facing driver label. Brand names win (contracts map, then legacy
// aliases); unknown/fork slugs fall back to a humanized slug so every driver
// renders something readable instead of its raw id.
export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return (
    PROVIDER_DISPLAY_NAMES[provider] ??
    LEGACY_PROVIDER_DRIVER_KIND_LABELS[provider] ??
    humanizeProviderSlug(provider)
  );
}

function formatDriverSlugLabel(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed.length === 0) return trimmed;
  if (isProviderDriverKind(trimmed)) return formatProviderDriverKindLabel(trimmed);
  return LEGACY_PROVIDER_DRIVER_KIND_LABELS[trimmed] ?? humanizeProviderSlug(trimmed);
}

// Thread-row provider name with the configured instance label winning over the
// driver slug. `configuredDisplayName` is the catalog entry's already-resolved
// label; `sessionProviderName` is the persisted driver slug
// (`thread.session.providerName`); `fallbackInstanceId` is the thread's model
// routing key for threads with no catalog entry and no session binding.
export function resolveThreadProviderDisplayName(input: {
  readonly configuredDisplayName?: string | null | undefined;
  readonly sessionProviderName?: string | null | undefined;
  readonly fallbackInstanceId?: string | ProviderInstanceId | null | undefined;
}): string {
  const configured = input.configuredDisplayName?.trim();
  if (configured) return configured;
  const sessionSlug = input.sessionProviderName?.trim();
  if (sessionSlug) return formatDriverSlugLabel(sessionSlug);
  const fallback = input.fallbackInstanceId?.trim();
  if (fallback) return formatDriverSlugLabel(fallback);
  return "";
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
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
  const slug = resolveSelectableModel(provider, model, models);
  const selectedModel = models.find((candidate) => candidate.slug === slug);
  const caps = selectedModel?.capabilities ?? EMPTY_CAPABILITIES;
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
