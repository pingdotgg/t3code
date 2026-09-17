import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { resolveSelectableModel } from "@t3tools/shared/model";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { getAppModelOptionsForInstance, type AppModelOption } from "./modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "./providerInstances";

export interface AutoBalanceEnvironment {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
}

export interface AutoBalanceProviderCatalog {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  targetsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<{
      environmentId: EnvironmentId;
      instanceId: ProviderInstanceId;
      driver: ProviderDriverKind;
      models: ReadonlyArray<AppModelOption>;
    }>
  >;
}

/** Only connected machines opted into balancing contribute choices. */
export function isAutoBalanceRoutableEnvironment(input: {
  connectionPhase: EnvironmentConnectionPhase;
  environmentId: EnvironmentId;
  weights: Readonly<Record<string, number>>;
}): boolean {
  return input.connectionPhase === "connected" && (input.weights[input.environmentId] ?? 50) > 0;
}

/** Probe health is checked in addition to the owning machine's settings. */
export function isProviderSnapshotRoutable(snapshot: ServerProvider): boolean {
  return (
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.status !== "error" &&
    snapshot.auth.status !== "unauthenticated" &&
    snapshot.availability !== "unavailable"
  );
}

/** Picker keys never leave the picker: real instance IDs remain environment-local. */
export function autoBalancePickerInstanceId(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
): ProviderInstanceId {
  return JSON.stringify([driver, instanceId]) as ProviderInstanceId;
}

/** Resolve provider visibility and custom/hidden models using each machine's settings. */
export function environmentSupportsModelSelection(input: {
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  instanceId: ProviderInstanceId | null;
  driver: ProviderDriverKind;
  model: string | null;
  preserveUnavailableModel?: boolean;
  exactModel?: boolean;
}): boolean {
  return applyProviderInstanceSettings(
    deriveProviderInstanceEntries(input.providers),
    input.settings,
  ).some(
    (entry) =>
      (input.instanceId === null || entry.instanceId === input.instanceId) &&
      entry.driverKind === input.driver &&
      entry.enabled &&
      isProviderSnapshotRoutable(entry.snapshot) &&
      (input.model === null ||
        (input.exactModel
          ? getAppModelOptionsForInstance(input.settings, entry).some(
              (model) => model.slug === input.model,
            )
          : resolveSelectableModel(
              entry.driverKind,
              input.model,
              getAppModelOptionsForInstance(
                input.settings,
                entry,
                input.preserveUnavailableModel ? input.model : null,
              ),
            ) !== null)),
  );
}

/** Keep balancing on exact model owners whenever any eligible machine has one. */
export function selectAutoBalanceModelEnvironments(
  environments: ReadonlyArray<AutoBalanceEnvironment>,
  selection: Pick<
    Parameters<typeof environmentSupportsModelSelection>[0],
    "instanceId" | "driver" | "model"
  >,
  currentEnvironmentId: EnvironmentId,
) {
  const exact = environments.filter((environment) =>
    environmentSupportsModelSelection({ ...environment, ...selection, exactModel: true }),
  );
  return exact.length > 0
    ? exact
    : environments.filter((environment) =>
        environmentSupportsModelSelection({
          ...environment,
          ...selection,
          preserveUnavailableModel: environment.environmentId === currentEnvironmentId,
        }),
      );
}

/**
 * Selection-only union. The composer continues using its routed environment's
 * provider snapshots for capabilities, options and dispatch. Preferred-machine
 * metadata wins duplicate slugs; disabled providers never contribute models.
 */
export function deriveAutoBalanceProviderCatalog(input: {
  environments: ReadonlyArray<AutoBalanceEnvironment>;
  preferredEnvironmentId?: EnvironmentId | null;
  attachmentEnvironmentId?: EnvironmentId | null;
  currentSelection?:
    | { instanceId: ProviderInstanceId; driver: ProviderDriverKind; model: string }
    | undefined;
}): AutoBalanceProviderCatalog {
  const entries = new Map<ProviderInstanceId, ProviderInstanceEntry>();
  const models = new Map<ProviderInstanceId, Map<string, AppModelOption>>();
  const targets = new Map<
    ProviderInstanceId,
    Array<{
      environmentId: EnvironmentId;
      instanceId: ProviderInstanceId;
      driver: ProviderDriverKind;
      models: ReadonlyArray<AppModelOption>;
    }>
  >();
  const environments = input.environments
    .filter(
      (environment) =>
        input.attachmentEnvironmentId == null ||
        environment.environmentId === input.attachmentEnvironmentId,
    )
    .sort(
      (a, b) =>
        Number(b.environmentId === input.preferredEnvironmentId) -
        Number(a.environmentId === input.preferredEnvironmentId),
    );
  for (const environment of environments) {
    for (const entry of applyProviderInstanceSettings(
      deriveProviderInstanceEntries(environment.providers),
      environment.settings,
    )) {
      if (!entry.enabled || !isProviderSnapshotRoutable(entry.snapshot)) continue;
      const key = autoBalancePickerInstanceId(entry.driverKind, entry.instanceId);
      const current = input.currentSelection;
      const options = getAppModelOptionsForInstance(
        environment.settings,
        entry,
        environment.environmentId === input.preferredEnvironmentId &&
          current?.instanceId === entry.instanceId &&
          current.driver === entry.driverKind
          ? current.model
          : null,
      );
      const previous = entries.get(key);
      if (!previous || (previous.status !== "ready" && entry.status === "ready")) {
        entries.set(key, { ...entry, instanceId: key });
      }
      const merged = models.get(key) ?? new Map<string, AppModelOption>();
      for (const model of options)
        if (
          !merged.has(model.slug) ||
          (merged.get(model.slug)?.isUnavailable && !model.isUnavailable)
        )
          merged.set(model.slug, model);
      models.set(key, merged);
      const group = targets.get(key) ?? [];
      group.push({
        environmentId: environment.environmentId,
        instanceId: entry.instanceId,
        driver: entry.driverKind,
        models: options,
      });
      targets.set(key, group);
    }
  }
  return {
    entries: sortProviderInstanceEntries([...entries.values()]),
    modelOptionsByInstance: new Map(
      [...models].map(([key, values]) => [key, [...values.values()]]),
    ),
    targetsByInstance: targets,
  };
}

/** Map a picker-only key back to a supporting environment and its real instance ID. */
export function resolveAutoBalancePickerSelection(
  catalog: AutoBalanceProviderCatalog,
  key: ProviderInstanceId,
  model: string,
) {
  const targets = catalog.targetsByInstance.get(key) ?? [];
  const driver = targets[0]?.driver;
  if (!driver) return null;
  for (const availableOnly of [true, false]) {
    const options = targets.flatMap((target) =>
      target.models.filter((candidate) => !availableOnly || !candidate.isUnavailable),
    );
    const resolved = resolveSelectableModel(driver, model, options);
    if (resolved === null) continue;
    const target = targets.find((target) =>
      target.models.some(
        (candidate) => candidate.slug === resolved && (!availableOnly || !candidate.isUnavailable),
      ),
    );
    if (target) return { ...target, model: resolved };
  }
  return null;
}
