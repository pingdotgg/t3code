import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  createPlanModePreferencePatchRequest,
  SYNCED_CLIENT_PREFERENCE_MAX_ATTEMPTS,
  syncedClientPreferenceRetryDelayMs,
} from "@t3tools/client-runtime/synced-client-preferences";
import {
  getSyncedClientPreferenceUpdatedAt,
  nextSyncedClientPreferencesUpdatedAt,
  type EnvironmentId,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferences,
  SyncedClientPreferencesUpdatedAt,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

export const SHELL_NOT_LIVE = Symbol("shell-not-live");
const isSyncedClientPreferencesUpdatedAt = Schema.is(SyncedClientPreferencesUpdatedAt);

function validSyncedClientPreferencesUpdatedAt(updatedAt: string | undefined): string | undefined {
  return updatedAt !== undefined && isSyncedClientPreferencesUpdatedAt(updatedAt)
    ? updatedAt
    : undefined;
}

export function createSyncedClientPreferencesSliceAtom(
  shellStateAtom: Atom.Atom<EnvironmentShellState>,
) {
  return Atom.make((get): SyncedClientPreferences | undefined | typeof SHELL_NOT_LIVE => {
    const shell = get(shellStateAtom);
    if (shell.status !== "live") return SHELL_NOT_LIVE;
    return Option.getOrNull(shell.snapshot)?.syncedClientPreferences;
  });
}

export function createSyncedPlanModeWrite(input: {
  readonly value: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly pendingUpdatedAt?: string | undefined;
  readonly now: string;
}) {
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(
    input.serverPreferences,
    "planModeEnabled",
  );
  const pendingUpdatedAt = validSyncedClientPreferencesUpdatedAt(input.pendingUpdatedAt);
  const currentUpdatedAt =
    pendingUpdatedAt !== undefined &&
    (serverUpdatedAt === undefined || pendingUpdatedAt > serverUpdatedAt)
      ? pendingUpdatedAt
      : serverUpdatedAt;
  const updatedAt = nextSyncedClientPreferencesUpdatedAt([currentUpdatedAt], input.now);
  return { request: createPlanModePreferencePatchRequest(input.value, updatedAt) } as const;
}

type SyncedPlanModePatchTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: PatchSyncedClientPreferencesRequest;
};

type SyncedPlanModePatch<E> = (
  target: SyncedPlanModePatchTarget,
) => Promise<AtomCommandResult<SyncedClientPreferences, E>>;

export interface SyncedPlanModeHydrationInput<E> {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly clientHydrated: boolean;
  readonly clientValue: boolean;
  readonly clientUpdatedAt?: string | undefined;
  readonly live: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly canPatch: boolean;
  readonly now: string;
  readonly patch: SyncedPlanModePatch<E>;
  readonly persist: (value: boolean, updatedAt: string) => void;
  readonly onHydrated?: (() => void) | undefined;
}

export type SyncedPlanModeHydrationAction =
  | { readonly type: "none" }
  | { readonly type: "adopt"; readonly value: boolean; readonly updatedAt: string }
  | { readonly type: "seed"; readonly value: boolean; readonly updatedAt: string };

