import type { ClientSettings, ClientSettingsPatch, InterfaceLayout } from "@t3tools/contracts";
import * as Struct from "effect/Struct";
import type { Mutable } from "effect/Types";
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
// popover and the edit layer still land in the order they were made. An
// action queued in one session of the mode never runs in a later one.
let pendingActions: Promise<void> = Promise.resolve();

function afterHydration(run: (settingsLoaded: boolean) => void): void {
  const session = useCustomizeInterfaceStore.getState().session;
  pendingActions = pendingActions
    .then(ensureClientSettingsHydrated)
    // Hydration logs its own failure, and the next action retries it.
    .then(
      () => true,
      () => false,
    )
    .then((settingsLoaded) => {
      if (useCustomizeInterfaceStore.getState().session === session) run(settingsLoaded);
    })
    .catch((error: unknown) => {
      console.error("[CUSTOMIZE_INTERFACE] action failed", error);
    });
}

// A write can sit deferred behind an earlier one that is still persisting, so
// the snapshot may not show it yet. Reads overlay the mode's own unpublished
// writes, so the next action builds on them rather than on a stale value.
// Each key is owned by the write that set it and leaves the overlay when that
// write settles, or at once if the write published synchronously.
const unpublished: Mutable<ClientSettingsPatch> = {};
const unpublishedOwners = new Map<keyof ClientSettingsPatch, object>();

function currentSettings(): ClientSettings {
  return { ...getClientSettings(), ...unpublished };
}

function copyPatchValue<K extends keyof ClientSettingsPatch>(
  to: Mutable<ClientSettingsPatch>,
  from: ClientSettingsPatch,
  key: K,
) {
  const value = from[key];
  if (value !== undefined) to[key] = value;
}

function trackWrite(patch: ClientSettingsPatch, written: Promise<void>): void {
  const owner = {};
  const published = getClientSettings();
  for (const key of Struct.keys(patch)) {
    if (JSON.stringify(patch[key]) === JSON.stringify(published[key])) {
      delete unpublished[key];
      unpublishedOwners.delete(key);
    } else {
      copyPatchValue(unpublished, patch, key);
      unpublishedOwners.set(key, owner);
    }
  }
  void written.finally(() => {
    for (const key of Struct.keys(patch)) {
      if (unpublishedOwners.get(key) !== owner) continue;
      delete unpublished[key];
      unpublishedOwners.delete(key);
    }
  });
}

function settingsNotLoaded(): void {
  console.error("[CLIENT_SETTINGS] customize change dropped", {
    operation: "customize",
    reason: "client settings did not load",
  });
}

/** Resolves once every queued Customize interface action has run. */
export function customizeActionsSettled(): Promise<void> {
  return pendingActions;
}

export function createCustomizeActions(deps: {
  readonly updateSettings: (patch: ClientSettingsPatch) => Promise<void>;
  readonly refreshTheme: () => void;
}) {
  const store = () => useCustomizeInterfaceStore.getState();

  const write = (patch: ClientSettingsPatch) => trackWrite(patch, deps.updateSettings(patch));

  // Writes a step's values back, touching only the keys it holds.
  const restore = (step: CustomizeStep) => {
    if (Struct.keys(step.settings).length > 0) write(step.settings);
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
    const replaced = settingsReplacedBy(patch, currentSettings());
    if (Struct.keys(replaced).length === 0) return;
    store().record({ settings: replaced, theme: {} }, key);
    write(patch);
  };

  return {
    commit: (patch: ClientSettingsPatch, key?: string) =>
      afterHydration((settingsLoaded) =>
        settingsLoaded ? applySettings(patch, key) : settingsNotLoaded(),
      ),

    // Layout edits read the latest settings, not a render's: a quick hide
    // then drag must not rebuild the layout from a stale value. Dropped, like
    // `commit`, if client settings fail to load: there is no saved value to
    // record for Undo.
    commitLayout: (edit: (current: InterfaceLayout) => InterfaceLayout) =>
      afterHydration((settingsLoaded) => {
        if (!settingsLoaded) return settingsNotLoaded();
        const current = currentSettings().interfaceLayout;
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
          settings: settingsReplacedBy(baseline.settings, currentSettings()),
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
