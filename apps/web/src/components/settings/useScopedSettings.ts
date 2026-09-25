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
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

/** Effective settings for the representative target: project overrides applied on top of its environment. */
export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
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

/** Where the keys' effective values come from across the selected targets. */
export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
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
      void persistScopedSettingsPatch(plan, persistServer, persistClientSettingsPatch).then(
        ({ failedEnvironments, savedEnvironmentCount }) => {
          if (failedEnvironments.length === 0) return;
          toastManager.add({
            type: "error",
            title:
              savedEnvironmentCount > 0
                ? "Setting saved on some environments"
                : "Setting not saved",
            description: `Could not update ${failedEnvironments.map((environment) => environment.label).join(", ")}.${savedEnvironmentCount > 0 ? " The other selected environments saved the change." : ""}`,
          });
        },
      );
    },
    [persistServer],
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

/**
 * Drop the project overrides for `keys` so the selected checkouts inherit
 * again. Rows also render outside the settings layout (provider cards,
 * dialogs), where there is no scope and nothing to clear.
 */
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

/** Clear `keys` on specific project entries, from an environment scope's chain popover. */
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
