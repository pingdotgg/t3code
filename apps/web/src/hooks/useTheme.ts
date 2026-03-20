import { useSyncExternalStore } from "react";
import type { ThemePaletteDefinition } from "@t3tools/contracts";
import {
  DEFAULT_THEME_PALETTE_ID,
  getThemePaletteCatalog,
  type ThemePalette,
  type ThemePreference,
} from "../lib/themePalettes";

type ThemeSnapshot = {
  readonly theme: ThemePreference;
  readonly systemDark: boolean;
  readonly requestedPaletteId: string;
  readonly paletteId: string;
  readonly palette: ThemePalette;
  readonly palettes: readonly ThemePalette[];
  readonly resolvedTheme: "light" | "dark";
};

const THEME_STORAGE_KEY = "t3code:theme";
const PALETTE_STORAGE_KEY = "t3code:theme-palette";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners = new Set<() => void>();
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: ThemePreference | null = null;
let customThemes: readonly ThemePaletteDefinition[] = [];
let customThemesSerialized = "[]";
let customThemesRevision = 0;
let cachedPalettes: { revision: number; palettes: readonly ThemePalette[] } | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark() {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MEDIA_QUERY).matches;
}

function getStoredTheme(): ThemePreference {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return "system";
}

function getStoredPaletteId() {
  const raw = localStorage.getItem(PALETTE_STORAGE_KEY)?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_THEME_PALETTE_ID;
}

function getPaletteCatalog() {
  if (cachedPalettes && cachedPalettes.revision === customThemesRevision) {
    return cachedPalettes.palettes;
  }

  const palettes = getThemePaletteCatalog(customThemes);
  cachedPalettes = {
    revision: customThemesRevision,
    palettes,
  };
  return palettes;
}

function resolvePalette(paletteId: string) {
  const palettes = getPaletteCatalog();
  const fallbackPalette =
    palettes.find((candidate) => candidate.id === DEFAULT_THEME_PALETTE_ID) ?? palettes[0];
  if (!fallbackPalette) {
    throw new Error("No theme palettes are registered.");
  }

  return {
    palettes,
    palette: palettes.find((candidate) => candidate.id === paletteId) ?? fallbackPalette,
  };
}

function syncDesktopTheme(theme: ThemePreference) {
  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

function applyThemeSnapshot(snapshot: ThemeSnapshot, suppressTransitions = false) {
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  document.documentElement.classList.toggle("dark", snapshot.resolvedTheme === "dark");
  document.documentElement.dataset.themePalette = snapshot.paletteId;
  document.documentElement.dataset.themeMode = snapshot.resolvedTheme;

  const paletteTokens =
    snapshot.resolvedTheme === "dark" ? snapshot.palette.dark : snapshot.palette.light;
  for (const [token, value] of Object.entries(paletteTokens)) {
    document.documentElement.style.setProperty(`--${token}`, value);
  }

  syncDesktopTheme(snapshot.theme);

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal.
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

function getSnapshot(): ThemeSnapshot {
  const theme = getStoredTheme();
  const systemDark = theme === "system" ? getSystemDark() : false;
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const requestedPaletteId = getStoredPaletteId();
  const { palette, palettes } = resolvePalette(requestedPaletteId);

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.requestedPaletteId === requestedPaletteId &&
    lastSnapshot.paletteId === palette.id &&
    lastSnapshot.palettes === palettes
  ) {
    return lastSnapshot;
  }

  lastSnapshot = {
    theme,
    systemDark,
    requestedPaletteId,
    paletteId: palette.id,
    palette,
    palettes,
    resolvedTheme,
  };
  return lastSnapshot;
}

function updateSnapshot(suppressTransitions = false) {
  const snapshot = getSnapshot();
  applyThemeSnapshot(snapshot, suppressTransitions);
  emitChange();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  const handleChange = () => {
    if (getStoredTheme() === "system") {
      updateSnapshot(true);
    }
  };
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
  mq?.addEventListener("change", handleChange);

  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === PALETTE_STORAGE_KEY) {
      updateSnapshot(true);
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners.delete(listener);
    mq?.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function setCustomThemes(nextThemes: readonly ThemePaletteDefinition[]) {
  const nextSerialized = JSON.stringify(nextThemes);
  if (nextSerialized === customThemesSerialized) {
    return;
  }

  customThemes = nextThemes;
  customThemesSerialized = nextSerialized;
  customThemesRevision += 1;
  cachedPalettes = null;
  updateSnapshot(true);
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return {
    theme: snapshot.theme,
    resolvedTheme: snapshot.resolvedTheme,
    palette: snapshot.palette,
    paletteId: snapshot.paletteId,
    palettes: snapshot.palettes,
    setTheme(next: ThemePreference) {
      localStorage.setItem(THEME_STORAGE_KEY, next);
      updateSnapshot(true);
    },
    setPaletteId(nextPaletteId: string) {
      localStorage.setItem(PALETTE_STORAGE_KEY, nextPaletteId);
      updateSnapshot(true);
    },
  } as const;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  applyThemeSnapshot(getSnapshot());
}
