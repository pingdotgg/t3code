import { useCallback, useEffect, useSyncExternalStore } from "react";
import { DEFAULT_THEME_PALETTE, isThemePalette, type ThemePalette } from "../themePalettes";

type Theme = "light" | "dark" | "system";
type ThemeSnapshot = {
  palette: ThemePalette;
  theme: Theme;
  systemDark: boolean;
};

const STORAGE_KEY = "t3code:theme";
const PALETTE_STORAGE_KEY = "t3code:theme-palette";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  palette: DEFAULT_THEME_PALETTE,
  theme: "system",
  systemDark: false,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark() {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function getStored(): Theme {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.theme;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return DEFAULT_THEME_SNAPSHOT.theme;
}

function getStoredPalette(): ThemePalette {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.palette;
  const raw = localStorage.getItem(PALETTE_STORAGE_KEY);
  return isThemePalette(raw) ? raw : DEFAULT_THEME_SNAPSHOT.palette;
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

function applyTheme(theme: Theme, palette: ThemePalette, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const isDark = theme === "dark" || (theme === "system" && getSystemDark());
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.dataset.themePalette = palette;
  syncBrowserChromeTheme();
  syncDesktopTheme(theme);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && hasThemeStorage()) {
  applyTheme(getStored(), getStoredPalette());
}

function getSnapshot(): ThemeSnapshot {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const palette = getStoredPalette();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.palette === palette &&
    lastSnapshot.systemDark === systemDark
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { palette, theme, systemDark };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", getStoredPalette(), true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === PALETTE_STORAGE_KEY) {
      applyTheme(getStored(), getStoredPalette(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const palette = snapshot.palette;
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (snapshot.systemDark ? "dark" : "light") : theme;

  const setTheme = useCallback((next: Theme) => {
    if (!hasThemeStorage()) return;
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next, getStoredPalette(), true);
    emitChange();
  }, []);

  const setPalette = useCallback(
    (next: ThemePalette) => {
      if (!hasThemeStorage()) return;
      localStorage.setItem(PALETTE_STORAGE_KEY, next);
      applyTheme(theme, next, true);
      emitChange();
    },
    [theme],
  );

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme, palette);
  }, [palette, theme]);

  return { palette, resolvedTheme, setPalette, setTheme, theme } as const;
}
