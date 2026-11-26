// Fork: Kaluwa's look settings (palette mood, status emphasis, badges, tiles, logos, lift) and
// the code that paints them onto <html>. Stored per device in localStorage, like the theme.
import { useSyncExternalStore } from "react";
import type { ThemeAppearance } from "@t3tools/shared/themePalettes";

import { APP_STAGE_LABEL } from "../branding";
import {
  KALUWA_PALETTE_MOODS,
  kaluwaPalette,
  kaluwaPaletteVariables,
  kaluwaPresetForThemeId,
  type KaluwaPalette,
  type KaluwaPaletteMood,
  type KaluwaPreset,
} from "./kaluwaPalette";

/** The local build ("-local" version) is Kaluwa; every other flavour keeps upstream's look. */
export const IS_KALUWA_BUILD = APP_STAGE_LABEL.trim().toLowerCase() === "local";

export const KALUWA_STATUS_EMPHASES = ["soft", "quiet", "all", "off"] as const;
export const KALUWA_STATUS_COLOR_SETS = ["palette", "classic"] as const;
export const KALUWA_BADGE_STYLES = ["tinted", "outline", "mono"] as const;
export const KALUWA_TILE_STYLES = ["tinted", "mono"] as const;
export const KALUWA_LOGO_STYLES = ["soft", "original", "mono"] as const;

export type KaluwaLook = Readonly<{
  mood: KaluwaPaletteMood;
  statusEmphasis: (typeof KALUWA_STATUS_EMPHASES)[number];
  statusColors: (typeof KALUWA_STATUS_COLOR_SETS)[number];
  badges: (typeof KALUWA_BADGE_STYLES)[number];
  tiles: (typeof KALUWA_TILE_STYLES)[number];
  logos: (typeof KALUWA_LOGO_STYLES)[number];
  /** Depth, 0 to 100: top highlights on raised surfaces and an accent tint on selected rows. */
  lift: number;
}>;

export const DEFAULT_KALUWA_LOOK: KaluwaLook = {
  mood: "luminous",
  statusEmphasis: "soft",
  statusColors: "palette",
  badges: "tinted",
  tiles: "tinted",
  logos: "soft",
  lift: 50,
};

const KALUWA_LOOK_STORAGE_KEY = "kaluwa:look:v1";

function pick<T extends string>(options: ReadonlyArray<T>, value: unknown, fallback: T): T {
  return typeof value === "string" && (options as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

/** Reads a stored look, keeping each valid field and defaulting the rest. */
export function parseKaluwaLook(raw: string | null): KaluwaLook {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
    }
  } catch {}
  const lift = typeof value.lift === "number" && Number.isFinite(value.lift) ? value.lift : NaN;
  const d = DEFAULT_KALUWA_LOOK;
  return {
    mood: pick(KALUWA_PALETTE_MOODS, value.mood, d.mood),
    statusEmphasis: pick(KALUWA_STATUS_EMPHASES, value.statusEmphasis, d.statusEmphasis),
    statusColors: pick(KALUWA_STATUS_COLOR_SETS, value.statusColors, d.statusColors),
    badges: pick(KALUWA_BADGE_STYLES, value.badges, d.badges),
    tiles: pick(KALUWA_TILE_STYLES, value.tiles, d.tiles),
    logos: pick(KALUWA_LOGO_STYLES, value.logos, d.logos),
    lift: Number.isNaN(lift) ? d.lift : Math.round(Math.min(100, Math.max(0, lift))),
  };
}

export type KaluwaLookSnapshot = Readonly<{
  look: KaluwaLook;
  preset: KaluwaPreset;
  scheme: ThemeAppearance;
  palette: KaluwaPalette;
}>;

const listeners = new Set<() => void>();
let look: KaluwaLook | null = null;
let snapshot: KaluwaLookSnapshot | null = null;

function readLook(): KaluwaLook {
  if (look !== null) return look;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KALUWA_LOOK_STORAGE_KEY);
  } catch {}
  look = parseKaluwaLook(raw);
  return look;
}

function readSnapshot(): KaluwaLookSnapshot {
  const root = document.documentElement;
  const current = readLook();
  const preset = kaluwaPresetForThemeId(root.dataset.themeId);
  const scheme: ThemeAppearance = root.classList.contains("dark") ? "dark" : "light";
  if (
    snapshot !== null &&
    snapshot.look === current &&
    snapshot.preset === preset &&
    snapshot.scheme === scheme
  ) {
    return snapshot;
  }
  snapshot = {
    look: current,
    preset,
    scheme,
    palette: kaluwaPalette(preset.id, scheme, current.mood),
  };
  return snapshot;
}

/** Paints the look onto <html>: swatches as custom properties, choices as data attributes. */
function paint(): void {
  const root = document.documentElement;
  const { look: current, preset, palette } = readSnapshot();
  for (const [name, value] of kaluwaPaletteVariables(palette)) root.style.setProperty(name, value);
  root.style.setProperty("--kaluwa-lift", String(current.lift / 100));
  root.style.setProperty("--radius", `${preset.radius / 16}rem`);
  root.style.setProperty("--control-radius", `${preset.controlRadius / 16}rem`);
  const data = root.dataset;
  data.kaluwaLook = "";
  data.kaluwaEmphasis = current.statusEmphasis;
  data.kaluwaStatusColors = current.statusColors;
  data.kaluwaBadges = current.badges;
  data.kaluwaTiles = current.tiles;
  data.kaluwaLogos = current.logos;
  data.kaluwaFont = preset.font;
  for (const listener of listeners) listener();
}

let started = false;

/** Starts painting on the Kaluwa build; a no-op elsewhere. Returns a stop function. */
export function startKaluwaLook(): () => void {
  if (!IS_KALUWA_BUILD || started || typeof document === "undefined") return () => {};
  started = true;
  paint();
  // The theme code owns `class` and `data-theme-id`; follow it instead of hooking into it, so
  // previews, theme halves and system changes all repaint the palette.
  const observer = new MutationObserver(paint);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme-id"],
  });
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== KALUWA_LOOK_STORAGE_KEY && event.key !== null) return;
    look = null;
    paint();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", handleStorage);
    started = false;
  };
}

export function setKaluwaLook(patch: Partial<KaluwaLook>): void {
  const next = parseKaluwaLook(JSON.stringify({ ...readLook(), ...patch }));
  look = next;
  try {
    window.localStorage.setItem(KALUWA_LOOK_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Kept for this session only.
  }
  paint();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER_SNAPSHOT: KaluwaLookSnapshot = {
  look: DEFAULT_KALUWA_LOOK,
  preset: kaluwaPresetForThemeId(null),
  scheme: "dark",
  palette: kaluwaPalette("today", "dark", DEFAULT_KALUWA_LOOK.mood),
};

/** The look, and the preset, scheme and palette it is painted with right now. */
export function useKaluwaLook(): KaluwaLookSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => (typeof document === "undefined" ? SERVER_SNAPSHOT : readSnapshot()),
    () => SERVER_SNAPSHOT,
  );
}
