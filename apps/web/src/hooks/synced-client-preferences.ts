import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  createSyncedClientPreferencesPatchRequest,
  SYNCED_CLIENT_PREFERENCE_MAX_ATTEMPTS,
  syncedClientPreferenceRetryDelayMs,
} from "@t3tools/client-runtime/synced-client-preferences";
import {
  getSyncedClientPreferenceUpdatedAt,
  nextSyncedClientPreferencesUpdatedAt,
  type EnvironmentId,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferenceField,
  type SyncedClientPreferences,
  type SyncedClientPreferencesPatch,
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

export function resolveSyncedPlanModeCoordinatorEnvironmentIds(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly hydratedPrimaryEnvironmentId: EnvironmentId | null;
  readonly primaryUnavailable: boolean;
}): ReadonlyArray<EnvironmentId> {
  if (input.primaryEnvironmentId === null) return [];
  if (input.primaryUnavailable) return input.environmentIds;
  if (input.hydratedPrimaryEnvironmentId !== input.primaryEnvironmentId) {
    return input.environmentIds.includes(input.primaryEnvironmentId)
      ? [input.primaryEnvironmentId]
      : [];
  }
  return input.environmentIds;
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

type SyncedClientPreferenceValue<Field extends SyncedClientPreferenceField> = Exclude<
  SyncedClientPreferences[Field],
  undefined
>;

type MutableSyncedClientPreferencesPatch = {
  -readonly [Field in SyncedClientPreferenceField]?: SyncedClientPreferencesPatch[Field];
};

function syncedClientPreferencePatch<Field extends SyncedClientPreferenceField>(
  field: Field,
  value: SyncedClientPreferenceValue<Field>,
): SyncedClientPreferencesPatch {
  const patch: MutableSyncedClientPreferencesPatch = {};
  patch[field] = value;
  return patch;
}

function syncedClientPreferenceValue<Field extends SyncedClientPreferenceField>(
  preferences: SyncedClientPreferences | undefined,
  field: Field,
): SyncedClientPreferenceValue<Field> | undefined {
  if (preferences === undefined) return undefined;
  // SAFETY: SyncedClientPreferenceField names the same value-bearing keys in both owner contracts.
  return preferences[field] as SyncedClientPreferenceValue<Field> | undefined;
}

export function createSyncedClientPreferenceWrite<
  Field extends SyncedClientPreferenceField,
>(input: {
  readonly field: Field;
  readonly value: SyncedClientPreferenceValue<Field>;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly pendingUpdatedAt?: string | undefined;
  readonly now: string;
}) {
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.serverPreferences, input.field);
  const pendingUpdatedAt = validSyncedClientPreferencesUpdatedAt(input.pendingUpdatedAt);
  const currentUpdatedAt =
    pendingUpdatedAt !== undefined &&
    (serverUpdatedAt === undefined || pendingUpdatedAt > serverUpdatedAt)
      ? pendingUpdatedAt
      : serverUpdatedAt;
  return {
    request: createSyncedClientPreferencesPatchRequest(
      syncedClientPreferencePatch(input.field, input.value),
      nextSyncedClientPreferencesUpdatedAt([currentUpdatedAt], input.now),
    ),
  } as const;
}

type SyncedClientPreferencePatchTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: PatchSyncedClientPreferencesRequest;
};

type SyncedClientPreferencePatch<E> = (
  target: SyncedClientPreferencePatchTarget,
) => Promise<AtomCommandResult<SyncedClientPreferences, E>>;

export interface SyncedClientPreferenceHydrationInput<
  Field extends SyncedClientPreferenceField,
  E,
> {
  readonly environmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly clientHydrated: boolean;
  readonly clientValue: SyncedClientPreferenceValue<Field> | undefined;
  readonly clientUpdatedAt?: string | undefined;
  readonly live: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly canPatch: boolean;
  readonly now: string;
  readonly patch: SyncedClientPreferencePatch<E>;
  readonly persist: (value: SyncedClientPreferenceValue<Field>, updatedAt: string) => void;
  readonly onHydrated?: (() => void) | undefined;
}

