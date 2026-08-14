import type {
  EnvironmentId,
  PatchSyncedClientPreferencesRequest,
  SyncedClientPreferences,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import type { Preferences } from "../persistence/mobile-preferences";

export interface EnvironmentPreferenceState {
  readonly environmentId: EnvironmentId;
  readonly preferences: SyncedClientPreferences | undefined;
  readonly canPatch?: boolean;
}

export interface PlanModePreferencePatchTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PatchSyncedClientPreferencesRequest;
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
  currentUpdatedAts: ReadonlyArray<string | undefined>,
  now: string,
): string {
  const latest = currentUpdatedAts.reduce<string | undefined>(
    (current, candidate) =>
      candidate !== undefined && (current === undefined || candidate > current)
        ? candidate
        : current,
    undefined,
  );
  if (latest === undefined || now > latest) return now;
  return new Date(Date.parse(latest) + 1).toISOString();
}

export function createPlanModePreferenceWrite(input: {
  readonly value: boolean;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly currentUpdatedAts: ReadonlyArray<string | undefined>;
  readonly now: string;
}): {
  readonly localPatch: Pick<Preferences, "planModeEnabled" | "syncedClientPreferencesUpdatedAt">;
  readonly environmentPatches: ReadonlyArray<PlanModePreferencePatchTarget>;
} {
  const updatedAt = nextMobileSyncedPreferencesUpdatedAt(input.currentUpdatedAts, input.now);
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
        currentUpdatedAts: [latestRequestedUpdatedAt, ...input.currentUpdatedAts],
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
  const boundedLocalUpdatedAt =
    input.localUpdatedAt !== undefined &&
    latestObservedEnvironmentUpdatedAt !== undefined &&
    input.localUpdatedAt > latestObservedEnvironmentUpdatedAt
      ? nextMobileSyncedPreferencesUpdatedAt(
          [latestObservedEnvironmentUpdatedAt],
          latestObservedEnvironmentUpdatedAt,
        )
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
    ? nextMobileSyncedPreferencesUpdatedAt(observedUpdatedAts, input.now)
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
