import type { ClientSettings } from "@t3tools/contracts";
import { create } from "zustand";

import { THEME_PREFERENCE_STORAGE_KEY } from "../../hooks/useTheme";
import { getClientSettings } from "../../hooks/useSettings";
import {
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
} from "../../themePalette";
import type { PresetId } from "./customizePresets";

/**
 * Every client setting a Customize interface palette can change. Revert
 * restores exactly these, so a model picked in the composer or anything else
 * written while the mode is open is left alone.
 */
const CUSTOMIZE_SETTING_KEYS = [
  "interfaceLayout",
  "composerCollapseOnScroll",
  "contextWindowMeterEnabled",
  "timestampFormat",
  "chatWidth",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "fontSizeTerminal",
  "fontFamilySans",
  "fontFamilyCode",
  "fontFamilyComposer",
  "fontFamilyTerminal",
  "fontSmoothing",
  "wordWrap",
  "appearanceContrast",
  "glassOpacity",
  "themeBackground",
  "themeBackgroundTransparency",
  "panelAnimationDurationMs",
  "diffColorScheme",
  "environmentIdentificationMode",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

export type CustomizeSettingKey = (typeof CUSTOMIZE_SETTING_KEYS)[number];
export type CustomizeSettingsSnapshot = Pick<ClientSettings, CustomizeSettingKey>;

/** The theme lives in local storage, outside client settings. */
export const THEME_STORAGE_KEYS = [
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
] as const;
export type ThemeStorageSnapshot = Record<(typeof THEME_STORAGE_KEYS)[number], string | null>;

export interface CustomizeSnapshot {
  readonly settings: CustomizeSettingsSnapshot;
  readonly theme: ThemeStorageSnapshot;
}

export function pickCustomizeSettings(settings: ClientSettings): CustomizeSettingsSnapshot {
  return Object.fromEntries(
    CUSTOMIZE_SETTING_KEYS.map((key) => [key, settings[key]]),
  ) as CustomizeSettingsSnapshot;
}

export function readThemeStorageSnapshot(): ThemeStorageSnapshot {
  const read = (key: string) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  return Object.fromEntries(
    THEME_STORAGE_KEYS.map((key) => [key, read(key)]),
  ) as ThemeStorageSnapshot;
}

/** Keys whose value differs from the snapshot, compared structurally. */
export function changedCustomizeSettingKeys(
  snapshot: CustomizeSettingsSnapshot,
  current: CustomizeSettingsSnapshot,
): CustomizeSettingKey[] {
  return CUSTOMIZE_SETTING_KEYS.filter(
    (key) => JSON.stringify(snapshot[key]) !== JSON.stringify(current[key]),
  );
}

/**
 * Which composer layout the mode shows. `live` leaves the composer to its
 * usual rules; the other two pin it so its arrangement can be judged
 * without scrolling the conversation.
 */
export type ComposerPreview = "live" | "expanded" | "collapsed";

/** A surface edited in place; the composer covers its toolbar and context bar. */
export type EditSurface = "threadRow" | "chatHeader" | "composer";

function captureCustomizeSnapshot(): CustomizeSnapshot {
  return {
    settings: pickCustomizeSettings(getClientSettings()),
    theme: readThemeStorageSnapshot(),
  };
}

/** Repeated edits of one control within this window undo as a single step. */
const COALESCE_MS = 1000;

type CustomizeInterfaceStore = {
  active: boolean;
  /** What the app looked like when the mode opened; Revert returns here. */
  snapshot: CustomizeSnapshot | null;
  /** The state before each change, newest last; Undo steps back through it. */
  history: CustomizeSnapshot[];
  lastRecord: { key: string; at: number } | null;
  composerPreview: ComposerPreview;
  /** The surface being edited in place, or null while the presets popover shows. */
  editing: EditSurface | null;
  /** A preset under the pointer, temporarily rendered by the live UI. */
  previewPresetId: PresetId | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Call before a change so Undo can return to the state it replaces. */
  record: (key?: string) => void;
  popHistory: () => CustomizeSnapshot | null;
  clearHistory: () => void;
  setComposerPreview: (preview: ComposerPreview) => void;
  setEditing: (surface: EditSurface | null) => void;
  setPreviewPresetId: (id: PresetId | null) => void;
};

const CLOSED_STATE = {
  active: false,
  snapshot: null,
  history: [],
  lastRecord: null,
  composerPreview: "live",
  editing: null,
  previewPresetId: null,
} as const;

export const useCustomizeInterfaceStore = create<CustomizeInterfaceStore>((set, get) => ({
  ...CLOSED_STATE,
  history: [],
  open: () => {
    if (get().active) return;
    set({ ...CLOSED_STATE, history: [], active: true, snapshot: captureCustomizeSnapshot() });
  },
  close: () => set({ ...CLOSED_STATE, history: [] }),
  toggle: () => (get().active ? get().close() : get().open()),
  record: (key) => {
    const now = Date.now();
    const last = get().lastRecord;
    if (key && last?.key === key && now - last.at < COALESCE_MS) {
      set({ lastRecord: { key, at: now } });
      return;
    }
    set({
      history: [...get().history, captureCustomizeSnapshot()],
      lastRecord: key ? { key, at: now } : null,
    });
  },
  popHistory: () => {
    const history = get().history;
    const previous = history.at(-1) ?? null;
    if (previous) set({ history: history.slice(0, -1), lastRecord: null });
    return previous;
  },
  clearHistory: () => set({ history: [], lastRecord: null }),
  setComposerPreview: (composerPreview) => set({ composerPreview }),
  setEditing: (editing) =>
    set({
      editing,
      previewPresetId: null,
      ...(editing === "composer" ? {} : { composerPreview: "live" }),
    }),
  setPreviewPresetId: (previewPresetId) => set({ previewPresetId }),
}));

/** The composer preview while the mode is open; `live` otherwise. */
export function useComposerPreview(): ComposerPreview {
  return useCustomizeInterfaceStore((store) => (store.active ? store.composerPreview : "live"));
}
