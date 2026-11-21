import { pipe } from "effect/Function";
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

/** Placeholder for untargetable drafts. Never persist or dispatch it; disable send until replaced. */
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

/**
 * Disabled instances may retain ready status until reconciliation. A warning still offers
 * the models of sub-providers that report no problem of their own.
 */
function isProviderInstanceHealthy(entry: ProviderInstanceEntry): boolean {
  if (!entry.enabled || !entry.isAvailable) return false;
  if (entry.status === "ready") return true;
  if (entry.status !== "warning") return false;
  const usable = new Set(
    entry.snapshot.subProviders?.flatMap((subProvider) =>
      subProvider.unavailableReason === undefined ? [subProvider.name] : [],
    ),
  );
  return entry.models.some(
    (model) => model.subProvider !== undefined && usable.has(model.subProvider),
  );
}

/** Also true after a check that only failed or ran late: an earlier check's models stay offered. */
export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  if (isProviderInstanceHealthy(entry)) return true;
  const { subProviders, auth, modelsRetained } = entry.snapshot;
  if (!entry.enabled || !entry.isAvailable || subProviders !== undefined) return false;
  if (modelsRetained === true) return true;
  // The sign-in was confirmed, so the warning is about something else, such as a late catalog.
  return (
    entry.status === "warning" &&
    entry.installed &&
    auth.status === "authenticated" &&
    entry.models.length > 0
  );
}

export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled;
}

export type ModelPickerTab = ProviderInstanceId | "favorites";

// Favorites can load after the picker opens, so the default follows them until the user picks a tab.
export function resolveModelPickerTab(input: {
  activeInstanceId: ProviderInstanceId;
  chosenTab: ModelPickerTab | null;
  lastPickedTab: ModelPickerTab | null;
  hasFavorites: boolean;
  keepActiveInstance: boolean;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
}): ModelPickerTab {
  if (input.chosenTab !== null) {
    return input.chosenTab;
  }
  if (input.keepActiveInstance) {
    return input.activeInstanceId;
  }
  const lastPickedTab = input.lastPickedTab;
  // Only a tab the sidebar leaves enabled, so the picker never opens on an empty, unpickable list.
  const lastPickedEntry =
    lastPickedTab === null || lastPickedTab === "favorites"
      ? undefined
      : input.instanceEntries.find((entry) => entry.instanceId === lastPickedTab);
  if (
    lastPickedEntry !== undefined &&
    isProviderInstancePickerVisible(lastPickedEntry) &&
    (isProviderInstancePickerReady(lastPickedEntry) ||
      input.selectableUnavailableInstanceIds?.has(lastPickedEntry.instanceId))
  ) {
    return lastPickedEntry.instanceId;
  }
  return input.hasFavorites ? "favorites" : input.activeInstanceId;
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

/** Instance ids repeat across environments; lookups must stay scoped. */
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

/** Picker order: each driver's default instance first, then its custom instances. */
export function providerInstanceEntriesFor(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
): ReadonlyArray<ProviderInstanceEntry> {
  return pipe(
    deriveProviderInstanceEntries(providers),
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
    entries.find(isProviderInstanceHealthy) ??
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

export function resolveProjectDefaultProviderModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  projectId: ProjectId | null,
): ModelSelection | null {
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  // Matches resolveComposerProviderSelection: the first driver group wins before any other.
  const entry =
    resolveSelectableProviderInstanceEntry(
      entries.filter((candidate) => candidate.driverKind === entries[0]?.driverKind),
      undefined,
    ) ?? resolveSelectableProviderInstanceEntry(entries, undefined);
  const model = entry ? getDefaultProviderInstanceModel(providers, entry.instanceId) : undefined;
  return entry && model ? { instanceId: entry.instanceId, model } : null;
}
