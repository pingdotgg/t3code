import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useMigrateModelPreferences,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { recordDroppedSettingKeys } from "./droppedSettingKeys";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  scopedDisplaySettings,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target, targets } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = useMemo(
    () => (target ? scopedDisplaySettings(target, targets) : DEFAULT_SERVER_SETTINGS),
    [target, targets],
  );
  useMigrateModelPreferences(target?.environmentId ?? null, target?.settings ?? null);
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const environments = useOptionalSettingsScope()?.environments;
  return useCallback(
    (plan: ReturnType<typeof planScopedSettingsPatch>) => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return;
      }
      void persistScopedSettingsPatch(
        plan,
        async (request) => {
          const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
            (scope) => !readEnvironmentScope(request.environmentId, scope),
          );
          if (missing)
            return AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            );
          return persistServer(request);
        },
        persistClientSettingsPatch,
      ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
        if (failedEnvironments.length === 0) return;
        for (const { environmentId, droppedKeys } of failedEnvironments) {
          const serverVersion = environments?.find(
            (environment) => environment.environmentId === environmentId,
          )?.serverConfig?.environment.serverVersion;
          if (serverVersion) recordDroppedSettingKeys(environmentId, serverVersion, droppedKeys);
        }
        toastManager.add({
          type: "error",
          title:
            savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
          description: [
            ...failedEnvironments.map(
              ({ label, message }) => `Could not save on ${label}: ${message}`,
            ),
            ...(savedEnvironmentCount > 0
              ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
              : []),
          ].join("\n"),
        });
      });
    },
    [environments, persistServer],
  );
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (patch: ScopedSettingsPatch) => run(planScopedSettingsPatch(scope, environments, patch)),
    [environments, run, scope],
  );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planScopedSettingsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (entries: readonly ProjectOverrideEntry[], keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planProjectOverridesClear(context.environments, entries, keys));
    },
    [context, run],
  );
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
