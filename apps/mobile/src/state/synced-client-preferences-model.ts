import type {
  EnvironmentId,
  PatchSyncedClientPreferencesRequest,
  SyncedClientPreferences,
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

  let activeEnvironmentIds = new Set<EnvironmentId>();
  const reconciliationByEnvironment = new Map<EnvironmentId, Reconciliation>();
  const settledUpdatedAtByEnvironment = new Map<EnvironmentId, string>();
  const cancel = (environmentId: EnvironmentId) => {
    reconciliationByEnvironment.get(environmentId)?.cancelRetry?.();
    reconciliationByEnvironment.delete(environmentId);
  };
  const settleFailure = (reconciliation: Reconciliation) => {
    const { environmentId } = reconciliation.target;
    if (reconciliationByEnvironment.get(environmentId) !== reconciliation) return;
    if (reconciliation.attempt >= PLAN_MODE_PREFERENCE_RECONCILIATION_MAX_ATTEMPTS) {
      reconciliationByEnvironment.delete(environmentId);
      return;
    }
    const delayMs = 1_000 * 2 ** (reconciliation.attempt - 1);
    reconciliation.cancelRetry = scheduleRetry(() => {
      reconciliation.cancelRetry = undefined;
      if (
        activeEnvironmentIds.has(environmentId) &&
        reconciliationByEnvironment.get(environmentId) === reconciliation
      ) {
        dispatch(reconciliation);
      }
    }, delayMs);
  };
  const dispatch = (reconciliation: Reconciliation) => {
    reconciliation.attempt += 1;
    void reconciliation.patch().then(
      (preferences) => {
        const { environmentId } = reconciliation.target;
        if (reconciliationByEnvironment.get(environmentId) !== reconciliation) return;
        if (preferences === null) {
          settleFailure(reconciliation);
          return;
        }
        reconciliationByEnvironment.delete(environmentId);
        settledUpdatedAtByEnvironment.set(environmentId, reconciliation.target.input.updatedAt);
        const localPatch = canonicalPlanModePreferencePatch(preferences);
        if (localPatch !== null) reconciliation.persist(localPatch);
      },
      () => settleFailure(reconciliation),
    );
  };

  return {
    setActiveEnvironmentIds(environmentIds: ReadonlyArray<EnvironmentId>) {
      const nextEnvironmentIds = new Set(environmentIds);
      for (const environmentId of activeEnvironmentIds) {
        if (nextEnvironmentIds.has(environmentId)) continue;
        cancel(environmentId);
        settledUpdatedAtByEnvironment.delete(environmentId);
      }
      activeEnvironmentIds = nextEnvironmentIds;
    },
    observe(environmentId: EnvironmentId, updatedAt: string | undefined) {
      const reconciliation = reconciliationByEnvironment.get(environmentId);
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
      if (
        !activeEnvironmentIds.has(environmentId) ||
        settledUpdatedAtByEnvironment.get(environmentId) === input.target.input.updatedAt
      ) {
        return;
      }
      const current = reconciliationByEnvironment.get(environmentId);
      if (current?.target.input.updatedAt === input.target.input.updatedAt) {
        current.patch = async () => {
          const result = await input.patch(input.target);
          return result._tag === "Success" ? result.value : null;
        };
        current.persist = input.persist;
        return;
      }
      if (current !== undefined) cancel(environmentId);
      settledUpdatedAtByEnvironment.delete(environmentId);
      const reconciliation: Reconciliation = {
        target: input.target,
        attempt: 0,
        patch: async () => {
          const result = await input.patch(input.target);
          return result._tag === "Success" ? result.value : null;
        },
        persist: input.persist,
      };
      reconciliationByEnvironment.set(environmentId, reconciliation);
      dispatch(reconciliation);
    },
    reset() {
      for (const environmentId of reconciliationByEnvironment.keys()) cancel(environmentId);
      activeEnvironmentIds.clear();
      settledUpdatedAtByEnvironment.clear();
    },
  };
}

