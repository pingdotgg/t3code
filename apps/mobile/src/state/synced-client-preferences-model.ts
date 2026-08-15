import {
  getSyncedClientPreferenceUpdatedAt,
  nextSyncedClientPreferencesUpdatedAt,
  SYNCED_CLIENT_PREFERENCE_FIELDS,
  type EnvironmentId,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferenceField,
  type SyncedClientPreferences,
  type SyncedClientPreferencesPatch,
  type SyncedClientPreferencesUpdatedAtByField,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import type { Preferences } from "../persistence/mobile-preferences";

const SYNCED_CLIENT_PREFERENCES_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const PLAN_MODE_PREFERENCE_RECONCILIATION_MAX_ATTEMPTS = 3;

type PlanModePreferenceRetryScheduler = (retry: () => void, delayMs: number) => () => void;

const schedulePlanModePreferenceRetry: PlanModePreferenceRetryScheduler = (retry, delayMs) => {
  const timer = setTimeout(retry, delayMs);
  return () => clearTimeout(timer);
};

export interface EnvironmentPreferenceState {
  readonly environmentId: EnvironmentId;
  readonly preferences: SyncedClientPreferences | undefined;
  readonly canPatch?: boolean;
}

export interface PlanModePreferencePatchTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PatchSyncedClientPreferencesRequest;
}

export interface LocalSyncedClientPreferencesState {
  readonly values: Partial<SyncedClientPreferencesPatch>;
  readonly updatedAtByField?: SyncedClientPreferencesUpdatedAtByField;
  readonly legacyUpdatedAt?: string;
}

export interface LocalSyncedClientPreferencesPatch {
  readonly values: SyncedClientPreferencesPatch;
  readonly updatedAtByField: SyncedClientPreferencesUpdatedAtByField;
}

type MutableSyncedClientPreferencesPatch = {
  -readonly [Field in SyncedClientPreferenceField]?: SyncedClientPreferencesPatch[Field];
};
type MutableSyncedClientPreferencesUpdatedAtByField = {
  -readonly [Field in SyncedClientPreferenceField]?: string;
};

function setPreferenceValue<Field extends SyncedClientPreferenceField>(
  patch: MutableSyncedClientPreferencesPatch,
  field: Field,
  value: SyncedClientPreferencesPatch[Field],
): void {
  patch[field] = value;
}

function setPreferenceUpdatedAt<Field extends SyncedClientPreferenceField>(
  updatedAtByField: MutableSyncedClientPreferencesUpdatedAtByField,
  field: Field,
  updatedAt: string,
): void {
  updatedAtByField[field] = updatedAt;
}

function localPreferenceUpdatedAt(
  local: LocalSyncedClientPreferencesState,
  field: SyncedClientPreferenceField,
): string | undefined {
  if (local.values[field] === undefined) return undefined;
  return local.updatedAtByField?.[field] ?? local.legacyUpdatedAt;
}

