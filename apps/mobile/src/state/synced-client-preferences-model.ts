import {
  EnvironmentId,
  getSyncedClientPreferenceUpdatedAt,
  nextSyncedClientPreferencesUpdatedAt,
  SYNCED_CLIENT_PREFERENCE_FIELDS,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferenceField,
  type SyncedClientPreferences,
  type SyncedClientPreferencesPatch,
  type SyncedClientPreferencesUpdatedAtByField,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";

import type { Preferences } from "../persistence/mobile-preferences";

const SYNCED_CLIENT_PREFERENCES_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const SYNCED_CLIENT_PREFERENCE_RECONCILIATION_MAX_ATTEMPTS = 3;

type SyncedClientPreferenceRetryScheduler = (retry: () => void, delayMs: number) => () => void;

const scheduleSyncedClientPreferenceRetry: SyncedClientPreferenceRetryScheduler = (
  retry,
  delayMs,
) => {
  const timer = setTimeout(retry, delayMs);
  return () => clearTimeout(timer);
};

export interface EnvironmentPreferenceState {
  readonly environmentId: EnvironmentId;
  readonly preferences: SyncedClientPreferences | undefined;
  readonly canPatch?: boolean;
}

export interface SyncedClientPreferencePatchTarget {
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

interface EnvironmentPreferenceCandidate {
  readonly source: EnvironmentId;
  readonly updatedAt: string;
}

function compareEnvironmentPreferenceCandidates(
  left: EnvironmentPreferenceCandidate,
  right: EnvironmentPreferenceCandidate,
): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.source.localeCompare(right.source);
}

const PlanModePreferenceReconciliationIdentity = Schema.Tuple([
  Schema.String,
  EnvironmentId,
  Schema.Boolean,
]);
type PlanModePreferenceReconciliationIdentity =
  typeof PlanModePreferenceReconciliationIdentity.Type;
const decodePlanModePreferenceReconciliationIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(PlanModePreferenceReconciliationIdentity),
);

function parsePlanModePreferenceReconciliationKey(
  key: string,
): PlanModePreferenceReconciliationIdentity | undefined {
  return key === "" ? undefined : decodePlanModePreferenceReconciliationIdentity(key);
}

function comparePlanModePreferenceReconciliationIdentities(
  left: PlanModePreferenceReconciliationIdentity | undefined,
  right: PlanModePreferenceReconciliationIdentity | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareEnvironmentPreferenceCandidates(
    { updatedAt: left[0], source: left[1] },
    { updatedAt: right[0], source: right[1] },
  );
}

export function createPlanModePreferenceReconciliationKey(
  states: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
    readonly shellStatus: EnvironmentShellStatus;
    readonly preferences: SyncedClientPreferences | undefined;
  }>,
): string {
  // Readiness is a monotonic watermark over the deterministic live winner. A newer
  // stamp always closes gating; at the same stamp, a higher environment id closes it
  // only when its value differs. Removals, fallback states, and same-value churn cannot.
  const winner = states.reduce<PlanModePreferenceReconciliationIdentity | undefined>(
    (currentWinner, { environmentId, connectionState, shellStatus, preferences }) => {
      if (connectionState !== "connected" || shellStatus !== "live") return currentWinner;
      const value = preferences?.planModeEnabled;
      const updatedAt = getSyncedClientPreferenceUpdatedAt(preferences, "planModeEnabled");
      if (value === undefined || updatedAt === undefined) return currentWinner;
      const candidate = [updatedAt, environmentId, value] as const;
      return comparePlanModePreferenceReconciliationIdentities(candidate, currentWinner) > 0
        ? candidate
        : currentWinner;
    },
    undefined,
  );
  return winner === undefined ? "" : JSON.stringify(winner);
}

export function advancePlanModePreferenceReconciliationKey(
  appliedKey: string | null,
  currentKey: string,
): string {
  if (appliedKey === null) return currentKey;
  return comparePlanModePreferenceReconciliationIdentities(
    parsePlanModePreferenceReconciliationKey(currentKey),
    parsePlanModePreferenceReconciliationKey(appliedKey),
  ) >= 0
    ? currentKey
    : appliedKey;
}

export function isPlanModePreferenceReconciliationReady(input: {
  readonly connectionsLoaded: boolean;
  readonly environmentCount: number;
  readonly currentKey: string;
  readonly appliedKey: string | null;
}): boolean {
  if (!input.connectionsLoaded) return false;
  if (input.environmentCount === 0) return true;
  if (input.appliedKey === null) return false;
  const current = parsePlanModePreferenceReconciliationKey(input.currentKey);
  const applied = parsePlanModePreferenceReconciliationKey(input.appliedKey);
  if (comparePlanModePreferenceReconciliationIdentities(current, applied) < 0) return true;
  if (current === undefined || applied === undefined) return current === applied;
  return current[0] === applied[0] && current[2] === applied[2];
}

