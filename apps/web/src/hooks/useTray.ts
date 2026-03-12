import { useCallback } from "react";
import { useAppSettings } from "~/appSettings";
import { isElectron } from "~/env";

type TrayState = [boolean, (enabled: boolean) => void];

export function useTray(): TrayState {
  if (!isElectron) return [false, () => {}];
  const bridge = window.desktopBridge;
  if (!bridge) return [false, () => {}];

  const { settings, updateSettings } = useAppSettings();

  const setEnabledOverBridge = useCallback((enabled: boolean) => {
    bridge
      .setTrayEnabled(enabled)
      .then(() => {
        updateSettings({ showTrayIcon: enabled });
      })
      .catch(() => {
        // Do nothing
      });
  }, []);

  return [settings.showTrayIcon, setEnabledOverBridge];
}
