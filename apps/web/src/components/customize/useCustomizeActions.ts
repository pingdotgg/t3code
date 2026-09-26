import type { ClientSettingsPatch, InterfaceLayout } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  getClientSettings,
  useClientSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  changedCustomizeSettingKeys,
  type CustomizeSnapshot,
  pickCustomizeSettings,
  readThemeStorageSnapshot,
  THEME_STORAGE_KEYS,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";

/**
 * Every change the mode makes goes through these, so each one lands on the
 * undo history first. `key` merges rapid repeats of one control, such as a
 * slider drag, into a single undo step.
 */
export function useCustomizeActions() {
  const updateSettings = useUpdateClientSettings();
  const { refreshTheme } = useTheme();

  const restore = useCallback(
    (snapshot: CustomizeSnapshot) => {
      const changed = changedCustomizeSettingKeys(
        snapshot.settings,
        pickCustomizeSettings(getClientSettings()),
      );
      if (changed.length > 0) {
        void updateSettings(
          Object.fromEntries(changed.map((key) => [key, snapshot.settings[key]])),
        );
      }
      let themeChanged = false;
      for (const key of THEME_STORAGE_KEYS) {
        const value = snapshot.theme[key];
        try {
          if (window.localStorage.getItem(key) === value) continue;
          if (value === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, value);
          themeChanged = true;
        } catch {
          // Storage is unavailable; the theme stays as it is.
        }
      }
      if (themeChanged) refreshTheme();
    },
    [refreshTheme, updateSettings],
  );

  const commit = useCallback(
    (patch: ClientSettingsPatch, key?: string) => {
      useCustomizeInterfaceStore.getState().record(key);
      void updateSettings(patch);
    },
    [updateSettings],
  );

  // Layout edits read the latest settings, not a render's: a quick hide then
  // drag must not rebuild the layout from a stale value.
  const commitLayout = useCallback(
    (edit: (current: InterfaceLayout) => InterfaceLayout) => {
      const current = getClientSettings().interfaceLayout;
      const next = edit(current);
      if (next === current) return;
      useCustomizeInterfaceStore.getState().record();
      void updateSettings({ interfaceLayout: next });
    },
    [updateSettings],
  );

  const withRecord = useCallback((change: () => void, key?: string) => {
    useCustomizeInterfaceStore.getState().record(key);
    change();
  }, []);

  const undo = useCallback(() => {
    const previous = useCustomizeInterfaceStore.getState().popHistory();
    if (previous) restore(previous);
  }, [restore]);

  const revert = useCallback(() => {
    const store = useCustomizeInterfaceStore.getState();
    if (store.snapshot) restore(store.snapshot);
    store.clearHistory();
  }, [restore]);

  return { commit, commitLayout, withRecord, undo, revert };
}

/** Whether anything differs from when the mode opened. */
export function useHasCustomizeChanges(): boolean {
  const snapshot = useCustomizeInterfaceStore((store) => store.snapshot);
  const settings = useClientSettings();
  // Subscribing re-renders on every theme change, so the storage read below
  // is always current.
  useTheme();
  if (!snapshot) return false;
  if (changedCustomizeSettingKeys(snapshot.settings, pickCustomizeSettings(settings)).length > 0) {
    return true;
  }
  const currentTheme = readThemeStorageSnapshot();
  return THEME_STORAGE_KEYS.some((key) => currentTheme[key] !== snapshot.theme[key]);
}