export function hasPlanModePreferenceReconciliationAttempted(
  states: ReadonlyArray<{
    readonly connectionState: EnvironmentConnectionPhase;
    readonly shellStatus: EnvironmentShellStatus;
  }>,
): boolean {
  return (
    states.some(
      ({ connectionState, shellStatus }) =>
        connectionState === "connected" && shellStatus === "live",
    ) ||
    states.every(
      ({ connectionState }) =>
        connectionState === "available" ||
        connectionState === "error" ||
        connectionState === "offline",
    )
  );
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

export function createSyncedClientPreferenceReconciliationController(
  field: SyncedClientPreferenceField,
  scheduleRetry: SyncedClientPreferenceRetryScheduler = scheduleSyncedClientPreferenceRetry,
) {
  const reconciliationKey = (
    value: SyncedClientPreferencesPatch[SyncedClientPreferenceField] | undefined,
    updatedAt: string | undefined,
  ) =>
    value === undefined || updatedAt === undefined ? undefined : JSON.stringify([updatedAt, value]);
  const targetReconciliationKey = (target: SyncedClientPreferencePatchTarget) =>
    reconciliationKey(target.input.patch[field], target.input.updatedAt);

  interface Reconciliation {
    readonly target: SyncedClientPreferencePatchTarget;
    readonly key: string | undefined;
    attempt: number;
    patch: () => Promise<SyncedClientPreferences | null>;
    persist: (patch: Partial<Preferences>) => void;
    cancelRetry?: () => void;
  }

  interface EnvironmentReconciliation {
    reconciliation?: Reconciliation;
    settledKey?: string;
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
    if (reconciliation.attempt >= SYNCED_CLIENT_PREFERENCE_RECONCILIATION_MAX_ATTEMPTS) {
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
        state.settledKey = reconciliation.key;
        const localPatch = canonicalSyncedClientPreferencesPatch(preferences, [field]);
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
    observe(
      environmentId: EnvironmentId,
      value: SyncedClientPreferencesPatch[SyncedClientPreferenceField] | undefined,
      updatedAt: string | undefined,
    ) {
      const reconciliation = environmentReconciliations.get(environmentId)?.reconciliation;
      const observedKey = reconciliationKey(value, updatedAt);
      if (observedKey !== undefined && reconciliation?.key === observedKey) cancel(environmentId);
    },
    reconcile<E>(input: {
      readonly target: SyncedClientPreferencePatchTarget;
      readonly patch: (
        target: SyncedClientPreferencePatchTarget,
      ) => Promise<AtomCommandResult<SyncedClientPreferences, E>>;
      readonly persist: (patch: Partial<Preferences>) => void;
      readonly normalizeThemeId?: (themeId: string) => string;
    }) {
      const { environmentId } = input.target;
      const state = environmentReconciliations.get(environmentId);
      const key = targetReconciliationKey(input.target);
      if (state === undefined || (key !== undefined && state.settledKey === key)) {
        return;
      }
      const current = state.reconciliation;
      if (key !== undefined && current?.key === key) {
        current.patch = async () => {
          const result = await input.patch(input.target);
          return result._tag === "Success" ? result.value : null;
        };
        current.persist = (patch) =>
          input.persist(
            patch.themeId === undefined
              ? patch
              : { ...patch, themeId: input.normalizeThemeId?.(patch.themeId) ?? patch.themeId },
          );
        return;
      }
      if (current !== undefined) cancel(environmentId);
      state.settledKey = undefined;
      const reconciliation: Reconciliation = {
        target: input.target,
        key,
        attempt: 0,
        patch: async () => {
          const result = await input.patch(input.target);
          return result._tag === "Success" ? result.value : null;
        },
        persist: (patch) =>
          input.persist(
            patch.themeId === undefined
              ? patch
              : { ...patch, themeId: input.normalizeThemeId?.(patch.themeId) ?? patch.themeId },
          ),
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

export function canonicalSyncedClientPreferencesPatch(
  preferences: SyncedClientPreferences,
  fields: ReadonlyArray<SyncedClientPreferenceField> = SYNCED_CLIENT_PREFERENCE_FIELDS,
): Partial<Preferences> | null {
  const values: MutableSyncedClientPreferencesPatch = {};
  const updatedAtByField: MutableSyncedClientPreferencesUpdatedAtByField = {};
  for (const field of fields) {
    const value = preferences[field];
    const updatedAt = getSyncedClientPreferenceUpdatedAt(preferences, field);
    if (value === undefined || updatedAt === undefined) continue;
    setPreferenceValue(values, field, value);
    setPreferenceUpdatedAt(updatedAtByField, field, updatedAt);
  }
  return Object.keys(values).length === 0
    ? null
    : { ...values, syncedClientPreferencesUpdatedAtByField: updatedAtByField };
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
}) {
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
}) {
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

export function createSyncedClientPreferenceWriteController(field: SyncedClientPreferenceField) {
  let latestRequestedUpdatedAt: string | undefined;
  let settledRequestedUpdatedAt: string | undefined;

  return {
    create(input: Parameters<typeof createSyncedClientPreferencesWrite>[0]) {
      const persistedUpdatedAt = input.currentUpdatedAtByField?.[field];
      const currentUpdatedAt =
        latestRequestedUpdatedAt === undefined ||
        (persistedUpdatedAt !== undefined && persistedUpdatedAt > latestRequestedUpdatedAt)
          ? persistedUpdatedAt
          : latestRequestedUpdatedAt;
      const currentUpdatedAtByField: MutableSyncedClientPreferencesUpdatedAtByField = {
        ...input.currentUpdatedAtByField,
      };
      if (currentUpdatedAt !== undefined) {
        setPreferenceUpdatedAt(currentUpdatedAtByField, field, currentUpdatedAt);
      }
      const write = createSyncedClientPreferencesWrite({
        ...input,
        currentUpdatedAtByField,
      });
      latestRequestedUpdatedAt = write.localPatch.updatedAtByField[field];
      settledRequestedUpdatedAt = undefined;
      return write;
    },
    settle<E>(input: {
      readonly target: SyncedClientPreferencePatchTarget;
      readonly result: AtomCommandResult<SyncedClientPreferences, E>;
      readonly normalizeThemeId?: (themeId: string) => string;
    }): Partial<Preferences> | null {
      if (
        input.target.input.updatedAt !== latestRequestedUpdatedAt ||
        input.target.input.updatedAt === settledRequestedUpdatedAt ||
        input.result._tag === "Failure"
      ) {
        return null;
      }
      settledRequestedUpdatedAt = input.target.input.updatedAt;
      const patch = canonicalSyncedClientPreferencesPatch(input.result.value, [field]);
      return patch?.themeId === undefined
        ? patch
        : { ...patch, themeId: input.normalizeThemeId?.(patch.themeId) ?? patch.themeId };
    },
  };
}

export function reconcileSyncedClientPreferences(input: {
  readonly local: LocalSyncedClientPreferencesState;
  readonly environments: ReadonlyArray<EnvironmentPreferenceState>;
  readonly now: string;
  readonly fields?: ReadonlyArray<SyncedClientPreferenceField>;
  readonly normalizeThemeId?: (themeId: string) => string;
}) {
  if (input.environments.length === 0) {
    return { localPatch: null, environmentPatches: [] };
  }

  const localValues: MutableSyncedClientPreferencesPatch = {};
  const localUpdatedAtByField: MutableSyncedClientPreferencesUpdatedAtByField = {
    ...input.local.updatedAtByField,
  };
  const environmentPatches: SyncedClientPreferencePatchTarget[] = [];
  let localChanged = false;
  const hasPatchableEnvironment = input.environments.some(
    (environment) => environment.canPatch !== false,
  );
  const normalizePreferenceValue = (
    field: SyncedClientPreferenceField,
    value: SyncedClientPreferencesPatch[SyncedClientPreferenceField] | undefined,
  ) =>
    field === "themeId" && typeof value === "string"
      ? (input.normalizeThemeId?.(value) ?? value)
      : value;

  for (const field of input.fields ?? SYNCED_CLIENT_PREFERENCE_FIELDS) {
    const localValue = normalizePreferenceValue(field, input.local.values[field]);
    const localUpdatedAt = localPreferenceUpdatedAt(input.local, field);
    const environmentCandidates = input.environments.flatMap((environment) => {
      const value = normalizePreferenceValue(field, environment.preferences?.[field]);
      const updatedAt = getSyncedClientPreferenceUpdatedAt(environment.preferences, field);
      return value === undefined ||
        updatedAt === undefined ||
        (environment.canPatch === false && localUpdatedAt !== undefined)
        ? []
        : [{ source: environment.environmentId, value, updatedAt }];
    });
    environmentCandidates.sort(compareEnvironmentPreferenceCandidates);
    const latestEnvironment = environmentCandidates.at(-1);
    const latestObservedEnvironmentUpdatedAt = latestEnvironment?.updatedAt;
    const boundedLocalUpdatedAt =
      hasPatchableEnvironment &&
      localUpdatedAt !== undefined &&
      latestObservedEnvironmentUpdatedAt !== undefined &&
      localUpdatedAt > latestObservedEnvironmentUpdatedAt &&
      Date.parse(localUpdatedAt) >
        Date.parse(input.now) + SYNCED_CLIENT_PREFERENCES_MAX_FUTURE_SKEW_MS
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
        normalizePreferenceValue(field, environment.preferences?.[field]) === value &&
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
}) {
  let local: LocalSyncedClientPreferencesState = {
    values:
      input.localPlanModeEnabled === undefined
        ? {}
        : { planModeEnabled: input.localPlanModeEnabled },
  };
  if (input.localUpdatedAt !== undefined) {
    local = {
      ...local,
      updatedAtByField: { planModeEnabled: input.localUpdatedAt },
    };
  }
  const reconciliation = reconcileSyncedClientPreferences({
    local,
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