export function createPlanModePreferenceReconciliationController(
  scheduleRetry: PlanModePreferenceRetryScheduler = schedulePlanModePreferenceRetry,
) {
  interface Reconciliation {
    readonly target: PlanModePreferencePatchTarget;
    attempt: number;
    patch: () => Promise<SyncedClientPreferences | null>;
    persist: (patch: Partial<Preferences>) => void;
    cancelRetry?: () => void;
  }

  interface EnvironmentReconciliation {
    reconciliation?: Reconciliation;
    settledUpdatedAt?: string;
  }

  const environmentReconciliations = new Map<EnvironmentId, EnvironmentReconciliation>();
  const cancel = (environmentId: EnvironmentId) => {
    const state = environmentReconciliations.get(environmentId);
    state?.reconciliation?.cancelRetry?.();
    if (state !== undefined) state.reconciliation = undefined;
  };
  const settleFailure = (reconciliation: Reconciliation) => {
    const { environmentId } = reconciliation.target;
    const state = environmentReconciliations.get(environmentId);
    if (state?.reconciliation !== reconciliation) return;
    if (reconciliation.attempt >= PLAN_MODE_PREFERENCE_RECONCILIATION_MAX_ATTEMPTS) {
      state.reconciliation = undefined;
      return;
    }
    const delayMs = 1_000 * 2 ** (reconciliation.attempt - 1);
    reconciliation.cancelRetry = scheduleRetry(() => {
      reconciliation.cancelRetry = undefined;
      if (environmentReconciliations.get(environmentId)?.reconciliation === reconciliation) {
        dispatch(reconciliation);
      }
    }, delayMs);
  };
  const dispatch = (reconciliation: Reconciliation) => {
    reconciliation.attempt += 1;
    void reconciliation.patch().then(
      (preferences) => {
        const { environmentId } = reconciliation.target;
        const state = environmentReconciliations.get(environmentId);
        if (state?.reconciliation !== reconciliation) return;
        if (preferences === null) {
          settleFailure(reconciliation);
          return;
        }
        state.reconciliation = undefined;
        state.settledUpdatedAt = reconciliation.target.input.updatedAt;
        const localPatch = canonicalPlanModePreferencePatch(preferences);
        if (localPatch !== null) reconciliation.persist(localPatch);
      },
      () => settleFailure(reconciliation),
    );
  };

  return {
    setActiveEnvironmentIds(environmentIds: ReadonlyArray<EnvironmentId>) {
      const nextEnvironmentIds = new Set(environmentIds);
      for (const environmentId of environmentReconciliations.keys()) {
        if (nextEnvironmentIds.has(environmentId)) continue;
        cancel(environmentId);
        environmentReconciliations.delete(environmentId);
      }
      for (const environmentId of nextEnvironmentIds) {
        if (!environmentReconciliations.has(environmentId)) {
          environmentReconciliations.set(environmentId, {});
        }
      }
    },
    observe(environmentId: EnvironmentId, updatedAt: string | undefined) {
      const reconciliation = environmentReconciliations.get(environmentId)?.reconciliation;
      if (reconciliation?.target.input.updatedAt === updatedAt) cancel(environmentId);
    },
    reconcile<E>(input: {
      readonly target: PlanModePreferencePatchTarget;
      readonly patch: (
        target: PlanModePreferencePatchTarget,
      ) => Promise<AtomCommandResult<SyncedClientPreferences, E>>;
      readonly persist: (patch: Partial<Preferences>) => void;
    }) {
      const { environmentId } = input.target;
      const state = environmentReconciliations.get(environmentId);
      if (state === undefined || state.settledUpdatedAt === input.target.input.updatedAt) {
        return;
      }
      const current = state.reconciliation;
      if (current?.target.input.updatedAt === input.target.input.updatedAt) {
        current.patch = async () => {
          const result = await input.patch(input.target);
          return result._tag === "Success" ? result.value : null;
        };
        current.persist = input.persist;
        return;
      }
      if (current !== undefined) cancel(environmentId);
      state.settledUpdatedAt = undefined;
      const reconciliation: Reconciliation = {
        target: input.target,
        attempt: 0,
        patch: async () => {
          const result = await input.patch(input.target);
          return result._tag === "Success" ? result.value : null;
        },
        persist: input.persist,
      };
      state.reconciliation = reconciliation;
      dispatch(reconciliation);
    },
    reset() {
      for (const environmentId of environmentReconciliations.keys()) cancel(environmentId);
      environmentReconciliations.clear();
    },
  };
}

export function canonicalPlanModePreferencePatch(
  preferences: SyncedClientPreferences,
): Partial<Preferences> | null {
  const updatedAt = getSyncedClientPreferenceUpdatedAt(preferences, "planModeEnabled");
  return preferences.planModeEnabled === undefined || updatedAt === undefined
    ? null
    : {
        planModeEnabled: preferences.planModeEnabled,
        syncedClientPreferencesUpdatedAtByField: {
          planModeEnabled: updatedAt,
        },
      };
}

export function nextMobileSyncedPreferencesUpdatedAt(
  localUpdatedAts: ReadonlyArray<string | undefined>,
  now: string,
  authoritativeUpdatedAts: ReadonlyArray<string | undefined> = [],
): string {
  const maximumUpdatedAt = Date.parse(now) + SYNCED_CLIENT_PREFERENCES_MAX_FUTURE_SKEW_MS;
  return nextSyncedClientPreferencesUpdatedAt(
    [
      ...localUpdatedAts.filter(
        (candidate) => candidate !== undefined && Date.parse(candidate) <= maximumUpdatedAt,
      ),
      ...authoritativeUpdatedAts,
    ],
    now,
  );
}

