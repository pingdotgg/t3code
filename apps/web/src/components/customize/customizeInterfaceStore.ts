import type { ClientSettings, ClientSettingsPatch } from "@t3tools/contracts";
import * as Struct from "effect/Struct";
import type { Mutable } from "effect/Types";
import { create } from "zustand";

import { THEME_PREFERENCE_STORAGE_KEY } from "../../hooks/useTheme";
import {
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
} from "../../themePalette";
import type { PresetId } from "./customizePresets";

/** The theme lives in local storage, outside client settings. */
export const THEME_STORAGE_KEYS = [
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
] as const;
export type ThemeStorageKey = (typeof THEME_STORAGE_KEYS)[number];
export type ThemeStorageSnapshot = Record<ThemeStorageKey, string | null>;

/**
 * The values a change replaced, for only the keys the mode wrote. Restoring a
 * step writes just these, so a font or theme changed elsewhere while the mode
 * is open survives Undo and Revert.
 */
export interface CustomizeStep {
  readonly settings: ClientSettingsPatch;
  readonly theme: Partial<ThemeStorageSnapshot>;
}

const EMPTY_STEP: CustomizeStep = { settings: {}, theme: {} };

export function readThemeStorageSnapshot(): ThemeStorageSnapshot {
  const read = (key: string) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const [preference, appearanceMode, halves, followSystem] = THEME_STORAGE_KEYS;
  return {
    [preference]: read(preference),
    [appearanceMode]: read(appearanceMode),
    [halves]: read(halves),
    [followSystem]: read(followSystem),
  };
}

function setPatchValue<K extends keyof ClientSettingsPatch>(
  patch: Mutable<ClientSettingsPatch>,
  key: K,
  value: ClientSettings[K],
) {
  patch[key] = value;
}

/** The current values `patch` would replace, for the keys it changes. */
export function settingsReplacedBy(
  patch: ClientSettingsPatch,
  current: ClientSettings,
): ClientSettingsPatch {
  const replaced: Mutable<ClientSettingsPatch> = {};
  for (const key of Struct.keys(patch)) {
    if (JSON.stringify(patch[key]) !== JSON.stringify(current[key])) {
      setPatchValue(replaced, key, current[key]);
    }
  }
  return replaced;
}

/** The current theme values `target` would replace, for the keys it changes. */
export function themeReplacedBy(
  target: Partial<ThemeStorageSnapshot>,
  current: ThemeStorageSnapshot,
): Partial<ThemeStorageSnapshot> {
  const replaced: Partial<ThemeStorageSnapshot> = {};
  for (const key of Struct.keys(target)) {
    if (target[key] !== current[key]) replaced[key] = current[key];
  }
  return replaced;
}

export function isEmptyStep(step: CustomizeStep): boolean {
  return Struct.keys(step.settings).length === 0 && Struct.keys(step.theme).length === 0;
}

/** Joins two steps; for a key in both, the older step's value wins. */
function mergeSteps(older: CustomizeStep, newer: CustomizeStep): CustomizeStep {
  return {
    settings: { ...newer.settings, ...older.settings },
    theme: { ...newer.theme, ...older.theme },
  };
}

/**
 * Which composer layout the mode shows. `live` leaves the composer to its
 * usual rules; the other two pin it so its arrangement can be judged
 * without scrolling the conversation.
 */
export type ComposerPreview = "live" | "expanded" | "collapsed";

/** A surface edited in place; the composer covers its toolbar and context bar. */
export type EditSurface = "threadRow" | "chatHeader" | "composer";

/** Repeated edits of one control within this window undo as a single step. */
const COALESCE_MS = 1000;
/** Undo steps kept. Older ones drop off; Revert still reaches past them. */
export const CUSTOMIZE_HISTORY_LIMIT = 100;

type CustomizeInterfaceStore = {
  active: boolean;
  /** Each key's value before the mode first wrote it; Revert returns here. */
  baseline: CustomizeStep;
  /** What each change replaced, newest last; Undo steps back through it. */
  history: CustomizeStep[];
  lastRecord: { key: string; at: number } | null;
  composerPreview: ComposerPreview;
  /** The surface being edited in place, or null while the presets popover shows. */
  editing: EditSurface | null;
  /** A preset under the pointer, temporarily rendered by the live UI. */
  previewPresetId: PresetId | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /**
   * Adds what a change replaced to the history. An empty step is ignored, so
   * a change that changes nothing never leaves a dead Undo.
   */
  record: (step: CustomizeStep, key?: string) => void;
  popHistory: () => CustomizeStep | null;
  setComposerPreview: (preview: ComposerPreview) => void;
  setEditing: (surface: EditSurface | null) => void;
  setPreviewPresetId: (id: PresetId | null) => void;
};

const CLOSED_STATE = {
  active: false,
  baseline: EMPTY_STEP,
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
    set({ ...CLOSED_STATE, history: [], active: true });
  },
  close: () => set({ ...CLOSED_STATE, history: [] }),
  toggle: () => (get().active ? get().close() : get().open()),
  record: (step, key) => {
    if (isEmptyStep(step)) return;
    const now = Date.now();
    const { baseline, history, lastRecord } = get();
    const last = history.at(-1);
    const coalesce =
      key !== undefined &&
      last !== undefined &&
      lastRecord?.key === key &&
      now - lastRecord.at < COALESCE_MS;
    set({
      baseline: mergeSteps(baseline, step),
      history: coalesce
        ? [...history.slice(0, -1), mergeSteps(last, step)]
        : [...history, step].slice(-CUSTOMIZE_HISTORY_LIMIT),
      lastRecord: key === undefined ? null : { key, at: now },
    });
  },
  popHistory: () => {
    const history = get().history;
    const previous = history.at(-1) ?? null;
    if (previous) set({ history: history.slice(0, -1), lastRecord: null });
    return previous;
  },
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
