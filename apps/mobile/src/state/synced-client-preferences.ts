import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { environmentShell } from "./shell";
import {
  mobilePreferencesAtom,
  persistReconciledMobilePreferencesAtom,
  updateMobilePreferencesAtom,
} from "./preferences";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";
import { useAtomCommand } from "./use-atom-command";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";
import {
  createPlanModePreferenceReconciliationController,
  createPlanModePreferenceWriteController,
  reconcilePlanModePreferences,
} from "./synced-client-preferences-model";

function useConnectedEnvironmentPreferenceStates() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connectedEnvironmentIds = useMemo(
    () =>
      connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    [connectedEnvironments],
  );
  const statesAtom = useMemo(
    () =>
      Atom.make((get) =>
        connectedEnvironmentIds.map((environmentId) => ({
          environmentId,
          shell: get(environmentShell.stateValueAtom(environmentId)),
          session: get(environmentSession.sessionStateValueAtom(environmentId)),
        })),
      ),
    [connectedEnvironmentIds],
  );
  const states = useAtomValue(statesAtom).map(({ environmentId, shell, session }) => ({
    environmentId,
    shell,
    canPatch:
      session?.authenticated === true &&
      session.scopes?.includes(AuthOrchestrationOperateScope) === true,
  }));
  return {
    connectedEnvironmentIds: states
      .filter((state) => state.canPatch)
      .map((state) => state.environmentId),
    states,
  } as const;
}

export function useSyncedClientPreferences(): void {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const persistReconciledPreferences = useAtomSet(persistReconciledMobilePreferencesAtom);
  const { states } = useConnectedEnvironmentPreferenceStates();
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences reconciliation",
    reportFailure: false,
  });
  const reconciliationController = useMemo(
    () => createPlanModePreferenceReconciliationController(),
    [],
  );

  useEffect(() => () => reconciliationController.reset(), [reconciliationController]);

  useEffect(() => {
    const liveStates = states.filter(({ shell }) => shell.status === "live");
    reconciliationController.setActiveEnvironmentIds(
      liveStates.filter(({ canPatch }) => canPatch).map(({ environmentId }) => environmentId),
    );
    for (const { environmentId, shell } of liveStates) {
      const updatedAt =
        shell.snapshot._tag === "Some"
          ? shell.snapshot.value.syncedClientPreferences?.updatedAt
          : undefined;
      reconciliationController.observe(environmentId, updatedAt);
    }
    if (!AsyncResult.isSuccess(preferencesResult) || liveStates.length === 0) return;
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: preferencesResult.value.planModeEnabled,
      localUpdatedAt: preferencesResult.value.syncedClientPreferencesUpdatedAt,
      environments: liveStates.map(({ environmentId, shell, canPatch }) => ({
        environmentId,
        canPatch,
        preferences:
          shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined,
      })),
      now: new Date().toISOString(),
    });
    if (reconciliation.localPatch !== null) savePreferences(reconciliation.localPatch);
    for (const target of reconciliation.environmentPatches) {
      reconciliationController.reconcile({
        target,
        patch: patchPreferences,
        persist: (patch) =>
          persistReconciledPreferences({
            expectedUpdatedAt: target.input.updatedAt,
            patch,
          }),
      });
    }
  }, [
    patchPreferences,
    persistReconciledPreferences,
    preferencesResult,
    reconciliationController,
    savePreferences,
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
        currentUpdatedAts: [current.syncedClientPreferencesUpdatedAt],
        authoritativeUpdatedAts: states.map(({ shell }) =>
          shell.snapshot._tag === "Some"
            ? shell.snapshot.value.syncedClientPreferences?.updatedAt
            : undefined,
        ),
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