export function createSyncedClientPreferencesWrite(input: {
  readonly patch: SyncedClientPreferencesPatch;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly currentUpdatedAtByField?: SyncedClientPreferencesUpdatedAtByField;
  readonly legacyCurrentUpdatedAt?: string;
  readonly authoritativePreferences?: ReadonlyArray<SyncedClientPreferences | undefined>;
  readonly now: string;
}): {
  readonly localPatch: LocalSyncedClientPreferencesPatch;
  readonly environmentPatches: ReadonlyArray<PlanModePreferencePatchTarget>;
} {
  const fields = SYNCED_CLIENT_PREFERENCE_FIELDS.filter(
    (field) => input.patch[field] !== undefined,
  );
  const updatedAt = nextMobileSyncedPreferencesUpdatedAt(
    fields.map((field) => input.currentUpdatedAtByField?.[field] ?? input.legacyCurrentUpdatedAt),
    input.now,
    input.authoritativePreferences?.flatMap((preferences) =>
      fields.map((field) => getSyncedClientPreferenceUpdatedAt(preferences, field)),
    ),
  );
  const updatedAtByField: MutableSyncedClientPreferencesUpdatedAtByField = {
    ...input.currentUpdatedAtByField,
  };
  for (const field of fields) setPreferenceUpdatedAt(updatedAtByField, field, updatedAt);
  const request = { patch: input.patch, updatedAt };
  return {
    localPatch: { values: input.patch, updatedAtByField },
    environmentPatches: input.connectedEnvironmentIds.map((environmentId) => ({
      environmentId,
      input: request,
    })),
  };
}

export function createPlanModePreferenceWrite(input: {
  readonly value: boolean;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly currentUpdatedAtByField?: SyncedClientPreferencesUpdatedAtByField;
  readonly legacyCurrentUpdatedAt?: string;
  readonly authoritativePreferences?: ReadonlyArray<SyncedClientPreferences | undefined>;
  readonly now: string;
}): {
  readonly localPatch: {
    readonly planModeEnabled: boolean;
    readonly syncedClientPreferencesUpdatedAtByField: SyncedClientPreferencesUpdatedAtByField;
  };
  readonly environmentPatches: ReadonlyArray<PlanModePreferencePatchTarget>;
} {
  const write = createSyncedClientPreferencesWrite({
    patch: { planModeEnabled: input.value },
    connectedEnvironmentIds: input.connectedEnvironmentIds,
    currentUpdatedAtByField: input.currentUpdatedAtByField,
    legacyCurrentUpdatedAt: input.legacyCurrentUpdatedAt,
    authoritativePreferences: input.authoritativePreferences,
    now: input.now,
  });
  return {
    localPatch: {
      planModeEnabled: input.value,
      syncedClientPreferencesUpdatedAtByField: write.localPatch.updatedAtByField,
    },
    environmentPatches: write.environmentPatches,
  };
}

export function createPlanModePreferenceWriteController() {
  let latestRequestedUpdatedAt: string | undefined;
  let settledRequestedUpdatedAt: string | undefined;

  return {
    create(input: Parameters<typeof createPlanModePreferenceWrite>[0]) {
      const write = createPlanModePreferenceWrite({
        ...input,
        currentUpdatedAtByField: {
          ...input.currentUpdatedAtByField,
          ...(latestRequestedUpdatedAt === undefined
            ? {}
            : { planModeEnabled: latestRequestedUpdatedAt }),
        },
      });
      latestRequestedUpdatedAt =
        write.localPatch.syncedClientPreferencesUpdatedAtByField.planModeEnabled;
      settledRequestedUpdatedAt = undefined;
      return write;
    },
    settle<E>(input: {
      readonly target: PlanModePreferencePatchTarget;
      readonly result: AtomCommandResult<SyncedClientPreferences, E>;
    }): Partial<Preferences> | null {
      if (
        input.target.input.updatedAt !== latestRequestedUpdatedAt ||
        input.target.input.updatedAt === settledRequestedUpdatedAt ||
        input.result._tag === "Failure"
      ) {
        return null;
      }
      settledRequestedUpdatedAt = input.target.input.updatedAt;
      return canonicalPlanModePreferencePatch(input.result.value);
    },
  };
}

