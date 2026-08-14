import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  getSyncedClientPreferenceUpdatedAt,
  nextSyncedClientPreferencesUpdatedAt,
  type EnvironmentId,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferenceField,
  type SyncedClientPreferences,
  type SyncedClientPreferencesPatch,
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

type SyncedClientPreferenceValue<Field extends SyncedClientPreferenceField> = Exclude<
  SyncedClientPreferencesPatch[Field],
  undefined
>;

function syncedClientPreferencePatch<Field extends SyncedClientPreferenceField>(
  field: Field,
  value: SyncedClientPreferenceValue<Field>,
): SyncedClientPreferencesPatch {
  return { [field]: value } as SyncedClientPreferencesPatch;
}

export function createSyncedClientPreferenceWrite<
  Field extends SyncedClientPreferenceField,
>(input: {
  readonly field: Field;
  readonly value: SyncedClientPreferenceValue<Field>;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly pendingUpdatedAt?: string;
  readonly now: string;
}) {
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.serverPreferences, input.field);
  const currentUpdatedAt =
    input.pendingUpdatedAt !== undefined &&
    (serverUpdatedAt === undefined || input.pendingUpdatedAt > serverUpdatedAt)
      ? input.pendingUpdatedAt
      : serverUpdatedAt;
  return {
    request: {
      patch: syncedClientPreferencePatch(input.field, input.value),
      updatedAt: nextSyncedClientPreferencesUpdatedAt([currentUpdatedAt], input.now),
    },
  } as const;
}

export function createSyncedPlanModeWrite(
  input: Omit<Parameters<typeof createSyncedClientPreferenceWrite<"planModeEnabled">>[0], "field">,
) {
  return {
    clientPatch: { planModeEnabled: input.value },
    ...createSyncedClientPreferenceWrite({ ...input, field: "planModeEnabled" }),
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
  readonly clientValue: SyncedClientPreferenceValue<Field>;
  readonly live: boolean;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly canPatch: boolean;
  readonly now: string;
  readonly patch: SyncedClientPreferencePatch<E>;
  readonly persist: (value: SyncedClientPreferenceValue<Field>) => void;
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
  readonly clientValue: SyncedClientPreferenceValue<Field>;
  readonly serverPreferences: SyncedClientPreferences | undefined;
  readonly seedPending: boolean;
  readonly writePending?: {
    readonly value: SyncedClientPreferenceValue<Field>;
    readonly updatedAt: string;
  };
  readonly adoptedUpdatedAt?: string;
  readonly now: string;
}): SyncedClientPreferenceHydrationAction<Field> {
  if (!input.clientHydrated) return { type: "none" };
  const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.serverPreferences, input.field);
  if (
    input.writePending !== undefined &&
    (serverUpdatedAt === undefined || serverUpdatedAt < input.writePending.updatedAt)
  ) {
    return { type: "none" };
  }
  const serverPreferences = input.serverPreferences;
  const serverValue = serverPreferences?.[input.field] as
    | SyncedClientPreferenceValue<Field>
    | undefined;
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

export type SyncedPlanModeHydrationInput<E> = SyncedClientPreferenceHydrationInput<
  "planModeEnabled",
  E
>;
export type SyncedPlanModeHydrationAction =
  SyncedClientPreferenceHydrationAction<"planModeEnabled">;

export function resolveSyncedPlanModeHydrationAction(
  input: Omit<
    Parameters<typeof resolveSyncedClientPreferenceHydrationAction<"planModeEnabled">>[0],
    "field"
  >,
): SyncedPlanModeHydrationAction {
  return resolveSyncedClientPreferenceHydrationAction({
    ...input,
    field: "planModeEnabled",
  });
}