export type SyncedClientPreferenceHydrationAction<Field extends SyncedClientPreferenceField> =
  | { readonly type: "none" }
  | {
      readonly type: "adopt";
      readonly value: SyncedClientPreferenceValue<Field>;
      readonly updatedAt: string;
    }
  | {
      readonly type: "seed";
      readonly value: SyncedClientPreferenceValue<Field>;
      readonly updatedAt: string;
    };

export function resolveSyncedClientPreferenceHydrationAction<
  Field extends SyncedClientPreferenceField,
>(input: {
  readonly field: Field;
  readonly clientHydrated: boolean;
  readonly clientValue: SyncedClientPreferenceValue<Field> | undefined;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly seedPending: boolean;
  readonly writePending?: {
    readonly value: SyncedClientPreferenceValue<Field>;
    readonly updatedAt: string;
  };
  readonly adoptedUpdatedAt?: string;
  readonly now: string;
}): SyncedClientPreferenceHydrationAction<Field> {
  if (!input.clientHydrated || input.clientValue === undefined) return { type: "none" };
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.serverPreferences, input.field);
  if (
    input.writePending !== undefined &&
    (serverUpdatedAt === undefined || serverUpdatedAt < input.writePending.updatedAt)
  ) {
    return { type: "none" };
  }
  const serverPreferences = input.serverPreferences;
  const serverValue = syncedClientPreferenceValue(serverPreferences, input.field);
  if (serverValue !== undefined) {
    return input.adoptedUpdatedAt !== undefined &&
      serverUpdatedAt !== undefined &&
      serverUpdatedAt <= input.adoptedUpdatedAt
      ? { type: "none" }
      : {
          type: "adopt",
          value: serverValue,
          updatedAt: serverUpdatedAt ?? serverPreferences!.updatedAt,
        };
  }
  if (input.seedPending) return { type: "none" };
  return {
    type: "seed",
    value: input.clientValue,
    updatedAt: nextSyncedClientPreferencesUpdatedAt([serverUpdatedAt], input.now),
  };
}

type SyncedClientPreferenceRetryScheduler = (retry: () => void, delayMs: number) => () => void;

const scheduleSyncedClientPreferenceRetry: SyncedClientPreferenceRetryScheduler = (
  retry,
  delayMs,
) => {
  const timer = setTimeout(retry, delayMs);
  return () => clearTimeout(timer);
};

export function createSyncedClientPreferenceHydrationController<
  Field extends SyncedClientPreferenceField,