export function reconcileSyncedClientPreferences(input: {
  readonly local: LocalSyncedClientPreferencesState;
  readonly environments: ReadonlyArray<EnvironmentPreferenceState>;
  readonly now: string;
  readonly fields?: ReadonlyArray<SyncedClientPreferenceField>;
}): {
  readonly localPatch: LocalSyncedClientPreferencesPatch | null;
  readonly environmentPatches: ReadonlyArray<PlanModePreferencePatchTarget>;
} {
  if (input.environments.length === 0) {
    return { localPatch: null, environmentPatches: [] };
  }

  const localValues: MutableSyncedClientPreferencesPatch = {};
  const localUpdatedAtByField: MutableSyncedClientPreferencesUpdatedAtByField = {
    ...input.local.updatedAtByField,
  };
  const environmentPatches: PlanModePreferencePatchTarget[] = [];
  let localChanged = false;
  const hasPatchableEnvironment = input.environments.some(
    (environment) => environment.canPatch !== false,
  );

  for (const field of input.fields ?? SYNCED_CLIENT_PREFERENCE_FIELDS) {
    const environmentCandidates = input.environments.flatMap((environment) => {
      const value = environment.preferences?.[field];
      const updatedAt = getSyncedClientPreferenceUpdatedAt(environment.preferences, field);
      return value === undefined || updatedAt === undefined
        ? []
        : [{ source: environment.environmentId, value, updatedAt }];
    });
    environmentCandidates.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.source.localeCompare(right.source),
    );
    const latestEnvironment = environmentCandidates.at(-1);
    const latestObservedEnvironmentUpdatedAt = latestEnvironment?.updatedAt;
    const localValue = input.local.values[field];
    const localUpdatedAt = localPreferenceUpdatedAt(input.local, field);
    const boundedLocalUpdatedAt =
      hasPatchableEnvironment &&
      localUpdatedAt !== undefined &&
      latestObservedEnvironmentUpdatedAt !== undefined &&
      localUpdatedAt > latestObservedEnvironmentUpdatedAt
        ? nextMobileSyncedPreferencesUpdatedAt([], latestObservedEnvironmentUpdatedAt, [
            latestObservedEnvironmentUpdatedAt,
          ])
        : localUpdatedAt;
    // Exact remote ties use environment id for deterministic convergence.
    const localWins =
      localValue !== undefined &&
      boundedLocalUpdatedAt !== undefined &&
      (latestEnvironment === undefined || boundedLocalUpdatedAt > latestEnvironment.updatedAt);
    const value = localWins ? localValue : (latestEnvironment?.value ?? localValue);
    if (value === undefined) continue;
    const updatedAt =
      (localWins ? boundedLocalUpdatedAt : latestEnvironment?.updatedAt) ?? input.now;

    if (localValue !== value || localUpdatedAt !== updatedAt) {
      setPreferenceValue(localValues, field, value);
      setPreferenceUpdatedAt(localUpdatedAtByField, field, updatedAt);
      localChanged = true;
    }

    for (const environment of input.environments) {
      if (environment.canPatch === false) continue;
      if (
        environment.preferences?.[field] === value &&
        getSyncedClientPreferenceUpdatedAt(environment.preferences, field) === updatedAt
      ) {
        continue;
      }
      const patch: MutableSyncedClientPreferencesPatch = {};
      setPreferenceValue(patch, field, value);
      environmentPatches.push({
        environmentId: environment.environmentId,
        input: { patch, updatedAt },
      });
    }
  }

  return {
    localPatch: localChanged
      ? { values: localValues, updatedAtByField: localUpdatedAtByField }
      : null,
    environmentPatches,
  };
}

export function reconcilePlanModePreferences(input: {
  readonly localPlanModeEnabled: boolean | undefined;
  readonly localUpdatedAt: string | undefined;
  readonly environments: ReadonlyArray<EnvironmentPreferenceState>;
  readonly now: string;
}): {
  readonly localPatch: Partial<Preferences> | null;
  readonly environmentPatches: ReadonlyArray<PlanModePreferencePatchTarget>;
} {
  const reconciliation = reconcileSyncedClientPreferences({
    local: {
      values:
        input.localPlanModeEnabled === undefined
          ? {}
          : { planModeEnabled: input.localPlanModeEnabled },
      ...(input.localUpdatedAt === undefined
        ? {}
        : { updatedAtByField: { planModeEnabled: input.localUpdatedAt } }),
    },
    environments: input.environments,
    now: input.now,
    fields: ["planModeEnabled"],
  });
  const planModeEnabled = reconciliation.localPatch?.values.planModeEnabled;
  return {
    localPatch:
      planModeEnabled === undefined || reconciliation.localPatch === null
        ? null
        : {
            planModeEnabled,
            syncedClientPreferencesUpdatedAtByField: reconciliation.localPatch.updatedAtByField,
          },
    environmentPatches: reconciliation.environmentPatches,
  };
}
