import { pipe } from "effect/Function";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  inferenceHarness,
  isInferenceAccountReplaced,
  isInferenceRoutingEnabled,
  providerLimitedUntilMs,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type ServerProviderState,
} from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";

export { normalizeProviderAccentColor, shouldShowInstanceBadge };

export function usesHostedModelCatalog(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  config: unknown,
): boolean {
  return (
    instanceId === defaultInstanceIdForDriver(driver) &&
    inferenceHarness(driver)?.replacesAccounts === true &&
    isInferenceRoutingEnabled(config)
  );
}

export function normalizeHostedModelCatalog(
  models: ReadonlyArray<ServerProviderModel>,
  config: unknown,
): ReadonlyArray<ServerProviderModel> {
  const hostedSlugs =
    typeof config === "object" &&
    config !== null &&
    "inferenceModels" in config &&
    Array.isArray(config.inferenceModels)
      ? new Set<unknown>(config.inferenceModels)
      : null;
  // Older hosts mark models discovered through CLI proxy as custom.
  return models
    .filter((model) => (hostedSlugs === null ? !model.isCustom : hostedSlugs.has(model.slug)))
    .map((model) => (model.isCustom ? { ...model, isCustom: false } : model));
}

type ProviderInstanceSettings = Pick<
  ServerSettings,
  "providerInstances" | "projectSettingsOverrides"
>;

/**
 * Local-only placeholder used while a draft has no provider it can safely
 * target. It must never be persisted or dispatched; the composer disables
 * send until a live provider replaces it.
 */
export const NO_PROVIDER_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("t3code_no_provider"),
  model: "",
};

export interface ProviderInstanceEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
  readonly continuationGroupKey?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProviderState;
  readonly isDefault: boolean;
  readonly isAvailable: boolean;
  readonly snapshot: ServerProvider;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/** Status dots share one corner per user, so a badge on one row can't move only that row's dot. */
export function hasInstanceBadge(entries: ReadonlyArray<ProviderInstanceEntry>): boolean {
  return entries.some((entry) => shouldShowInstanceBadge(entry, entries));
}

/** Disabled instances may retain ready status until reconciliation. */
export function isProviderInstancePickerReady(
  entry: Pick<ProviderInstanceEntry, "enabled" | "isAvailable" | "status" | "snapshot">,
): boolean {
  return isProviderInstancePickerVisible(entry) && entry.status === "ready";
}

export function isProviderInstancePickerVisible(
  entry: Pick<ProviderInstanceEntry, "enabled" | "isAvailable" | "status" | "snapshot">,
): boolean {
  return (
    entry.enabled &&
    entry.isAvailable &&
    entry.status !== "error" &&
    entry.status !== "disabled" &&
    providerLimitedUntilMs(entry.snapshot, Date.now()) === null
  );
}

export function deriveProviderInstanceEntry(snapshot: ServerProvider): ProviderInstanceEntry {
  const instanceId = snapshot.instanceId;
  const driverKind = snapshot.driver;
  const defaultId = defaultInstanceIdForDriver(driverKind);
  const isDefault = instanceId === defaultId;
  return {
    instanceId,
    driverKind,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
    ...(driverKind === "acpRegistry" && snapshot.iconUrl
      ? { acpRegistryIconUrl: snapshot.iconUrl }
      : {}),
    continuationGroupKey: snapshot.continuation?.groupKey,
    enabled: snapshot.enabled,
    installed: snapshot.installed,
    status: snapshot.status,
    isDefault,
    isAvailable: snapshot.availability !== "unavailable",
    snapshot,
    models: snapshot.models,
  } satisfies ProviderInstanceEntry;
}

export function deriveProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return providers.map(deriveProviderInstanceEntry);
}

/** Instance ids repeat across environments; lookups must stay scoped. */
export function deriveProviderEntriesByEnvironment(
  providersByEnvironment: Iterable<
    readonly [string, ReadonlyArray<ServerProvider>, ProviderInstanceSettings?]
  >,
): ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>> {
  const byEnvironment = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
  for (const [environmentId, providers, settings] of providersByEnvironment) {
    const derived = deriveProviderInstanceEntries(providers);
    const entries = settings ? brandProviderInstanceEntries(derived, settings) : derived;
    byEnvironment.set(
      environmentId,
      new Map(entries.map((entry) => [entry.instanceId as string, entry] as const)),
    );
  }
  return byEnvironment;
}

// The snapshot includes instances enabled by any project; machine settings alone do not.
export function brandProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<ServerSettings, "providerInstances">,
): ReadonlyArray<ProviderInstanceEntry> {
  return entries.map((entry) => applyProviderInstanceBranding(entry, settings));
}

/** projectId applies project overrides; explicit null uses machine settings. */
export function applyProviderInstanceSettings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: ProviderInstanceSettings,
  projectId: ProjectId | null,
): ReadonlyArray<ProviderInstanceEntry> {
  return entries.map((entry) => {
    const enabled = resolveProjectProviderInstanceEnabled(settings, projectId, entry.instanceId);
    return applyProviderInstanceBranding(
      enabled === entry.enabled ? entry : { ...entry, enabled },
      settings,
    );
  });
}

