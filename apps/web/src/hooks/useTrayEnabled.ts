import { useCallback } from "react";
import { useAppSettings } from "~/appSettings";
import { isElectron } from "~/env";

type TrayEnabledState = [boolean, (enabled: boolean) => void];

export function useTrayEnabled(): TrayEnabledState {
  if (!isElectron) return [false, () => {}];
  const bridge = window.desktopBridge;
  if (!bridge) return [false, () => {}];

  const { settings, updateSettings } = useAppSettings();

  const setEnabledOverBridge = useCallback(
    (enabled: boolean) => {
      bridge
        .setTrayEnabled(enabled)
        .then(() => {
          updateSettings({ showTrayIcon: enabled });
        })
        .catch(() => {
          // Do nothing
        });
    },
    [bridge, updateSettings],
  );

  return [settings.showTrayIcon, setEnabledOverBridge];
}
