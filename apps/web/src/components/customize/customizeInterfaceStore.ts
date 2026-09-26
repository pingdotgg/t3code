import type { ClientSettings } from "@t3tools/contracts";
import { create } from "zustand";

import { THEME_PREFERENCE_STORAGE_KEY } from "../../hooks/useTheme";
import { getClientSettings } from "../../hooks/useSettings";
import {
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
} from "../../themePalette";

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

export type CustomizeSurface = "threadList" | "composer" | "chatHeader" | "appearance";

type CustomizeInterfaceStore = {
  active: boolean;
  /** What the app looked like when the mode opened; Revert returns here. */
  snapshot: CustomizeSnapshot | null;
  composerPreview: ComposerPreview;
  /** The surface whose palette the pointer or focus is in, for its outline. */
  focusedSurface: CustomizeSurface | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setComposerPreview: (preview: ComposerPreview) => void;
  setFocusedSurface: (surface: CustomizeSurface | null) => void;
};

export const useCustomizeInterfaceStore = create<CustomizeInterfaceStore>((set, get) => ({
  active: false,
  snapshot: null,
  composerPreview: "live",
  focusedSurface: null,
  open: () => {
    if (get().active) return;
    set({
      active: true,
      snapshot: {
        settings: pickCustomizeSettings(getClientSettings()),
        theme: readThemeStorageSnapshot(),
      },
      composerPreview: "live",
      focusedSurface: null,
    });
  },
  close: () =>
    set({ active: false, snapshot: null, composerPreview: "live", focusedSurface: null }),
  toggle: () => (get().active ? get().close() : get().open()),
  setComposerPreview: (composerPreview) => set({ composerPreview }),
  setFocusedSurface: (focusedSurface) => set({ focusedSurface }),
}));

/** The composer preview while the mode is open; `live` otherwise. */
export function useComposerPreview(): ComposerPreview {
  return useCustomizeInterfaceStore((store) => (store.active ? store.composerPreview : "live"));
}
