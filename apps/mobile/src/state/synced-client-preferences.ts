import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  getSyncedClientPreferenceUpdatedAt,
  type EnvironmentId,
  type SyncedClientPreferences,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "./shell";
import { environmentPresentations } from "./presentation";
import {
  mobilePreferencesAtom,
  persistReconciledMobilePreferencesAtom,
  updateMobilePreferencesAtom,
} from "./preferences";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";
import { useAtomCommand } from "./use-atom-command";
import {
  advancePlanModePreferenceReconciliationKey,
  createPlanModePreferenceReconciliationKey,
  createPlanModePreferenceReconciliationController,
  createPlanModePreferenceWriteController,
  hasPlanModePreferenceReconciliationAttempted,
  isPlanModePreferenceReconciliationReady,
  reconcilePlanModePreferences,
  resolvePlanModeLocalPatchPersistence,
  shouldPreservePlanModeLocalValue,
} from "./synced-client-preferences-model";

interface EnvironmentPreferenceShellSlice {
  readonly shellStatus: EnvironmentShellStatus;
  readonly preferences: SyncedClientPreferences | undefined;
}

const environmentPreferenceShellSliceAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: EnvironmentPreferenceShellSlice | undefined;
  return Atom.make((get) => {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    const preferences =
      shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined;
    if (previous?.shellStatus === shell.status && previous.preferences === preferences) {
      return previous;
    }
    previous = { shellStatus: shell.status, preferences };
    return previous;
  });
});

const environmentCanPatchPreferencesAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = false;
  return Atom.make((get) => {
    const session = get(environmentSession.sessionStateValueAtom(environmentId));
    const next =
      session?.authenticated === true &&
      session.scopes?.includes(AuthOrchestrationOperateScope) === true;
    if (next === previous) return previous;
    previous = next;
    return previous;
  });
});

interface ConnectedEnvironmentPreferenceState {
  readonly environmentId: EnvironmentId;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly shellStatus: EnvironmentShellStatus;
  readonly preferences: SyncedClientPreferences | undefined;
  readonly canPatch: boolean;
}

let previousConnectedEnvironmentPreferenceStates:
  | {
      readonly connectionsLoaded: boolean;
      readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
      readonly reconciliationKey: string;
      readonly states: ReadonlyArray<ConnectedEnvironmentPreferenceState>;
    }
  | undefined;

const connectedEnvironmentPreferenceStatesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const states = [...presentations.entries()].map(([environmentId, presentation]) => {
    const shell = get(environmentPreferenceShellSliceAtom(environmentId));
    return {
      environmentId,
      connectionState: presentation.connection.phase,
      shellStatus: shell.shellStatus,
      preferences: shell.preferences,
      canPatch: get(environmentCanPatchPreferencesAtom(environmentId)),
    };
  });
  const reconciliationKey = createPlanModePreferenceReconciliationKey(
    states.map(({ environmentId, connectionState, shellStatus, preferences }) => ({
      environmentId,
      connectionState,
      shellStatus,
      preferences,
    })),
  );
  const connectedEnvironmentIds = states
    .filter((state) => state.connectionState === "connected" && state.canPatch)
    .map((state) => state.environmentId);
  const next = {
    connectionsLoaded: catalog.isReady,
    connectedEnvironmentIds,
    reconciliationKey,
    states,
  } as const;
  const previous = previousConnectedEnvironmentPreferenceStates;
  if (
    previous !== undefined &&
    previous.connectionsLoaded === next.connectionsLoaded &&
    previous.reconciliationKey === next.reconciliationKey &&
    previous.states.length === next.states.length &&
    previous.states.every((state, index) => {
      const candidate = next.states[index];
      return (
        candidate !== undefined &&
        state.environmentId === candidate.environmentId &&
        state.connectionState === candidate.connectionState &&
        state.shellStatus === candidate.shellStatus &&
        state.preferences === candidate.preferences &&
        state.canPatch === candidate.canPatch
      );
    })
  ) {
    return previous;
  }
  previousConnectedEnvironmentPreferenceStates = next;
  return next;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences:connected-environment-states"));

function useConnectedEnvironmentPreferenceStates() {
  return useAtomValue(connectedEnvironmentPreferenceStatesAtom);
}

const planModePreferenceReconciledKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:preferences:plan-mode-reconciled-key"),
);

export function usePlanModePreferenceReconciliationReady(): boolean {
  const appliedKey = useAtomValue(planModePreferenceReconciledKeyAtom);
  const { connectionsLoaded, reconciliationKey, states } =
    useConnectedEnvironmentPreferenceStates();
  return isPlanModePreferenceReconciliationReady({
    connectionsLoaded,
    environmentCount: states.length,
    currentKey: reconciliationKey,
    appliedKey,
  });
}

