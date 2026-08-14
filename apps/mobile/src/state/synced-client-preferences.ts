import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { environmentShell } from "./shell";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";
import { useAtomCommand } from "./use-atom-command";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";
import {
  createPlanModePreferenceWriteController,
  fanOutPlanModePreferencePatches,
  reconcilePlanModePreferences,
  settlePendingPlanModePreferencePatch,
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
  const { states } = useConnectedEnvironmentPreferenceStates();
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences reconciliation",
    reportFailure: false,
  });
  const pendingByEnvironment = useRef(new Map<EnvironmentId, string>());

  useEffect(() => {
    if (!AsyncResult.isSuccess(preferencesResult)) {
      return;
    }
    const liveStates = states.filter(({ shell }) => shell.status === "live");
    if (liveStates.length === 0) return;
    for (const { environmentId, shell } of liveStates) {
      const updatedAt =
        shell.snapshot._tag === "Some"
          ? shell.snapshot.value.syncedClientPreferences?.updatedAt
          : undefined;
      if (updatedAt === pendingByEnvironment.current.get(environmentId)) {
        pendingByEnvironment.current.delete(environmentId);
      }
    }
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
      if (pendingByEnvironment.current.get(target.environmentId) === target.input.updatedAt) {
        continue;
      }
      pendingByEnvironment.current.set(target.environmentId, target.input.updatedAt);
      void patchPreferences(target).then((result) => {
        const localPatch = settlePendingPlanModePreferencePatch({
          pendingByEnvironment: pendingByEnvironment.current,
          target,
          result,
        });
        if (localPatch !== null) savePreferences(localPatch);
      });
    }
  }, [patchPreferences, preferencesResult, savePreferences, states]);
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
        currentUpdatedAts: [
          current.syncedClientPreferencesUpdatedAt,
          ...states.map(({ shell }) =>
            shell.snapshot._tag === "Some"
              ? shell.snapshot.value.syncedClientPreferences?.updatedAt
              : undefined,
          ),
        ],
        now: new Date().toISOString(),
      });
      savePreferences(write.localPatch);
      void fanOutPlanModePreferencePatches(write.environmentPatches, async (target) => {
        const result = await patchPreferences(target);
        const localPatch = writeController.settle({ target, result });
        if (localPatch !== null) savePreferences(localPatch);
      });
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