export async function fanOutPlanModePreferencePatches(
  targets: ReadonlyArray<PlanModePreferencePatchTarget>,
  patch: (target: PlanModePreferencePatchTarget) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(targets.map(patch));
}

export function canonicalPlanModePreferencePatch(
  preferences: SyncedClientPreferences,
): Partial<Preferences> | null {
  return preferences.planModeEnabled === undefined
    ? null
    : {
        planModeEnabled: preferences.planModeEnabled,
        syncedClientPreferencesUpdatedAt: preferences.updatedAt,
      };
}

export function settlePendingPlanModePreferencePatch<E>(input: {
  readonly pendingByEnvironment: Map<EnvironmentId, string>;
  readonly target: PlanModePreferencePatchTarget;
  readonly result: AtomCommandResult<SyncedClientPreferences, E>;
}): Partial<Preferences> | null {
  if (input.pendingByEnvironment.get(input.target.environmentId) !== input.target.input.updatedAt) {
    return null;
  }
  input.pendingByEnvironment.delete(input.target.environmentId);
  return input.result._tag === "Success"
    ? canonicalPlanModePreferencePatch(input.result.value)
    : null;
}

export function nextMobileSyncedPreferencesUpdatedAt(
  localUpdatedAts: ReadonlyArray<string | undefined>,
  now: string,
  authoritativeUpdatedAts: ReadonlyArray<string | undefined> = [],
): string {
  const maximumUpdatedAt = Date.parse(now) + SYNCED_CLIENT_PREFERENCES_MAX_FUTURE_SKEW_MS;
  const latestLocal = localUpdatedAts.reduce<string | undefined>(
    (current, candidate) =>
      candidate !== undefined &&
      Date.parse(candidate) <= maximumUpdatedAt &&
      (current === undefined || candidate > current)
        ? candidate
        : current,
    undefined,
  );
  const latest = authoritativeUpdatedAts.reduce<string | undefined>(
    (current, candidate) =>
      candidate !== undefined && (current === undefined || candidate > current)
        ? candidate
        : current,
    latestLocal,
  );
  if (latest === undefined || now > latest) return now;
  return new Date(Date.parse(latest) + 1).toISOString();
}

export function createPlanModePreferenceWrite(input: {
  readonly value: boolean;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly currentUpdatedAts: ReadonlyArray<string | undefined>;
  readonly authoritativeUpdatedAts?: ReadonlyArray<string | undefined>;
  readonly now: string;
}): {
  readonly localPatch: Pick<Preferences, "planModeEnabled" | "syncedClientPreferencesUpdatedAt">;
  readonly environmentPatches: ReadonlyArray<PlanModePreferencePatchTarget>;
} {
  const updatedAt = nextMobileSyncedPreferencesUpdatedAt(
    input.currentUpdatedAts,
    input.now,
    input.authoritativeUpdatedAts,
  );
  const request = {
    patch: { planModeEnabled: input.value },
    updatedAt,
  } as const;
  return {
    localPatch: {
      planModeEnabled: input.value,
      syncedClientPreferencesUpdatedAt: updatedAt,
    },
    environmentPatches: input.connectedEnvironmentIds.map((environmentId) => ({
      environmentId,
      input: request,
    })),
  };
}

