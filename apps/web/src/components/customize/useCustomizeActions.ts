import type { ClientSettingsPatch, InterfaceLayout } from "@t3tools/contracts";
import * as Struct from "effect/Struct";
import { useMemo } from "react";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  type CustomizeStep,
  isEmptyStep,
  readThemeStorageSnapshot,
  settingsReplacedBy,
  themeReplacedBy,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";

// Before client settings hydrate, the live snapshot is only the defaults:
// recording against it would make Undo restore defaults over saved values.
// Every action waits for hydration on one shared chain, so actions from the
// popover and the edit layer still land in the order they were made.
let pendingActions: Promise<void> = Promise.resolve();

function afterHydration(run: () => void): void {
  pendingActions = pendingActions
    .then(ensureClientSettingsHydrated)
    // Hydration logs its own failure; settings writes then defer as usual.
    .catch(() => undefined)
    .then(run)
    .catch((error: unknown) => {
      console.error("[CUSTOMIZE_INTERFACE] action failed", error);
    });
}

/** Resolves once every queued Customize interface action has run. */
export function customizeActionsSettled(): Promise<void> {
  return pendingActions;
}

export function createCustomizeActions(deps: {
  readonly updateSettings: (patch: ClientSettingsPatch) => unknown;
  readonly refreshTheme: () => void;
}) {
  const store = () => useCustomizeInterfaceStore.getState();

  // Writes a step's values back, touching only the keys it holds.
  const restore = (step: CustomizeStep) => {
    if (Struct.keys(step.settings).length > 0) deps.updateSettings(step.settings);
    let themeChanged = false;
    for (const key of Struct.keys(step.theme)) {
      const value = step.theme[key] ?? null;
      try {
        if (window.localStorage.getItem(key) === value) continue;
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
        themeChanged = true;
      } catch {
        // Storage is unavailable; the theme stays as it is.
      }
    }
    if (themeChanged) deps.refreshTheme();
  };

  const applySettings = (patch: ClientSettingsPatch, key?: string) => {
    const replaced = settingsReplacedBy(patch, getClientSettings());
    if (Struct.keys(replaced).length === 0) return;
    store().record({ settings: replaced, theme: {} }, key);
    deps.updateSettings(patch);
  };

  return {
    commit: (patch: ClientSettingsPatch, key?: string) =>
      afterHydration(() => applySettings(patch, key)),

    // Layout edits read the latest settings, not a render's: a quick hide
    // then drag must not rebuild the layout from a stale value.
    commitLayout: (edit: (current: InterfaceLayout) => InterfaceLayout) =>
      afterHydration(() => {
        const current = getClientSettings().interfaceLayout;
        const next = edit(current);
        if (next !== current) applySettings({ interfaceLayout: next });
      }),

    /** Runs a theme change, recording the theme storage keys it changed. */
    withRecord: (change: () => void, key?: string) =>
      afterHydration(() => {
        const before = readThemeStorageSnapshot();
        change();
        store().record(
          { settings: {}, theme: themeReplacedBy(readThemeStorageSnapshot(), before) },
          key,
        );
      }),

    undo: () => {
      store().setPreviewPresetId(null);
      afterHydration(() => {
        const previous = store().popHistory();
        if (previous) restore(previous);
      });
    },

    /** Returns every key the mode wrote to its first value, as one undoable step. */
    revert: () => {
      store().setPreviewPresetId(null);
      afterHydration(() => {
        const { baseline } = store();
        const step: CustomizeStep = {
          settings: settingsReplacedBy(baseline.settings, getClientSettings()),
          theme: themeReplacedBy(baseline.theme, readThemeStorageSnapshot()),
        };
        if (isEmptyStep(step)) return;
        store().record(step);
        restore(baseline);
      });
    },
  };
}

/**
 * Every change the mode makes goes through these, so each one lands on the
 * undo history first. `key` merges rapid repeats of one control, such as a
 * slider drag, into a single undo step. Settings writes stay fire-and-forget:
 * persistence failures are logged where they are persisted.
 */
export function useCustomizeActions() {
  const updateSettings = useUpdateClientSettings();
  const { refreshTheme } = useTheme();
  return useMemo(
    () => createCustomizeActions({ updateSettings, refreshTheme: () => refreshTheme() }),
    [refreshTheme, updateSettings],
  );
}

/** Whether any key the mode wrote differs from its value before the mode wrote it. */
export function useHasCustomizeChanges(): boolean {
  const baseline = useCustomizeInterfaceStore((store) => store.baseline);
  const settings = useClientSettings();
  // Subscribing re-renders on every theme change, so the storage read below
  // is always current.
  useTheme();
  return !isEmptyStep({
    settings: settingsReplacedBy(baseline.settings, settings),
    theme: themeReplacedBy(baseline.theme, readThemeStorageSnapshot()),
  });
}
