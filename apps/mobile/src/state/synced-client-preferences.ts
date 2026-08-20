import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  getSyncedClientPreferenceUpdatedAt,
  SYNCED_CLIENT_PREFERENCE_FIELDS,
  type EnvironmentId,
  type SyncedClientPreferenceField,
  type SyncedClientPreferences,
  type SyncedClientPreferencesPatch,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  DEFAULT_MOBILE_THEME_ID,
  isMobileThemeId,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeMode,
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

function resolveLocalThemeId(
  themeId: string,
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
  writtenThemeId?: string,
) {
  return themeId === writtenThemeId || isMobileThemeId(themeId, importedThemes)
    ? themeId
    : DEFAULT_MOBILE_THEME_ID;
}

function toLocalPreferencesPatch(patch: Partial<SyncedClientPreferencesPatch>) {
  const { appearanceMode, ...preferences } = patch;
  return appearanceMode === undefined ? preferences : { ...preferences, themeMode: appearanceMode };
}

function normalizeLocalThemePatch(
  patch: Partial<SyncedClientPreferencesPatch>,
  importedThemes: ReadonlyArray<ImportedMobileTheme>,
  writtenThemeId?: string,
) {
  return {
    ...patch,
    ...(patch.lightThemeId === undefined
      ? undefined
      : {
          lightThemeId: resolveLocalThemeId(patch.lightThemeId, importedThemes, writtenThemeId),
        }),
    ...(patch.darkThemeId === undefined
      ? undefined
      : {
          darkThemeId: resolveLocalThemeId(patch.darkThemeId, importedThemes, writtenThemeId),
        }),
  };
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
      lightThemeId: createSyncedClientPreferenceReconciliationController("lightThemeId"),
      darkThemeId: createSyncedClientPreferenceReconciliationController("darkThemeId"),
    }),
    [],
  );
  const attemptedLocalPatchKeyRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      for (const controller of Object.values(reconciliationControllers)) controller.reset();
    },
    [reconciliationControllers],
  );

  useEffect(() => {
    const liveStates = states.filter(
      ({ connectionState, shellStatus }) =>
        connectionState === "connected" && shellStatus === "live",
    );
    const activeEnvironmentIds = liveStates
      .filter(({ canPatch }) => canPatch)
      .map(({ environmentId }) => environmentId);
    for (const controller of Object.values(reconciliationControllers)) {
      controller.setActiveEnvironmentIds(activeEnvironmentIds);
    }
    for (const { environmentId, preferences } of liveStates) {
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
    const importedThemes = preferencesResult.value.importedThemes ?? [];
    const themeIds = resolveMobileThemeIds(preferencesResult.value, importedThemes);
    const reconciliation = reconcileSyncedClientPreferences({
      local: {
        values: {
          planModeEnabled: preferencesResult.value.planModeEnabled ?? false,
          appearanceMode: normalizeMobileThemeMode(preferencesResult.value.themeMode),
          lightThemeId: themeIds.light,
          darkThemeId: themeIds.dark,
        },
        updatedAtByField: preferencesResult.value.syncedClientPreferencesUpdatedAtByField,
        legacyUpdatedAt: preferencesResult.value.syncedClientPreferencesUpdatedAt,
      },
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
    const localPatchKey =
      reconciliation.localPatch === null ? null : JSON.stringify(reconciliation.localPatch);
    if (reconciliation.localPatch !== null && localPatchKey !== attemptedLocalPatchKeyRef.current) {
      attemptedLocalPatchKeyRef.current = localPatchKey;
      savePreferences({
        ...toLocalPreferencesPatch(
          normalizeLocalThemePatch(reconciliation.localPatch.values, importedThemes),
        ),
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
            patch: toLocalPreferencesPatch(normalizeLocalThemePatch(patch, importedThemes)),
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
        authoritativePreferences: states.map(({ preferences }) => preferences),
        now: new Date().toISOString(),
      });
      savePreferences({
        ...toLocalPreferencesPatch(write.localPatch.values),
        syncedClientPreferencesUpdatedAtByField: write.localPatch.updatedAtByField,
      });
      void Promise.allSettled(
        write.environmentPatches.map(async (target) => {
          const result = await patchPreferences(target);
          const localPatch = writeController.settle({ target, result });
          if (localPatch !== null) {
            const writtenThemeId = patch.lightThemeId ?? patch.darkThemeId;
            savePreferences(
              toLocalPreferencesPatch(
                normalizeLocalThemePatch(localPatch, current.importedThemes ?? [], writtenThemeId),
              ),
            );
          }
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
    (value: MobileThemeMode) => updatePreference({ appearanceMode: value }),
    [updatePreference],
  );
}

export function useUpdateThemeIdPreference() {
  const updateLightTheme = useUpdateSyncedClientPreference("lightThemeId");
  const updateDarkTheme = useUpdateSyncedClientPreference("darkThemeId");
  return useCallback(
    (appearance: MobileThemeAppearance, themeId: string) => {
      if (appearance === "light") updateLightTheme({ lightThemeId: themeId });
      else updateDarkTheme({ darkThemeId: themeId });
    },
    [updateDarkTheme, updateLightTheme],
  );
}