const SYNCED_CLIENT_PREFERENCE_RETRY_DELAY_MS = 1_000;
const SYNCED_CLIENT_PREFERENCE_MAX_ATTEMPTS = 3;

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
  }

  const imperativeSynchronizationOwner = Symbol();
  const stateByEnvironment = new Map<EnvironmentId, SyncedClientPreferenceEnvironmentState>();
  const stateFor = (environmentId: EnvironmentId) => {
    const current = stateByEnvironment.get(environmentId);
    if (current !== undefined) return current;
    const state: SyncedClientPreferenceEnvironmentState = {
      synchronizeAgainByOwner: new Map(),
      patchAttempt: 0,
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
    const delayMs = SYNCED_CLIENT_PREFERENCE_RETRY_DELAY_MS * 2 ** (state.patchAttempt - 1);
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
    readonly persist: (value: SyncedClientPreferenceValue<Field>) => void;
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
    const resultValue = input.result.value[field] as SyncedClientPreferenceValue<Field> | undefined;
    if (resultUpdatedAt !== undefined && resultValue !== undefined) {
      state.pendingAdoption = { value: resultValue, updatedAt: resultUpdatedAt };
    }
    if (getSynchronizeAgain(state) === undefined || state.pendingAdoption === undefined) return;
    input.persist(state.pendingAdoption.value);
    markAdopted(state, state.pendingAdoption.updatedAt);
  };

  const dispatchPatch = <E>(input: {
    readonly target: SyncedClientPreferencePatchTarget;
    readonly patch: SyncedClientPreferencePatch<E>;
    readonly persist: (value: SyncedClientPreferenceValue<Field>) => void;
  }) => {
    const { environmentId } = input.target;
    const requestedUpdatedAt = input.target.input.updatedAt;
    const state = stateFor(environmentId);
    state.patchAttempt += 1;
    state.writeInFlightUpdatedAt = requestedUpdatedAt;
    void input.patch(input.target).then((result) => {
      settlePatch({ environmentId, requestedUpdatedAt, result, persist: input.persist });
    });
  };

  const synchronize = <E>(
    input: SyncedClientPreferenceHydrationInput<Field, E>,
    owner = imperativeSynchronizationOwner,
  ) => {
    const environmentId = input.environmentId;
    if (environmentId === null) return;
    if (!input.live) {
      deactivate(environmentId, owner);
      return;
    }
    const state = stateFor(environmentId);
    state.synchronizeAgainByOwner.set(owner, () => synchronize(input, owner));
    const deactivateSynchronization = () => deactivate(environmentId, owner);
    if (input.serverPreferences?.[field] !== undefined) {
      delete state.seedPendingUpdatedAt;
    }
    const pendingWrite = state.writePending;
    const serverUpdatedAt = getSyncedClientPreferenceUpdatedAt(input.serverPreferences, field);
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
          input: {
            patch: syncedClientPreferencePatch(field, activePendingWrite.value),
            updatedAt: activePendingWrite.updatedAt,
          },
        },
        patch: input.patch,
        persist: input.persist,
      });
    }
    if (environmentId !== input.primaryEnvironmentId) return deactivateSynchronization;

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
          patch: syncedClientPreferencePatch(field, action.value),
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
    readonly value: SyncedClientPreferenceValue<Field>;
    readonly serverPreferences: SyncedClientPreferences | undefined;
    readonly canPatch: boolean;
    readonly now: string;
    readonly patch: SyncedClientPreferencePatch<E>;
    readonly persist: (value: SyncedClientPreferenceValue<Field>) => void;
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

export function createSyncedPlanModeHydrationController(
  scheduleRetry?: SyncedClientPreferenceRetryScheduler,
) {
  return createSyncedClientPreferenceHydrationController("planModeEnabled", scheduleRetry);
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

export function useSyncedPlanModeHydrationEffect<E>(
  controller: ReturnType<typeof createSyncedPlanModeHydrationController>,
  input: SyncedPlanModeHydrationInput<E>,
): void {
  useSyncedClientPreferenceHydrationEffect(controller, input);
}
