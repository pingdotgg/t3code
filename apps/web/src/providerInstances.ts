/**
 * Instance-aware view over the wire `ServerProvider[]`.
 *
 * The wire carries one `ServerProvider` per *configured instance* — the
 * default built-in codex instance, a user-authored `codex_personal`, an
 * unavailable shadow for a fork driver, etc. Legacy UI code collapsed these
 * into a single bucket per built-in driver via `.find((p) => p.driver === kind)`,
 * which silently dropped every custom instance after the first. This module
 * replaces that pattern with `ProviderInstanceEntry[]`, keyed on
 * `ProviderInstanceId`, so the model picker, settings list, and composer
 * can treat built-in and custom instances uniformly.
 *
 * @module providerInstances
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  resolveProviderInstanceEnabled,
  type ModelSelection,
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

/**
 * UI-facing projection of one configured provider instance. Carries the
 * snapshot verbatim for callers that need server-side fields we don't
 * hoist here, plus the precomputed `instanceId` / `driverKind` /
 * `displayName` used by every picker and settings view.
 */
export interface ProviderInstanceEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly continuationGroupKey?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProviderState;
  /**
   * True when this entry is the default instance for its driver kind —
   * i.e. its instance id equals `defaultInstanceIdForDriver(driverKind)`.
   * The settings panel and picker sort defaults before customs.
   */
  readonly isDefault: boolean;
  /** True when `availability === "unavailable"` is absent or "available". */
  readonly isAvailable: boolean;
  readonly snapshot: ServerProvider;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * Whether an instance can currently contribute models to an interactive picker.
 *
 * Disabling an instance updates `enabled` independently, while its previous
 * `ready` probe status can remain in the streamed snapshot until reconciliation.
 */
export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.isAvailable && entry.status === "ready";
}

/** Picker rails contain configured, enabled instances only. */
export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled;
}

/**
 * Project the wire `ServerProvider[]` into instance entries, one per
 * configured instance. Preserves the server's ordering (which sources
 * from `deriveProviderInstanceConfigMap` — explicit `providerInstances.*`
 * first, synthesized defaults after) so callers that want "default first"
 * should sort with `sortProviderInstanceEntries` below.
 */
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
 * Project several environments' `ServerProvider[]` into a nested
 * `environmentId → instanceId → entry` lookup.
 *
 * Instance ids are per-environment routing keys, and `defaultInstanceIdForDriver`
 * makes the default id literally the driver slug, so every environment running
 * the same driver reports the same id. Flattening across environments would
 * clobber entries and mis-resolve accent colors; lookups must stay scoped to
 * the thread's own environment.
 */
export function deriveProviderEntriesByEnvironment(
  providersByEnvironment: Iterable<readonly [string, ReadonlyArray<ServerProvider>]>,
): ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>> {
  const byEnvironment = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
  for (const [environmentId, providers] of providersByEnvironment) {
    byEnvironment.set(
      environmentId,
      new Map(
        deriveProviderInstanceEntries(providers).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    );
  }
  return byEnvironment;
}

/**
 * Overlay the current settings configuration onto streamed provider snapshots.
 * Provider probes can briefly retain their previous `enabled` value after a
 * settings write, so picker visibility must follow settings rather than waiting
 * for probe reconciliation.
 *
 * Only built-in default instances have a legacy `providers` entry. Every
 * other instance exists through `providerInstances`; if it is absent there,
 * its streamed snapshot is stale (for example immediately after deletion)
 * and is treated as disabled.
 */
export function applyProviderInstanceSettings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): ReadonlyArray<ProviderInstanceEntry> {
  const legacyProviders = settings.providers as Readonly<
    Record<string, { readonly enabled?: boolean } | undefined>
  >;

  return entries.map((entry) => {
    const explicitInstance = Object.hasOwn(settings.providerInstances, entry.instanceId)
      ? settings.providerInstances[entry.instanceId]
      : undefined;
    const legacyProvider = Object.hasOwn(legacyProviders, entry.driverKind)
      ? legacyProviders[entry.driverKind]
      : undefined;
    const enabled = explicitInstance
      ? resolveProviderInstanceEnabled(explicitInstance)
      : entry.isDefault && legacyProvider
        ? (legacyProvider.enabled ?? entry.enabled)
        : false;
    return enabled === entry.enabled ? entry : { ...entry, enabled };
  });
}

/**
 * Sort instance entries so the default instance of each driver kind appears
 * before any custom instances of the same kind. Within a kind, custom
 * instances keep their settings-author order (which is how the server
 * emits them). Stable across kinds: entries retain the server's
 * cross-driver ordering.
 */
export function sortProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  // Group by driver kind preserving first-appearance order, then emit
  // default-first within each kind. Using a Map keeps the "first-seen"
  // semantics for kinds whose default instance is absent (unusual but
  // possible during the migration).
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

/**
 * Look up a single instance entry by exact `instanceId`. Missing snapshots
 * are not inferred from driver kind in UI routing code.
 */
function getProviderInstanceEntry(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId);
}

/**
 * Default model slug for a specific instance: its declared built-in default,
 * then its first built-in model, then any model it reports, then the driver-level default. Custom
 * instances can serve a different model list than the default instance of
 * the same driver kind, so the lookup must be instance-scoped rather than
 * kind-scoped.
 */
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

/**
 * Resolve an exact stored instance when it remains enabled and available.
 * Otherwise choose a deterministic fallback that can plausibly start now:
 * ready first, then a non-error probe result. An errored provider is retained
 * only when it was explicitly requested; it is never invented as a new-user
 * default.
 */
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

/**
 * Resolve the routing key for a selection that may reference an instance
 * id that no longer exists (e.g. a persisted thread selection after the
 * user deleted the custom instance). Returns a ready or non-error fallback,
 * or `undefined` when no provider can safely become a new selection.
 */
export function resolveSelectableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceId | undefined {
  const entries = deriveProviderInstanceEntries(providers);
  return resolveSelectableProviderInstanceEntry(entries, instanceId)?.instanceId;
}

/**
 * Resolve the model selection persisted for a project or new thread. A valid
 * stored selection is preserved byte-for-byte. Falling back to another
 * instance also resets the model to that instance's own default, avoiding
 * cross-provider instance/model pairs.
 */
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

/**
 * Resolve an open model-selection routing key back to a driver kind.
 * Custom instance ids such as `claude_openrouter` are not themselves
 * driver-kind slugs, but the composer still needs the owning driver kind
 * for capabilities, options, icons, and turn dispatch metadata.
 */
export function resolveProviderDriverKindForInstanceSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providers: ReadonlyArray<ServerProvider>,
  selection: ProviderInstanceId | ProviderDriverKind | null | undefined,
): ProviderDriverKind | undefined {
  const matchedEntry = entries.find((entry) => entry.instanceId === selection);
  if (matchedEntry) {
    return matchedEntry.driverKind;
  }
  return undefined;
}