export function applyProviderInstanceBranding(
  entry: ProviderInstanceEntry,
  settings: Pick<ServerSettings, "providerInstances">,
): ProviderInstanceEntry {
  const explicitInstance = Object.hasOwn(settings.providerInstances, entry.instanceId)
    ? settings.providerInstances[entry.instanceId]
    : undefined;
  if (entry.driverKind !== "acpRegistry" || explicitInstance === undefined) return entry;
  const config =
    explicitInstance.config !== null && typeof explicitInstance.config === "object"
      ? (explicitInstance.config as Readonly<Record<string, unknown>>)
      : null;
  if (config?.source === "local") {
    return { ...entry, acpRegistryAgentId: undefined, acpRegistryIconUrl: undefined };
  }
  const agentId = config?.agentId;
  const iconUrl = config?.registryIconUrl;
  return {
    ...entry,
    ...(typeof agentId === "string" && agentId.trim()
      ? { acpRegistryAgentId: agentId.trim() }
      : {}),
    ...(typeof iconUrl === "string" && iconUrl.trim()
      ? { acpRegistryIconUrl: iconUrl.trim() }
      : {}),
  };
}

/** Picker order: each driver's default instance first, then its custom instances. */
export function providerInstanceEntriesFor(
  providers: ReadonlyArray<ServerProvider>,
  settings: ProviderInstanceSettings,
  projectId: ProjectId | null,
  retainedInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined> = [],
): ReadonlyArray<ProviderInstanceEntry> {
  return pipe(
    deriveProviderInstanceEntries(
      providers.filter(
        (provider) =>
          retainedInstanceIds.includes(provider.instanceId) ||
          !isInferenceAccountReplaced(provider.instanceId, settings.providerInstances),
      ),
    ),
    (entries) => applyProviderInstanceSettings(entries, settings, projectId),
    sortProviderInstanceEntries,
  );
}

function sortProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  const byKind = new Map<ProviderDriverKind, ProviderInstanceEntry[]>();
  for (const entry of entries) {
    const bucket = byKind.get(entry.driverKind);
    if (bucket) {
      bucket.push(entry);
    } else {
      byKind.set(entry.driverKind, [entry]);
    }
  }
  const sorted: ProviderInstanceEntry[] = [];
  for (const bucket of byKind.values()) {
    const defaults = bucket.filter((entry) => entry.isDefault);
    const customs = bucket.filter((entry) => !entry.isDefault);
    sorted.push(...defaults, ...customs);
  }
  return sorted;
}

export function deriveComposerProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
  settings: ProviderInstanceSettings,
  projectId: ProjectId | null,
  retainedInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined> = [],
): ReadonlyArray<ProviderInstanceEntry> {
  return providerInstanceEntriesFor(providers, settings, projectId, retainedInstanceIds);
}

function getProviderInstanceEntry(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId);
}

export function getDefaultProviderInstanceModel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  settings?: Pick<ServerSettings, "providerInstances">,
): string | undefined {
  const entry = getProviderInstanceEntry(providers, instanceId);
  if (!entry) return undefined;
  const config = settings?.providerInstances[instanceId]?.config;
  const models = usesHostedModelCatalog(instanceId, entry.driverKind, config)
    ? normalizeHostedModelCatalog(entry.models, config)
    : entry.models;
  return (
    models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind]
  );
}

const isSelectableProviderInstanceEntry = (entry: ProviderInstanceEntry): boolean =>
  isProviderInstancePickerVisible(entry);

export function resolveSelectableProviderInstanceEntry(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceEntry | undefined {
  if (instanceId !== undefined) {
    const requested = entries.find((entry) => entry.instanceId === instanceId);
    if (requested && isSelectableProviderInstanceEntry(requested)) {
      return requested;
    }
  }
  return (
    entries.find(isProviderInstancePickerReady) ??
    entries.find((entry) => isSelectableProviderInstanceEntry(entry) && entry.status !== "error")
  );
}

export function resolveSelectableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceId | undefined {
  const entries = deriveProviderInstanceEntries(providers);
  return resolveSelectableProviderInstanceEntry(entries, instanceId)?.instanceId;
}

export function resolveDefaultProviderModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
  settings?: Pick<ServerSettings, "providerInstances">,
): ModelSelection | null {
  const instanceId = resolveSelectableProviderInstance(
    settings
      ? providers.filter(
          (provider) =>
            provider.instanceId === selection?.instanceId ||
            !isInferenceAccountReplaced(provider.instanceId, settings.providerInstances),
        )
      : providers,
    selection?.instanceId,
  );
  if (instanceId === undefined) return null;
  if (selection?.instanceId === instanceId) return selection;
  const model = getDefaultProviderInstanceModel(providers, instanceId, settings);
  return model ? { instanceId, model } : null;
}

export function resolveProjectDefaultProviderModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  settings: ProviderInstanceSettings,
  projectId: ProjectId | null,
): ModelSelection | null {
  const entries = deriveComposerProviderInstanceEntries(providers, settings, projectId);
  // Matches resolveComposerProviderSelection: the first driver group wins before any other.
  const entry =
    resolveSelectableProviderInstanceEntry(
      entries.filter((candidate) => candidate.driverKind === entries[0]?.driverKind),
      undefined,
    ) ?? resolveSelectableProviderInstanceEntry(entries, undefined);
  const model = entry
    ? getDefaultProviderInstanceModel(providers, entry.instanceId, settings)
    : undefined;
  return entry && model ? { instanceId: entry.instanceId, model } : null;
}
