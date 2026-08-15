import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  getSyncedClientPreferenceUpdatedAt,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

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
  createPlanModePreferenceReconciliationController,
  createPlanModePreferenceWriteController,
  hasPlanModePreferenceReconciliationAttempted,
  isPlanModePreferenceReconciliationReady,
  reconcilePlanModePreferences,
} from "./synced-client-preferences-model";

const connectedEnvironmentPreferenceStatesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const localPreferences = get(mobilePreferencesAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const states = [...presentations.entries()].map(([environmentId, presentation]) => {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    const session = get(environmentSession.sessionStateValueAtom(environmentId));
    return {
      environmentId,
      connectionState: presentation.connection.phase,
      shell,
      canPatch:
        session?.authenticated === true &&
        session.scopes?.includes(AuthOrchestrationOperateScope) === true,
    };
  });
  const reconciliationKey = JSON.stringify({
    local: AsyncResult.isSuccess(localPreferences)
      ? [
          localPreferences.value.planModeEnabled,
          localPreferences.value.syncedClientPreferencesUpdatedAtByField?.planModeEnabled ??
            localPreferences.value.syncedClientPreferencesUpdatedAt,
        ]
      : null,
    environments: states
      .map(({ environmentId, connectionState, shell, canPatch }) => {
        const preferences =
          shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined;
        return [
          environmentId,
          connectionState,
          shell.status,
          canPatch,
          preferences?.planModeEnabled,
          getSyncedClientPreferenceUpdatedAt(preferences, "planModeEnabled"),
        ];
      })
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  });
  return {
    connectionsLoaded: catalog.isReady,
    connectedEnvironmentIds: states
      .filter((state) => state.connectionState === "connected" && state.canPatch)
      .map((state) => state.environmentId),
    reconciliationKey,
    states,
  } as const;
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
  const setReconciledKey = useAtomSet(planModePreferenceReconciledKeyAtom);
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
    const liveStates = states.filter(
      ({ connectionState, shell }) => connectionState === "connected" && shell.status === "live",
    );
    reconciliationController.setActiveEnvironmentIds(
      liveStates.filter(({ canPatch }) => canPatch).map(({ environmentId }) => environmentId),
    );
    for (const { environmentId, shell } of liveStates) {
      const updatedAt =
        shell.snapshot._tag === "Some"
          ? getSyncedClientPreferenceUpdatedAt(
              shell.snapshot.value.syncedClientPreferences,
              "planModeEnabled",
            )
          : undefined;
      reconciliationController.observe(environmentId, updatedAt);
    }
    if (!connectionsLoaded || states.length === 0) {
      setReconciledKey(null);
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) return;
    const reconciliationAttempted = hasPlanModePreferenceReconciliationAttempted(
      states.map(({ connectionState, shell }) => ({
        connectionState,
        shellStatus: shell.status,
      })),
    );
    if (!reconciliationAttempted) return;
    if (liveStates.length === 0) {
      // A loaded catalog with only terminal offline states has no server value
      // to apply. The device value governs until an environment reconnects.
      setReconciledKey(reconciliationKey);
      return;
    }
    const reconciliation = reconcilePlanModePreferences({
      localPlanModeEnabled: preferencesResult.value.planModeEnabled,
      localUpdatedAt:
        preferencesResult.value.syncedClientPreferencesUpdatedAtByField?.planModeEnabled ??
        preferencesResult.value.syncedClientPreferencesUpdatedAt,
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
            expectedUpdatedAtByField: { planModeEnabled: target.input.updatedAt },
            patch,
          }),
      });
    }
    setReconciledKey(reconciliationKey);
  }, [
    connectionsLoaded,
    patchPreferences,
    persistReconciledPreferences,
    preferencesResult,
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
        authoritativePreferences: states.map(({ shell }) =>
          shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined,
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