export function useSyncedClientPreferences(): void {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const persistReconciledPreferences = useAtomSet(persistReconciledMobilePreferencesAtom);
  const { connectionsLoaded, reconciliationKey, states } =
    useConnectedEnvironmentPreferenceStates();
  const reconciledKey = useAtomValue(planModePreferenceReconciledKeyAtom);
  const setReconciledKey = useAtomSet(planModePreferenceReconciledKeyAtom);
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences reconciliation",
    reportFailure: false,
  });
  const reconciliationController = useMemo(
    () => createPlanModePreferenceReconciliationController(),
    [],
  );
  const attemptedLocalPatchKeyRef = useRef<string | null>(null);

  useEffect(() => () => reconciliationController.reset(), [reconciliationController]);

  useEffect(() => {
    const liveStates = states.filter(
      ({ connectionState, shellStatus }) =>
        connectionState === "connected" && shellStatus === "live",
    );
    reconciliationController.setActiveEnvironmentIds(
      liveStates.filter(({ canPatch }) => canPatch).map(({ environmentId }) => environmentId),
    );
    for (const { environmentId, preferences } of liveStates) {
      reconciliationController.observe(
        environmentId,
        preferences?.planModeEnabled,
        getSyncedClientPreferenceUpdatedAt(preferences, "planModeEnabled"),
      );
    }
    if (!connectionsLoaded) {
      setReconciledKey(null);
      return;
    }
    const nextReconciledKey = advancePlanModePreferenceReconciliationKey(
      reconciledKey,
      reconciliationKey,
    );
    if (states.length === 0) {
      setReconciledKey(nextReconciledKey);
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) return;
    const reconciliationAttempted = hasPlanModePreferenceReconciliationAttempted(
      states.map(({ connectionState, shellStatus }) => ({
        connectionState,
        shellStatus,
      })),
    );
    if (!reconciliationAttempted) return;
    if (liveStates.length === 0) {
      // A loaded catalog with only terminal offline states has no server value
      // to apply. The device value governs until an environment reconnects.
      setReconciledKey(nextReconciledKey);
      return;
    }
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: preferencesResult.value.planModeEnabled,
      localUpdatedAt:
        preferencesResult.value.syncedClientPreferencesUpdatedAtByField?.planModeEnabled ??
        preferencesResult.value.syncedClientPreferencesUpdatedAt,
      environments: liveStates.map(({ environmentId, preferences, canPatch }) => ({
        environmentId,
        canPatch,
        preferences,
      })),
      now: new Date().toISOString(),
      preserveLocalOnEqualStamp: shouldPreservePlanModeLocalValue({
        currentKey: reconciliationKey,
        appliedKey: reconciledKey,
      }),
    });
    const localPersistence = resolvePlanModeLocalPatchPersistence({
      attemptedKey: attemptedLocalPatchKeyRef.current,
      localPatch: reconciliation.localPatch,
    });
    attemptedLocalPatchKeyRef.current = localPersistence.nextAttemptedKey;
    if (localPersistence.shouldPersist && reconciliation.localPatch !== null) {
      savePreferences(reconciliation.localPatch);
    }
    for (const target of reconciliation.environmentPatches) {
      reconciliationController.reconcile({
        target,
        patch: patchPreferences,
        persist: (patch) =>
          persistReconciledPreferences({
            expectedUpdatedAtByField: { planModeEnabled: target.input.updatedAt },
            patch,
          }),
      });
    }
    setReconciledKey(nextReconciledKey);
  }, [
    connectionsLoaded,
    patchPreferences,
    persistReconciledPreferences,
    preferencesResult,
    reconciledKey,
    reconciliationKey,
    reconciliationController,
    savePreferences,
    setReconciledKey,
    states,
  ]);
}

export function useUpdatePlanModePreference() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { connectedEnvironmentIds, states } = useConnectedEnvironmentPreferenceStates();
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences update",
    reportFailure: false,
  });
  const writeController = useMemo(() => createPlanModePreferenceWriteController(), []);

  return useCallback(
    (value: boolean) => {
      const current = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
      const write = writeController.create({
        value,
        connectedEnvironmentIds,
        currentUpdatedAtByField: current.syncedClientPreferencesUpdatedAtByField,
        legacyCurrentUpdatedAt: current.syncedClientPreferencesUpdatedAt,
        authoritativePreferences: states.map(({ preferences }) => preferences),
        now: new Date().toISOString(),
      });
      savePreferences(write.localPatch);
      void Promise.allSettled(
        write.environmentPatches.map(async (target) => {
          const result = await patchPreferences(target);
          const localPatch = writeController.settle({ target, result });
          if (localPatch !== null) savePreferences(localPatch);
        }),
      );
    },
    [
      connectedEnvironmentIds,
      patchPreferences,
      preferencesResult,
      savePreferences,
      states,
      writeController,
    ],
  );
}
