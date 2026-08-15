import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  getSyncedClientPreferenceUpdatedAt,
  SYNCED_CLIENT_PREFERENCE_FIELDS,
  type SyncedClientPreferenceField,
  type SyncedClientPreferencesPatch,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  DEFAULT_MOBILE_APPEARANCE_MODE,
  DEFAULT_MOBILE_THEME_ID,
  isMobileThemeId,
  type MobileAppearanceMode,
} from "../lib/mobileTheme";
import type { ImportedMobileTheme } from "../lib/mobileThemeFile";
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
  createSyncedClientPreferenceReconciliationController,
  createSyncedClientPreferenceWriteController,
  hasPlanModePreferenceReconciliationAttempted,
  isPlanModePreferenceReconciliationReady,
  reconcileSyncedClientPreferences,
} from "./synced-client-preferences-model";

const connectedEnvironmentPreferenceStatesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
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
  const reconciliationKey = createPlanModePreferenceReconciliationKey(
    states.map(({ environmentId, connectionState, shell }) => ({
      environmentId,
      connectionState,
      shellStatus: shell.status,
      preferences:
        shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined,
    })),
  );
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

function resolveLocalThemeId(
  themeId: string,
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
  writtenThemeId?: string,
) {
  return themeId === writtenThemeId || isMobileThemeId(themeId, importedThemes)
    ? themeId
    : DEFAULT_MOBILE_THEME_ID;
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
  const reconciliationControllers = useMemo(
    () => ({
      planModeEnabled: createSyncedClientPreferenceReconciliationController("planModeEnabled"),
      appearanceMode: createSyncedClientPreferenceReconciliationController("appearanceMode"),
      themeId: createSyncedClientPreferenceReconciliationController("themeId"),
    }),
    [],
  );

  useEffect(
    () => () => {
      for (const controller of Object.values(reconciliationControllers)) controller.reset();
    },
    [reconciliationControllers],
  );

  useEffect(() => {
    const liveStates = states.filter(
      ({ connectionState, shell }) => connectionState === "connected" && shell.status === "live",
    );
    const activeEnvironmentIds = liveStates
      .filter(({ canPatch }) => canPatch)
      .map(({ environmentId }) => environmentId);
    for (const controller of Object.values(reconciliationControllers)) {
      controller.setActiveEnvironmentIds(activeEnvironmentIds);
    }
    for (const { environmentId, shell } of liveStates) {
      const preferences =
        shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined;
      for (const field of SYNCED_CLIENT_PREFERENCE_FIELDS) {
        reconciliationControllers[field].observe(
          environmentId,
          preferences?.[field],
          getSyncedClientPreferenceUpdatedAt(preferences, field),
        );
      }
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
      states.map(({ connectionState, shell }) => ({
        connectionState,
        shellStatus: shell.status,
      })),
    );
    if (!reconciliationAttempted) return;
    if (liveStates.length === 0) {
      // A loaded catalog with only terminal offline states has no server value
      // to apply. The device value governs until an environment reconnects.
      setReconciledKey(nextReconciledKey);
      return;
    }
    const importedThemes = preferencesResult.value.importedThemes ?? [];
    const normalizeThemeId = (themeId: string) => resolveLocalThemeId(themeId, importedThemes);
    const reconciliation = reconcileSyncedClientPreferences({
      local: {
        values: {
          planModeEnabled: preferencesResult.value.planModeEnabled ?? false,
          appearanceMode: preferencesResult.value.appearanceMode ?? DEFAULT_MOBILE_APPEARANCE_MODE,
          themeId: preferencesResult.value.themeId ?? DEFAULT_MOBILE_THEME_ID,
        },
        updatedAtByField: preferencesResult.value.syncedClientPreferencesUpdatedAtByField,
        legacyUpdatedAt: preferencesResult.value.syncedClientPreferencesUpdatedAt,
      },
      environments: liveStates.map(({ environmentId, shell, canPatch }) => ({
        environmentId,
        canPatch,
        preferences:
          shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined,
      })),
      now: new Date().toISOString(),
      normalizeThemeId,
    });
    if (reconciliation.localPatch !== null) {
      const localValues = { ...reconciliation.localPatch.values };
      if (localValues.themeId !== undefined) {
        localValues.themeId = normalizeThemeId(localValues.themeId);
      }
      savePreferences({
        ...localValues,
        syncedClientPreferencesUpdatedAtByField: reconciliation.localPatch.updatedAtByField,
      });
    }
    for (const target of reconciliation.environmentPatches) {
      const field = SYNCED_CLIENT_PREFERENCE_FIELDS.find(
        (candidate) => target.input.patch[candidate] !== undefined,
      );
      if (field === undefined) continue;
      reconciliationControllers[field].reconcile({
        target,
        patch: patchPreferences,
        persist: (patch) =>
          persistReconciledPreferences({
            expectedUpdatedAtByField: { [field]: target.input.updatedAt },
            patch,
          }),
        normalizeThemeId,
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
    reconciliationControllers,
    savePreferences,
    setReconciledKey,
    states,
  ]);
}

function useUpdateSyncedClientPreference(field: SyncedClientPreferenceField) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { connectedEnvironmentIds, states } = useConnectedEnvironmentPreferenceStates();
  const patchPreferences = useAtomCommand(serverEnvironment.patchSyncedClientPreferences, {
    label: "synced client preferences update",
    reportFailure: false,
  });
  const writeController = useMemo(
    () => createSyncedClientPreferenceWriteController(field),
    [field],
  );

  return useCallback(
    (patch: SyncedClientPreferencesPatch) => {
      const current = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
      const write = writeController.create({
        patch,
        connectedEnvironmentIds,
        currentUpdatedAtByField: current.syncedClientPreferencesUpdatedAtByField,
        legacyCurrentUpdatedAt: current.syncedClientPreferencesUpdatedAt,
        authoritativePreferences: states.map(({ shell }) =>
          shell.snapshot._tag === "Some" ? shell.snapshot.value.syncedClientPreferences : undefined,
        ),
        now: new Date().toISOString(),
      });
      savePreferences({
        ...write.localPatch.values,
        syncedClientPreferencesUpdatedAtByField: write.localPatch.updatedAtByField,
      });
      void Promise.allSettled(
        write.environmentPatches.map(async (target) => {
          const result = await patchPreferences(target);
          const importedThemes = current.importedThemes ?? [];
          const localPatch = writeController.settle({
            target,
            result,
            normalizeThemeId: (themeId) =>
              resolveLocalThemeId(themeId, importedThemes, patch.themeId),
          });
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

export function useUpdatePlanModePreference() {
  const updatePreference = useUpdateSyncedClientPreference("planModeEnabled");
  return useCallback(
    (value: boolean) => updatePreference({ planModeEnabled: value }),
    [updatePreference],
  );
}

export function useUpdateAppearanceModePreference() {
  const updatePreference = useUpdateSyncedClientPreference("appearanceMode");
  return useCallback(
    (value: MobileAppearanceMode) => updatePreference({ appearanceMode: value }),
    [updatePreference],
  );
}

export function useUpdateThemePreference() {
  const updatePreference = useUpdateSyncedClientPreference("themeId");
  return useCallback((themeId: string) => updatePreference({ themeId }), [updatePreference]);
}