export function createPlanModePreferenceWriteController() {
  let latestRequestedUpdatedAt: string | undefined;

  return {
    create(input: Parameters<typeof createPlanModePreferenceWrite>[0]) {
      const write = createPlanModePreferenceWrite({
        ...input,
        authoritativeUpdatedAts: [
          latestRequestedUpdatedAt,
          ...(input.authoritativeUpdatedAts ?? []),
        ],
      });
      latestRequestedUpdatedAt = write.localPatch.syncedClientPreferencesUpdatedAt;
      return write;
    },
    settle<E>(input: {
      readonly target: PlanModePreferencePatchTarget;
      readonly result: AtomCommandResult<SyncedClientPreferences, E>;
    }): Partial<Preferences> | null {
      if (input.target.input.updatedAt !== latestRequestedUpdatedAt) return null;
      return input.result._tag === "Success"
        ? canonicalPlanModePreferencePatch(input.result.value)
        : null;
    },
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
  if (input.environments.length === 0) {
    return { localPatch: null, environmentPatches: [] };
  }

  const environmentCandidates = input.environments.flatMap((environment) =>
    environment.preferences?.planModeEnabled === undefined
      ? []
      : [
          {
            source: environment.environmentId,
            value: environment.preferences.planModeEnabled,
            updatedAt: environment.preferences.updatedAt,
          },
        ],
  );
  environmentCandidates.sort(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.source.localeCompare(right.source),
  );
  const latestEnvironment = environmentCandidates.at(-1);
  const latestObservedEnvironmentUpdatedAt = input.environments.reduce<string | undefined>(
    (latest, environment) => {
      const candidate = environment.preferences?.updatedAt;
      return candidate !== undefined && (latest === undefined || candidate > latest)
        ? candidate
        : latest;
    },
    undefined,
  );
  const hasPatchableEnvironment = input.environments.some(
    (environment) => environment.canPatch !== false,
  );
  const boundedLocalUpdatedAt =
    hasPatchableEnvironment &&
    input.localUpdatedAt !== undefined &&
    latestObservedEnvironmentUpdatedAt !== undefined &&
    input.localUpdatedAt > latestObservedEnvironmentUpdatedAt
      ? nextMobileSyncedPreferencesUpdatedAt([], latestObservedEnvironmentUpdatedAt, [
          latestObservedEnvironmentUpdatedAt,
        ])
      : input.localUpdatedAt;
  // Across environments, the newest plan-bearing stamp wins. Exact stamp ties
  // use environment id for deterministic convergence; an unstamped legacy
  // device value seeds only when no environment already owns the preference.
  const localWins =
    input.localPlanModeEnabled !== undefined &&
    boundedLocalUpdatedAt !== undefined &&
    (latestEnvironment === undefined || boundedLocalUpdatedAt > latestEnvironment.updatedAt);
  const value = localWins
    ? input.localPlanModeEnabled
    : (latestEnvironment?.value ?? input.localPlanModeEnabled ?? false);
  const winningUpdatedAt = localWins ? boundedLocalUpdatedAt : latestEnvironment?.updatedAt;

  const environmentsNeedingReconciliation = input.environments.filter(
    (environment) =>
      environment.preferences?.planModeEnabled !== value ||
      environment.preferences?.updatedAt !== winningUpdatedAt,
  );
  const observedUpdatedAts = [
    boundedLocalUpdatedAt,
    ...input.environments.map((environment) => environment.preferences?.updatedAt),
  ];
  const needsNewStamp =
    environmentsNeedingReconciliation.length > 0 &&
    observedUpdatedAts.some(
      (updatedAt) =>
        updatedAt !== undefined && (winningUpdatedAt === undefined || updatedAt > winningUpdatedAt),
    );
  const updatedAt = needsNewStamp
    ? nextMobileSyncedPreferencesUpdatedAt(
        [boundedLocalUpdatedAt],
        input.now,
        input.environments.map((environment) => environment.preferences?.updatedAt),
      )
    : (winningUpdatedAt ?? input.now);
  const localPatch =
    input.localPlanModeEnabled === value && input.localUpdatedAt === updatedAt
      ? null
      : {
          planModeEnabled: value,
          syncedClientPreferencesUpdatedAt: updatedAt,
        };
  const request = { patch: { planModeEnabled: value }, updatedAt } as const;

  return {
    localPatch,
    environmentPatches: (needsNewStamp ? input.environments : environmentsNeedingReconciliation)
      .filter((environment) => environment.canPatch !== false)
      .map(({ environmentId }) => ({ environmentId, input: request })),
  };
}
