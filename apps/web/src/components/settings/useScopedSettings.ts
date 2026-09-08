import {
  DEFAULT_SERVER_SETTINGS,
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
import { useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { environment } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = environment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { connectedEnvironments } = useSettingsScope();
  return scopedSettingsAreMixed(connectedEnvironments, keys);
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return useCallback(
    (patch: ScopedSettingsPatch) => {
      const plan = planScopedSettingsPatch(scope, environments, patch);
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
    [environments, persistServer, scope],
  );
}
