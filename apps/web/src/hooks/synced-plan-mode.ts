import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  getSyncedClientPreferenceUpdatedAt,
  nextSyncedClientPreferencesUpdatedAt,
  type EnvironmentId,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferences,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

export const SHELL_NOT_LIVE = Symbol("shell-not-live");

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
  readonly pendingUpdatedAt?: string;
  readonly now: string;
}) {
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(
    input.serverPreferences,
    "planModeEnabled",
  );
  const currentUpdatedAt =
    input.pendingUpdatedAt !== undefined &&
    (serverUpdatedAt === undefined || input.pendingUpdatedAt > serverUpdatedAt)
      ? input.pendingUpdatedAt
      : serverUpdatedAt;
  return {
    clientPatch: { planModeEnabled: input.value },
    request: {
      patch: { planModeEnabled: input.value },
      updatedAt: nextSyncedClientPreferencesUpdatedAt([currentUpdatedAt], input.now),
    },
  } as const;
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
  readonly live: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly canPatch: boolean;
  readonly now: string;
  readonly patch: SyncedPlanModePatch<E>;
  readonly persist: (value: boolean) => void;
}

export type SyncedPlanModeHydrationAction =
  | { readonly type: "none" }
  | { readonly type: "adopt"; readonly value: boolean; readonly updatedAt: string }
  | { readonly type: "seed"; readonly value: boolean; readonly updatedAt: string };

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

const SYNCED_PLAN_MODE_RETRY_DELAY_MS = 1_000;

type SyncedPlanModeRetryScheduler = (retry: () => void) => () => void;

const scheduleSyncedPlanModeRetry: SyncedPlanModeRetryScheduler = (retry) => {
  const timer = setTimeout(retry, SYNCED_PLAN_MODE_RETRY_DELAY_MS);
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
  }

  const imperativeSynchronizationOwner = Symbol();
  const stateByEnvironment = new Map<EnvironmentId, SyncedPlanModeEnvironmentState>();
  const stateFor = (environmentId: EnvironmentId) => {
    const current = stateByEnvironment.get(environmentId);
    if (current !== undefined) return current;
    const state: SyncedPlanModeEnvironmentState = { synchronizeAgainByOwner: new Map() };
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
    if (state.cancelRetry !== undefined || getSynchronizeAgain(state) === undefined) return;
    state.cancelRetry = scheduleRetry(() => {
      delete state.cancelRetry;
      getSynchronizeAgain(state)?.();
    });
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
    readonly persist: (value: boolean) => void;
  }) => {
    const state = stateByEnvironment.get(input.environmentId);
    if (state === undefined) return;
    if (state.writeInFlightUpdatedAt === input.requestedUpdatedAt) {
      delete state.writeInFlightUpdatedAt;
    }
    if (input.result._tag === "Failure") {
      if (state.seedPendingUpdatedAt === input.requestedUpdatedAt) {
        delete state.seedPendingUpdatedAt;
      }
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
    input.persist(state.pendingAdoption.value);
    markAdopted(state, state.pendingAdoption.updatedAt);
  };

  const dispatchPatch = <E>(input: {
    readonly target: SyncedPlanModePatchTarget;
    readonly patch: SyncedPlanModePatch<E>;
    readonly persist: (value: boolean) => void;
  }) => {
    const { environmentId } = input.target;
    const requestedUpdatedAt = input.target.input.updatedAt;
    stateFor(environmentId).writeInFlightUpdatedAt = requestedUpdatedAt;
    void input.patch(input.target).then((result) => {
      settlePatch({ environmentId, requestedUpdatedAt, result, persist: input.persist });
    });
  };

  const synchronize = <E>(
    input: SyncedPlanModeHydrationInput<E>,
    owner = imperativeSynchronizationOwner,
  ) => {
    const environmentId = input.environmentId;
    if (environmentId === null) return;
    if (environmentId !== input.primaryEnvironmentId || !input.live) {
      deactivate(environmentId, owner);
      return;
    }
    const state = stateFor(environmentId);
    state.synchronizeAgainByOwner.set(owner, () => synchronize(input, owner));
    const deactivateSynchronization = () => deactivate(environmentId, owner);
    if (input.serverPreferences?.planModeEnabled !== undefined) {
      delete state.seedPendingUpdatedAt;
    }
    const pendingWrite = state.writePending;
    const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(
      input.serverPreferences,
      "planModeEnabled",
    );
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
        input.persist(state.pendingAdoption.value);
      }
      markAdopted(state, state.pendingAdoption.updatedAt);
    }
    if (
      pendingWrite !== undefined &&
      serverUpdatedAt !== undefined &&
      serverUpdatedAt >= pendingWrite.updatedAt
    ) {
      delete state.writePending;
      delete state.writeInFlightUpdatedAt;
      cancelRetry(state);
    }
    const activePendingWrite = state.writePending;
    if (
      input.canPatch &&
      activePendingWrite !== undefined &&
      (serverUpdatedAt === undefined || serverUpdatedAt < activePendingWrite.updatedAt) &&
      state.writeInFlightUpdatedAt !== activePendingWrite.updatedAt
    ) {
      dispatchPatch<E>({
        target: {
          environmentId,
          input: {
            patch: { planModeEnabled: activePendingWrite.value },
            updatedAt: activePendingWrite.updatedAt,
          },
        },
        patch: input.patch,
        persist: input.persist,
      });
    }

    const action = resolveSyncedPlanModeHydrationAction({
      clientHydrated: input.clientHydrated,
      clientValue: input.clientValue,
      serverPreferences: input.serverPreferences,
      seedPending: state.seedPendingUpdatedAt !== undefined,
      ...(activePendingWrite === undefined ? {} : { writePending: activePendingWrite }),
      ...(state.adoptedUpdatedAt === undefined ? {} : { adoptedUpdatedAt: state.adoptedUpdatedAt }),
      now: input.now,
    });
    if (action.type === "adopt") {
      if (!input.canPatch) return deactivateSynchronization;
      markAdopted(state, action.updatedAt);
      if (input.clientValue !== action.value) input.persist(action.value);
      return deactivateSynchronization;
    }
    if (action.type !== "seed" || !input.canPatch) return deactivateSynchronization;

    state.seedPendingUpdatedAt = action.updatedAt;
    dispatchPatch<E>({
      target: {
        environmentId,
        input: {
          patch: { planModeEnabled: action.value },
          updatedAt: action.updatedAt,
        },
      },
      patch: input.patch,
      persist: input.persist,
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
    readonly persist: (value: boolean) => void;
  }) => {
    if (input.environmentId === null) return;
    const environmentId = input.environmentId;
    const state = stateFor(environmentId);
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
    const next = createSyncedPlanModeWrite({
      value: input.value,
      serverPreferences: input.serverPreferences,
      ...(controllerUpdatedAt === undefined ? {} : { pendingUpdatedAt: controllerUpdatedAt }),
      now: input.now,
    });
    state.writePending = {
      value: input.value,
      updatedAt: next.request.updatedAt,
    };
    delete state.pendingAdoption;
    if (!input.canPatch) return;
    dispatchPatch<E>({
      target: { environmentId, input: next.request },
      patch: input.patch,
      persist: input.persist,
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
      input.clientValue,
      input.environmentId,
      input.live,
      input.patch,
      input.persist,
      input.primaryEnvironmentId,
      input.serverPreferences,
      synchronizationOwner,
    ],
  );
}