>(
  field: Field,
  scheduleRetry: SyncedClientPreferenceRetryScheduler = scheduleSyncedClientPreferenceRetry,
) {
  interface SyncedClientPreferenceEnvironmentState {
    adoptedUpdatedAt?: string;
    seedPendingUpdatedAt?: string;
    writePending?: {
      readonly value: SyncedClientPreferenceValue<Field>;
      readonly updatedAt: string;
    };
    writeInFlightUpdatedAt?: string;
    pendingAdoption?: {
      readonly value: SyncedClientPreferenceValue<Field>;
      readonly updatedAt: string;
    };
    readonly synchronizeAgainByOwner: Map<symbol, () => void>;
    cancelRetry?: () => void;
    patchAttempt: number;
    retryEpochActive: boolean;
    lastCanPatch: boolean;
  }

  const imperativeSynchronizationOwner = Symbol();
  const stateByEnvironment = new Map<EnvironmentId, SyncedClientPreferenceEnvironmentState>();
  const stateFor = (environmentId: EnvironmentId) => {
    const current = stateByEnvironment.get(environmentId);
    if (current !== undefined) return current;
    const state: SyncedClientPreferenceEnvironmentState = {
      synchronizeAgainByOwner: new Map(),
      patchAttempt: 0,
      retryEpochActive: false,
      lastCanPatch: false,
    };
    stateByEnvironment.set(environmentId, state);
    return state;
  };
  const cancelRetry = (state: SyncedClientPreferenceEnvironmentState) => {
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
  const getSynchronizeAgain = (state: SyncedClientPreferenceEnvironmentState) => {
    let latest: (() => void) | undefined;
    for (const synchronizeAgain of state.synchronizeAgainByOwner.values()) {
      latest = synchronizeAgain;
    }
    return latest;
  };
  const requestRetry = (state: SyncedClientPreferenceEnvironmentState) => {
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
  const markAdopted = (state: SyncedClientPreferenceEnvironmentState, updatedAt: string) => {
    if (state.adoptedUpdatedAt === undefined || updatedAt > state.adoptedUpdatedAt) {
      state.adoptedUpdatedAt = updatedAt;
    }
  };

  const settlePatch = <E>(input: {
    readonly environmentId: EnvironmentId;
    readonly requestedUpdatedAt: string;
    readonly result: AtomCommandResult<SyncedClientPreferences, E>;
    readonly persist: (value: SyncedClientPreferenceValue<Field>, updatedAt: string) => void;
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
    const resultUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.result.value, field);
    const resultValue = syncedClientPreferenceValue(input.result.value, field);
    if (resultUpdatedAt !== undefined && resultValue !== undefined) {
      state.pendingAdoption = { value: resultValue, updatedAt: resultUpdatedAt };
    }
    if (getSynchronizeAgain(state) === undefined || state.pendingAdoption === undefined) return;
    input.persist(state.pendingAdoption.value, state.pendingAdoption.updatedAt);
    markAdopted(state, state.pendingAdoption.updatedAt);
    input.onHydrated?.();
  };

  const dispatchPatch = <E>(input: {
    readonly target: SyncedClientPreferencePatchTarget;
    readonly patch: SyncedClientPreferencePatch<E>;
    readonly persist: (value: SyncedClientPreferenceValue<Field>, updatedAt: string) => void;
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
    input: SyncedClientPreferenceHydrationInput<Field, E>,
    owner = imperativeSynchronizationOwner,
  ) => {
    const environmentId = input.environmentId;
    if (environmentId === null) return;
    if (input.clientValue === undefined) {
      deactivate(environmentId, owner);
      return;
    }
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
    if (input.serverPreferences?.[field] !== undefined) {
      delete state.seedPendingUpdatedAt;
    }
    const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.serverPreferences, field);
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
          input: createSyncedClientPreferencesPatchRequest(
            syncedClientPreferencePatch(field, activePendingWrite.value),
            activePendingWrite.updatedAt,
          ),
        },
        patch: input.patch,
        persist: input.persist,
        onHydrated: input.onHydrated,
      });
    }

    let hydrationInput: Parameters<typeof resolveSyncedClientPreferenceHydrationAction<Field>>[0] =
      {
        field,
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
    const action = resolveSyncedClientPreferenceHydrationAction(hydrationInput);
    if (action.type === "adopt") {
      if (environmentId !== input.primaryEnvironmentId) {
        if (!input.canPatch || input.clientValue === action.value) {
          return deactivateSynchronization;
        }
        const next = createSyncedClientPreferenceWrite({
          field,
          value: input.clientValue,
          serverPreferences: input.serverPreferences,
          ...(clientUpdatedAt === undefined ? undefined : { pendingUpdatedAt: clientUpdatedAt }),
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
        input: createSyncedClientPreferencesPatchRequest(
          syncedClientPreferencePatch(field, action.value),
          action.updatedAt,
        ),
      },
      patch: input.patch,
      persist: input.persist,
      onHydrated: input.onHydrated,
    });

    return deactivateSynchronization;
  };

  const write = <E>(input: {
    readonly environmentId: EnvironmentId | null;
    readonly value: SyncedClientPreferenceValue<Field>;
    readonly serverPreferences: SyncedClientPreferences | undefined;
    readonly canPatch: boolean;
    readonly now: string;
    readonly patch: SyncedClientPreferencePatch<E>;
    readonly persist: (value: SyncedClientPreferenceValue<Field>, updatedAt: string) => void;
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
    let writeInput: Parameters<typeof createSyncedClientPreferenceWrite<Field>>[0] = {
      field,
      value: input.value,
      serverPreferences: input.serverPreferences,
      now: input.now,
    };
    if (controllerUpdatedAt !== undefined) {
      writeInput = { ...writeInput, pendingUpdatedAt: controllerUpdatedAt };
    }
    const next = createSyncedClientPreferenceWrite(writeInput);
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

export function useSyncedClientPreferenceHydrationEffect<
  Field extends SyncedClientPreferenceField,
  E,
>(
  controller: ReturnType<typeof createSyncedClientPreferenceHydrationController<Field>>,
  input: SyncedClientPreferenceHydrationInput<Field, E>,
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