export function resolveSyncedPlanModeCoordinatorEnvironmentIds(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly hydratedPrimaryEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<EnvironmentId> {
  if (input.primaryEnvironmentId === null) return [];
  if (input.hydratedPrimaryEnvironmentId !== input.primaryEnvironmentId) {
    return input.environmentIds.includes(input.primaryEnvironmentId)
      ? [input.primaryEnvironmentId]
      : [];
  }
  return input.environmentIds;
}

export function resolveSyncedPlanModeHydrationAction(input: {
  readonly clientHydrated: boolean;
  readonly clientValue: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly seedPending: boolean;
  readonly writePending?: { readonly value: boolean; readonly updatedAt: string };
  readonly adoptedUpdatedAt?: string;
  readonly now: string;
}): SyncedPlanModeHydrationAction {
  if (!input.clientHydrated) return { type: "none" };
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(
    input.serverPreferences,
    "planModeEnabled",
  );
  if (
    input.writePending !== undefined &&
    (serverUpdatedAt === undefined || serverUpdatedAt < input.writePending.updatedAt)
  ) {
    return { type: "none" };
  }
  if (input.serverPreferences?.planModeEnabled !== undefined) {
    return input.adoptedUpdatedAt !== undefined &&
      serverUpdatedAt !== undefined &&
      serverUpdatedAt <= input.adoptedUpdatedAt
      ? { type: "none" }
      : {
          type: "adopt",
          value: input.serverPreferences.planModeEnabled,
          updatedAt: serverUpdatedAt ?? input.serverPreferences.updatedAt,
        };
  }
  if (input.seedPending) return { type: "none" };
  return {
    type: "seed",
    value: input.clientValue,
    updatedAt: nextSyncedClientPreferencesUpdatedAt([serverUpdatedAt], input.now),
  };
}

type SyncedPlanModeRetryScheduler = (retry: () => void, delayMs: number) => () => void;

const scheduleSyncedPlanModeRetry: SyncedPlanModeRetryScheduler = (retry, delayMs) => {
  const timer = setTimeout(retry, delayMs);
  return () => clearTimeout(timer);
};

export function createSyncedPlanModeHydrationController(
  scheduleRetry: SyncedPlanModeRetryScheduler = scheduleSyncedPlanModeRetry,
) {
  interface SyncedPlanModeEnvironmentState {
    adoptedUpdatedAt?: string;
    seedPendingUpdatedAt?: string;
    writePending?: { readonly value: boolean; readonly updatedAt: string };
    writeInFlightUpdatedAt?: string;
    pendingAdoption?: { readonly value: boolean; readonly updatedAt: string };
    readonly synchronizeAgainByOwner: Map<symbol, () => void>;
    cancelRetry?: () => void;
    patchAttempt: number;
    retryEpochActive: boolean;
    lastCanPatch: boolean;
  }

  const imperativeSynchronizationOwner = Symbol();
  const stateByEnvironment = new Map<EnvironmentId, SyncedPlanModeEnvironmentState>();
  const stateFor = (environmentId: EnvironmentId) => {
    const current = stateByEnvironment.get(environmentId);
    if (current !== undefined) return current;
    const state: SyncedPlanModeEnvironmentState = {
      synchronizeAgainByOwner: new Map(),
      patchAttempt: 0,
      retryEpochActive: false,
      lastCanPatch: false,
    };
    stateByEnvironment.set(environmentId, state);
    return state;
  };
  const cancelRetry = (state: SyncedPlanModeEnvironmentState) => {
    state.cancelRetry?.();
    delete state.cancelRetry;
  };
  const deactivate = (environmentId: EnvironmentId, owner: symbol) => {
    const state = stateByEnvironment.get(environmentId);
    if (state === undefined) return;
    state.synchronizeAgainByOwner.delete(owner);
    if (state.synchronizeAgainByOwner.size > 0) return;
    cancelRetry(state);
  };
  const getSynchronizeAgain = (state: SyncedPlanModeEnvironmentState) => {
    let latest: (() => void) | undefined;
    for (const synchronizeAgain of state.synchronizeAgainByOwner.values()) {
      latest = synchronizeAgain;
    }
    return latest;
  };
  const requestRetry = (state: SyncedPlanModeEnvironmentState) => {
    if (
      state.patchAttempt >= SYNCED_CLIENT_PREFERENCE_MAX_ATTEMPTS ||
      state.cancelRetry !== undefined ||
      getSynchronizeAgain(state) === undefined
    ) {
      return;
    }
    const delayMs = syncedClientPreferenceRetryDelayMs(state.patchAttempt);
    state.cancelRetry = scheduleRetry(() => {
      delete state.cancelRetry;
      getSynchronizeAgain(state)?.();
    }, delayMs);
  };
  const markAdopted = (state: SyncedPlanModeEnvironmentState, updatedAt: string) => {
    if (state.adoptedUpdatedAt === undefined || updatedAt > state.adoptedUpdatedAt) {
      state.adoptedUpdatedAt = updatedAt;
    }
  };

  const settlePatch = <E>(input: {
    readonly environmentId: EnvironmentId;
    readonly requestedUpdatedAt: string;
    readonly result: AtomCommandResult<SyncedClientPreferences, E>;
    readonly persist: (value: boolean, updatedAt: string) => void;
    readonly onHydrated: (() => void) | undefined;
  }) => {
    const state = stateByEnvironment.get(input.environmentId);
    if (state === undefined) return;
    if (state.writeInFlightUpdatedAt === input.requestedUpdatedAt) {
      delete state.writeInFlightUpdatedAt;
    }
    if (input.result._tag === "Failure") {
      const matchingWrite = state.writePending?.updatedAt === input.requestedUpdatedAt;
      const matchingSeed = state.seedPendingUpdatedAt === input.requestedUpdatedAt;
      if (!matchingWrite && !matchingSeed) return;
      if (matchingSeed) delete state.seedPendingUpdatedAt;
      requestRetry(state);
      return;
    }

    const pendingWrite = state.writePending;
    const matchingWrite = pendingWrite?.updatedAt === input.requestedUpdatedAt;
    const seedMatchesRequest = state.seedPendingUpdatedAt === input.requestedUpdatedAt;
    const matchingSeed =
      seedMatchesRequest &&
      (pendingWrite === undefined || pendingWrite.updatedAt <= input.requestedUpdatedAt);
    if (seedMatchesRequest) delete state.seedPendingUpdatedAt;
    if (!matchingWrite && !matchingSeed) return;

    cancelRetry(state);
    state.patchAttempt = 0;
    if (matchingWrite) delete state.writePending;
    const resultUpdatedAt = getSyncedClientPreferenceUpdatedAt(
      input.result.value,
      "planModeEnabled",
    );
    const resultValue = input.result.value.planModeEnabled;
    if (resultUpdatedAt !== undefined && resultValue !== undefined) {
      state.pendingAdoption = { value: resultValue, updatedAt: resultUpdatedAt };
    }
    if (getSynchronizeAgain(state) === undefined || state.pendingAdoption === undefined) return;
    input.persist(state.pendingAdoption.value, state.pendingAdoption.updatedAt);
    markAdopted(state, state.pendingAdoption.updatedAt);
    input.onHydrated?.();
  };

  const dispatchPatch = <E>(input: {
    readonly target: SyncedPlanModePatchTarget;
    readonly patch: SyncedPlanModePatch<E>;
    readonly persist: (value: boolean, updatedAt: string) => void;
    readonly onHydrated: (() => void) | undefined;
  }) => {
    const { environmentId } = input.target;
    const requestedUpdatedAt = input.target.input.updatedAt;
    const state = stateFor(environmentId);
    state.patchAttempt += 1;
    state.writeInFlightUpdatedAt = requestedUpdatedAt;
    void input.patch(input.target).then((result) => {
      settlePatch({
        environmentId,
        requestedUpdatedAt,
        result,
        persist: input.persist,
        onHydrated: input.onHydrated,
      });
    });
  };

  const synchronize = <E>(
    input: SyncedPlanModeHydrationInput<E>,
    owner = imperativeSynchronizationOwner,
  ) => {
    const environmentId = input.environmentId;
    if (environmentId === null) return;
    const state = stateFor(environmentId);
    if (!input.live) {
      state.retryEpochActive = false;
      state.lastCanPatch = input.canPatch;
      deactivate(environmentId, owner);
      return;
    }
    if (!state.retryEpochActive || (!state.lastCanPatch && input.canPatch)) {
      cancelRetry(state);
      state.patchAttempt = 0;
    }
    state.retryEpochActive = true;
    state.lastCanPatch = input.canPatch;
    state.synchronizeAgainByOwner.set(owner, () => synchronize(input, owner));
    const deactivateSynchronization = () => deactivate(environmentId, owner);
    if (input.serverPreferences?.planModeEnabled !== undefined) {
      delete state.seedPendingUpdatedAt;
    }
    const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(
      input.serverPreferences,
      "planModeEnabled",
    );
    const clientUpdatedAt = validSyncedClientPreferencesUpdatedAt(input.clientUpdatedAt);
    if (
      state.writePending === undefined &&
      clientUpdatedAt !== undefined &&
      (serverUpdatedAt === undefined || serverUpdatedAt < clientUpdatedAt)
    ) {
      state.writePending = {
        value: input.clientValue,
        updatedAt: clientUpdatedAt,
      };
    }
    const pendingWrite = state.writePending;
    if (
      state.pendingAdoption !== undefined &&
      serverUpdatedAt !== undefined &&
      serverUpdatedAt >= state.pendingAdoption.updatedAt
    ) {
      delete state.pendingAdoption;
    }
    if (
      state.pendingAdoption !== undefined &&
      input.clientHydrated &&
      input.canPatch &&
      (state.adoptedUpdatedAt === undefined ||
        state.pendingAdoption.updatedAt > state.adoptedUpdatedAt)
    ) {
      if (input.clientValue !== state.pendingAdoption.value) {
        input.persist(state.pendingAdoption.value, state.pendingAdoption.updatedAt);
      } else if (clientUpdatedAt !== state.pendingAdoption.updatedAt) {
        input.persist(state.pendingAdoption.value, state.pendingAdoption.updatedAt);
      }
      markAdopted(state, state.pendingAdoption.updatedAt);
      input.onHydrated?.();
    }
    if (
      pendingWrite !== undefined &&
      serverUpdatedAt !== undefined &&
      serverUpdatedAt >= pendingWrite.updatedAt
    ) {
      delete state.writePending;
      delete state.writeInFlightUpdatedAt;
      cancelRetry(state);
      state.patchAttempt = 0;
    }
    const activePendingWrite = state.writePending;
    if (
      input.canPatch &&
      activePendingWrite !== undefined &&
      state.patchAttempt < SYNCED_CLIENT_PREFERENCE_MAX_ATTEMPTS &&
      (serverUpdatedAt === undefined || serverUpdatedAt < activePendingWrite.updatedAt) &&
      state.writeInFlightUpdatedAt !== activePendingWrite.updatedAt &&
      state.cancelRetry === undefined
    ) {
      dispatchPatch<E>({
        target: {
          environmentId,
          input: createPlanModePreferencePatchRequest(
            activePendingWrite.value,
            activePendingWrite.updatedAt,
          ),
        },
        patch: input.patch,
        persist: input.persist,
        onHydrated: input.onHydrated,
      });
    }
    let hydrationInput: Parameters<typeof resolveSyncedPlanModeHydrationAction>[0] = {
      clientHydrated: input.clientHydrated,
      clientValue: input.clientValue,
      serverPreferences: input.serverPreferences,
      seedPending: state.seedPendingUpdatedAt !== undefined,
      now: input.now,
    };
    if (activePendingWrite !== undefined) {
      hydrationInput = { ...hydrationInput, writePending: activePendingWrite };
    }
    if (state.adoptedUpdatedAt !== undefined) {
      hydrationInput = { ...hydrationInput, adoptedUpdatedAt: state.adoptedUpdatedAt };
    }
    const action = resolveSyncedPlanModeHydrationAction(hydrationInput);
    if (action.type === "adopt") {
      if (environmentId !== input.primaryEnvironmentId) {
        if (!input.canPatch || input.clientValue === action.value) {
          return deactivateSynchronization;
        }
        const next = createSyncedPlanModeWrite({
          value: input.clientValue,
          serverPreferences: input.serverPreferences,
          pendingUpdatedAt: clientUpdatedAt,
          now: input.now,
        });
        state.writePending = {
          value: input.clientValue,
          updatedAt: next.request.updatedAt,
        };
        input.persist(input.clientValue, next.request.updatedAt);
        dispatchPatch<E>({
          target: { environmentId, input: next.request },
          patch: input.patch,
          persist: input.persist,
          onHydrated: input.onHydrated,
        });
        return deactivateSynchronization;
      }
      if (!input.canPatch) {
        input.onHydrated?.();
        return deactivateSynchronization;
      }
      markAdopted(state, action.updatedAt);
      if (input.clientValue !== action.value || clientUpdatedAt !== action.updatedAt) {
        input.persist(action.value, action.updatedAt);
      }
      input.onHydrated?.();
      return deactivateSynchronization;
    }
    if (action.type !== "seed") {
      if (
        environmentId === input.primaryEnvironmentId &&
        state.writePending === undefined &&
        state.writeInFlightUpdatedAt === undefined
      ) {
        input.onHydrated?.();
      }
      return deactivateSynchronization;
    }
    if (!input.canPatch) {
      input.onHydrated?.();
      return deactivateSynchronization;
    }

    state.seedPendingUpdatedAt = action.updatedAt;
    dispatchPatch<E>({
      target: {
        environmentId,
        input: createPlanModePreferencePatchRequest(action.value, action.updatedAt),
      },
      patch: input.patch,
      persist: input.persist,
      onHydrated: input.onHydrated,
    });

    return deactivateSynchronization;
  };

  const write = <E>(input: {
    readonly environmentId: EnvironmentId | null;
    readonly value: boolean;
    readonly serverPreferences: SyncedClientPreferences | undefined;
    readonly canPatch: boolean;
    readonly now: string;
    readonly patch: SyncedPlanModePatch<E>;
    readonly persist: (value: boolean, updatedAt: string) => void;
  }) => {
    if (input.environmentId === null) return;
    const environmentId = input.environmentId;
    const state = stateFor(environmentId);
    cancelRetry(state);
    state.patchAttempt = 0;
    const controllerUpdatedAt = [
      state.adoptedUpdatedAt,
      state.seedPendingUpdatedAt,
      state.writePending?.updatedAt,
      state.writeInFlightUpdatedAt,
      state.pendingAdoption?.updatedAt,
    ].reduce<string | undefined>(
      (latest, candidate) =>
        candidate !== undefined && (latest === undefined || candidate > latest)
          ? candidate
          : latest,
      undefined,
    );
    let writeInput: Parameters<typeof createSyncedPlanModeWrite>[0] = {
      value: input.value,
      serverPreferences: input.serverPreferences,
      now: input.now,
    };
    if (controllerUpdatedAt !== undefined) {
      writeInput = { ...writeInput, pendingUpdatedAt: controllerUpdatedAt };
    }
    const next = createSyncedPlanModeWrite(writeInput);
    state.writePending = {
      value: input.value,
      updatedAt: next.request.updatedAt,
    };
    input.persist(input.value, next.request.updatedAt);
    delete state.pendingAdoption;
    if (!input.canPatch) return;
    dispatchPatch<E>({
      target: { environmentId, input: next.request },
      patch: input.patch,
      persist: input.persist,
      onHydrated: undefined,
    });
  };

  return {
    synchronize,
    write,
    getPendingWrite(environmentId: EnvironmentId | null) {
      if (environmentId === null) return undefined;
      const state = stateByEnvironment.get(environmentId);
      return state?.writePending ?? state?.pendingAdoption;
    },
    reset() {
      for (const state of stateByEnvironment.values()) {
        cancelRetry(state);
        state.synchronizeAgainByOwner.clear();
      }
      stateByEnvironment.clear();
    },
  };
}

export function useSyncedPlanModeHydrationEffect<E>(
  controller: ReturnType<typeof createSyncedPlanModeHydrationController>,
  input: SyncedPlanModeHydrationInput<E>,
): void {
  const synchronizationOwner = useMemo(() => Symbol(), [controller]);
  useEffect(
    () => controller.synchronize(input, synchronizationOwner),
    [
      controller,
      input.canPatch,
      input.clientHydrated,
      input.clientUpdatedAt,
      input.clientValue,
      input.environmentId,
      input.live,
      input.patch,
      input.persist,
      input.onHydrated,
      input.primaryEnvironmentId,
      input.serverPreferences,
      synchronizationOwner,
    ],
  );
}
