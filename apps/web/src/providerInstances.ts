import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
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

export type ProviderCatalogAvailability = "loading" | "ready" | "unavailable" | "unconfigured";

/**
 * Environment config streams are reactive: treating their initial `null` as a
 * final empty list strands otherwise recoverable threads behind a misleading
 * "no providers" state.
 */
export function resolveProviderCatalogAvailability(input: {
  readonly catalogLoaded: boolean;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selectedEntry: ProviderInstanceEntry | undefined;
}): ProviderCatalogAvailability {
  if (!input.catalogLoaded) return "loading";
  if (input.selectedEntry !== undefined) return "ready";
  return input.entries.length === 0 ? "unconfigured" : "unavailable";
}

/**
 * Disabling an instance updates `enabled` independently, while its previous `ready` probe
 * status can remain in the streamed snapshot until reconciliation.
 */
export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.isAvailable && entry.status === "ready";
}

export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled;
}

export function deriveProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return providers.map((snapshot) => {
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
  });
}

/**
 * Instance ids are per-environment routing keys, and `defaultInstanceIdForDriver` makes the
 * default id literally the driver slug, so every environment running the same driver reports
 * the same id. Flattening across environments would clobber entries and mis-resolve accent
 * colors; lookups must stay scoped to the thread's own environment.
 */
export function deriveProviderEntriesByEnvironment(
  providersByEnvironment: Iterable<
    readonly [
      string,
      ReadonlyArray<ServerProvider>,
      Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">?,
    ]
  >,
): ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>> {
  const byEnvironment = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
  for (const [environmentId, providers, settings] of providersByEnvironment) {
    const derived = deriveProviderInstanceEntries(providers);
    // The snapshot includes instances enabled by any project; machine settings alone do not.
    const entries = settings
      ? derived.map((entry) => applyProviderInstanceBranding(entry, settings))
      : derived;
    byEnvironment.set(
      environmentId,
      new Map(entries.map((entry) => [entry.instanceId as string, entry] as const)),
    );
  }
  return byEnvironment;
}

/**
 * `projectId` folds in that project's `providerInstances[id].enabled` override (enable or
 * disable in either direction over the machine value); `null` resolves the machine value only.
 * It has no default: a caller that renders for a single project but forgets to pass it would
 * silently show the machine's enablement instead of that project's, so passing `null` for a
 * surface that isn't project-aware must be a deliberate choice, not an omission.
 */
export function applyProviderInstanceSettings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
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

function applyProviderInstanceBranding(
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

export function sortProviderInstanceEntries(
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

function getProviderInstanceEntry(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId);
}

export function getDefaultProviderInstanceModel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): string | undefined {
  const entry = getProviderInstanceEntry(providers, instanceId);
  if (!entry) return undefined;
  return (
    entry.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    entry.models.find((model) => !model.isCustom)?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind]
  );
}

const isSelectableProviderInstanceEntry = (entry: ProviderInstanceEntry): boolean =>
  entry.enabled && entry.isAvailable;

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
): ModelSelection | null {
  const instanceId = resolveSelectableProviderInstance(providers, selection?.instanceId);
  if (instanceId === undefined) return null;
  if (selection?.instanceId === instanceId) return selection;
  const model = getDefaultProviderInstanceModel(providers, instanceId);
  return model ? { instanceId, model } : null;
}
