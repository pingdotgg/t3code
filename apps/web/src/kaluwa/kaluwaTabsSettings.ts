// Fork: settings for Kaluwa's titlebar tabs: on or off, the tab style, radius and height. Stored
// per device in localStorage, like Kaluwa's look. Defaults are the theme lab's Ember values; tabs
// start on for the local build only, so other builds keep upstream's titlebar.
import { useSyncExternalStore, type CSSProperties } from "react";

import { IS_KALUWA_BUILD } from "./kaluwaLook";

export const KALUWA_TAB_STYLES = ["pill", "folder", "line"] as const;
export type KaluwaTabStyle = (typeof KALUWA_TAB_STYLES)[number];

/** Where a thread opened from the sidebar, search or a link goes. */
export const KALUWA_TAB_OPEN_MODES = ["new-tab", "current-tab"] as const;
export type KaluwaTabOpenMode = (typeof KALUWA_TAB_OPEN_MODES)[number];

export const KALUWA_TAB_RADIUS_LIMITS = [0, 16] as const;
export const KALUWA_TAB_HEIGHT_LIMITS = [24, 40] as const;

export type KaluwaTabsSettings = Readonly<{
  enabled: boolean;
  style: KaluwaTabStyle;
  /** Corner radius in px; the strip caps it at half the height. */
  radius: number;
  /** Tab height in px. */
  height: number;
  openIn: KaluwaTabOpenMode;
  /** Put two or more tabs of one project in a group of their own. */
  groupByProject: boolean;
}>;

export const DEFAULT_KALUWA_TABS_SETTINGS: KaluwaTabsSettings = {
  enabled: IS_KALUWA_BUILD,
  style: "pill",
  radius: 8,
  height: 30,
  openIn: "new-tab",
  groupByProject: true,
};

const STORAGE_KEY = "kaluwa:tabs:v1";

function clampInteger(value: unknown, [min, max]: readonly [number, number], fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Reads stored settings, keeping each valid field and defaulting the rest. */
export function parseKaluwaTabsSettings(raw: string | null): KaluwaTabsSettings {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
    }
  } catch {}
  const d = DEFAULT_KALUWA_TABS_SETTINGS;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : d.enabled,
    style: KALUWA_TAB_STYLES.find((style) => style === value.style) ?? d.style,
    radius: clampInteger(value.radius, KALUWA_TAB_RADIUS_LIMITS, d.radius),
    height: clampInteger(value.height, KALUWA_TAB_HEIGHT_LIMITS, d.height),
    openIn: KALUWA_TAB_OPEN_MODES.find((mode) => mode === value.openIn) ?? d.openIn,
    groupByProject:
      typeof value.groupByProject === "boolean" ? value.groupByProject : d.groupByProject,
  };
}

const listeners = new Set<() => void>();
let current: KaluwaTabsSettings | null = null;

export function readKaluwaTabsSettings(): KaluwaTabsSettings {
  if (current !== null) return current;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {}
  current = parseKaluwaTabsSettings(raw);
  return current;
}

export function updateKaluwaTabsSettings(patch: Partial<KaluwaTabsSettings>): void {
  const next = parseKaluwaTabsSettings(JSON.stringify({ ...readKaluwaTabsSettings(), ...patch }));
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

/** Puts the named settings, or all of them, back to their defaults. */
export function resetKaluwaTabsSettings(keys?: ReadonlyArray<keyof KaluwaTabsSettings>): void {
  const d = DEFAULT_KALUWA_TABS_SETTINGS;
  const patch: Partial<Record<keyof KaluwaTabsSettings, unknown>> = {};
  for (const key of keys ?? (Object.keys(d) as Array<keyof KaluwaTabsSettings>))
    patch[key] = d[key];
  updateKaluwaTabsSettings(patch as Partial<KaluwaTabsSettings>);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKaluwaTabsSettings(): KaluwaTabsSettings {
  return useSyncExternalStore(
    subscribe,
    readKaluwaTabsSettings,
    () => DEFAULT_KALUWA_TABS_SETTINGS,
  );
}

/** The CSS variables the tab strip (and any preview of it) is drawn with. */
export function kaluwaTabsStyleVariables(settings: KaluwaTabsSettings): CSSProperties {
  return {
    "--kaluwa-tab-radius": `${Math.min(settings.radius, settings.height / 2)}px`,
    "--kaluwa-tab-height": `${settings.height}px`,
  } as CSSProperties;
}
