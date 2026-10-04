import { useState } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function StartAtLoginSetting() {
  const getOpenAtLogin = window.desktopBridge?.getOpenAtLogin;
  const setOpenAtLogin = window.desktopBridge?.setOpenAtLogin;
  const supported =
    window.desktopBridge?.getClientPlatform?.() === "darwin" &&
    getOpenAtLogin !== undefined &&
    setOpenAtLogin !== undefined;
  const [enabled, setEnabled] = useState(() =>
    supported && getOpenAtLogin ? getOpenAtLogin() : false,
  );
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported || !setOpenAtLogin) return null;

  const applyChange = async (next: boolean) => {
    setIsUpdating(true);
    setError(null);
    try {
      await setOpenAtLogin(next);
      setEnabled(getOpenAtLogin());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't update start at login.");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("start-at-login")}
      description={
        error ??
        (enabled
          ? "Opens when you log in to this Mac, with no window. Use the menu bar icon to show T3 Code. The local server keeps running."
          : "Off. T3 Code only opens when you launch it.")
      }
      control={
        <Switch
          checked={enabled}
          disabled={isUpdating}
          onCheckedChange={(checked) => void applyChange(checked === true)}
          aria-label="Start at login"
        />
      }
    />
  );
}
