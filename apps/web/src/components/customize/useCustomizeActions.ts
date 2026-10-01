import type { ClientSettingsPatch, InterfaceLayout } from "@t3tools/contracts";
import * as Struct from "effect/Struct";
import { useMemo } from "react";

import {
  clientSettingsPatchesPublishImmediately,
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
  useUpdateClientSettings,
  whenClientSettingsPatchesPublished,
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
// And while an earlier patch waits to publish, a new one defers behind it, so
// the snapshot would not show the mode's last write to the next action. Every
// action therefore waits on one shared chain until a write publishes at once,
// then reads, records and writes in that same turn. Actions from the popover
// and the edit layer still land in the order they were made, and an action
// queued in one session of the mode never runs in a later one.
let pendingActions: Promise<void> = Promise.resolve();
let idleWaiters: Array<() => void> = [];

function afterHydration(run: (settingsLoaded: boolean) => void): void {
  const session = useCustomizeInterfaceStore.getState().session;
  const runInSession = (settingsLoaded: boolean) => {
    if (useCustomizeInterfaceStore.getState().session === session) run(settingsLoaded);
  };
  pendingActions = pendingActions
    .then(async () => {
      while (!clientSettingsPatchesPublishImmediately()) {
        try {
          await ensureClientSettingsHydrated();
        } catch {
          // Hydration logs its own failure, and the next action retries it.
          return runInSession(false);
        }
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
        await whenClientSettingsPatchesPublished();
      }
      runInSession(true);
    })
    .catch((error: unknown) => {
      console.error("[CUSTOMIZE_INTERFACE] action failed", error);
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

/**
 * Resolves once no queued action can run yet: every one has run, or the next
 * is waiting for earlier settings patches to publish. Lets tests act at that
 * point without waiting on timers.
 */
export function customizeActionsIdle(): Promise<void> {
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
    void pendingActions.then(resolve);
  });
}

export function createCustomizeActions(deps: {
  readonly updateSettings: (patch: ClientSettingsPatch) => Promise<void>;
  readonly refreshTheme: () => void;
}) {
  const store = () => useCustomizeInterfaceStore.getState();

  // Writes a step's values back, touching only the keys it holds.
  const restore = (step: CustomizeStep) => {
    if (Struct.keys(step.settings).length > 0) void deps.updateSettings(step.settings);
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
    void deps.updateSettings(patch);
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
