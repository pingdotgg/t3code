import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type ColorMode,
  type ThemeDocument,
} from "@t3tools/contracts";
import { deriveAppearanceCssVariables, resolveAppearanceTheme } from "@t3tools/shared/appearance";
import {
  getClientSettings,
  useClientSettingsHydrated,
  useSettings,
  useUpdateSettings,
} from "./useSettings";

type Theme = ColorMode;
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
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

function setStored(theme: Theme) {
  if (!hasThemeStorage()) return;
  localStorage.setItem(STORAGE_KEY, theme);
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

function applyAppearanceVariables(appearance: AppearanceSettings) {
  if (typeof document === "undefined") return;
  if (typeof document.documentElement.style?.setProperty !== "function") return;
  const theme = resolveAppearanceTheme(appearance);
  const variables = deriveAppearanceCssVariables(theme);
  for (const [name, value] of Object.entries(variables)) {
    document.documentElement.style.setProperty(name, value);
  }
}

function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (getSystemDark() ? "dark" : "light") : theme;
}

function applyTheme(
  theme: Theme,
  suppressTransitions = false,
  appearance: AppearanceSettings = DEFAULT_APPEARANCE_SETTINGS,
) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const resolvedTheme = resolveTheme(theme);
  const isDark = resolveAppearanceTheme(appearance).mode === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  applyAppearanceVariables(appearance);
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
  applyTheme(getStored(), false, DEFAULT_APPEARANCE_SETTINGS);
}

function getSnapshot(): ThemeSnapshot {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
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
    if (getStored() === "system") applyTheme("system", true, getClientSettings().appearance);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(getStored(), true, getClientSettings().appearance);
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
  const appearance = useSettings((settings) => settings.appearance);
  const hydrated = useClientSettingsHydrated();
  const { updateSettings } = useUpdateSettings();
  const theme = snapshot.theme;
  const migrationAttemptedRef = useRef(false);

  const setTheme = useCallback(
    (next: Theme) => {
      if (!hasThemeStorage()) return;
      setStored(next);
      const nextAppearance = {
        ...getClientSettings().appearance,
        colorMode: next,
      };
      updateSettings({ appearance: nextAppearance });
      applyTheme(next, true, nextAppearance);
      emitChange();
    },
    [updateSettings],
  );

  // One-time migration: sync legacy localStorage theme to settings.
  // This runs once per session when settings hydrate. After migration,
  // settings.appearance.colorMode becomes the source of truth.
  useEffect(() => {
    if (!hydrated || migrationAttemptedRef.current) return;
    migrationAttemptedRef.current = true;

    const legacyTheme = getStored();
    const settingsColorMode = appearance.colorMode;

    // If settings already have a non-system colorMode, they're authoritative.
    // Only migrate if settings are at default ("system") but localStorage differs.
    if (settingsColorMode === "system" && legacyTheme !== "system") {
      updateSettings({
        appearance: {
          ...appearance,
          colorMode: legacyTheme,
        },
      });
    }
  }, [appearance, hydrated, updateSettings]);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    const canonicalTheme = hydrated ? appearance.colorMode : theme;

    // Keep localStorage in sync with settings (write-through for SSR flash prevention)
    if (hydrated && getStored() !== appearance.colorMode) {
      setStored(appearance.colorMode);
    }

    applyTheme(canonicalTheme, false, hydrated ? appearance : DEFAULT_APPEARANCE_SETTINGS);
  }, [appearance, hydrated, theme]);

  const canonicalTheme = hydrated ? appearance.colorMode : theme;
  const resolvedTheme: "light" | "dark" =
    canonicalTheme === "system" ? (snapshot.systemDark ? "dark" : "light") : canonicalTheme;

  return { theme: canonicalTheme, setTheme, resolvedTheme } as const;
}

/**
 * Preview a theme visually without persisting it to settings.
 * Call with null to restore the current settings-based theme.
 */
export function previewTheme(theme: ThemeDocument | null, currentAppearance: AppearanceSettings) {
  if (typeof document === "undefined") return;

  if (theme === null) {
    // Restore to current settings
    const resolvedTheme = resolveAppearanceTheme(currentAppearance);
    applyThemeVariables(resolvedTheme);
  } else {
    applyThemeVariables(theme);
  }
}

function applyThemeVariables(theme: ThemeDocument) {
  if (typeof document === "undefined") return;
  if (typeof document.documentElement.style?.setProperty !== "function") return;

  const isDark = theme.mode === "dark";
  document.documentElement.classList.toggle("dark", isDark);

  const variables = deriveAppearanceCssVariables(theme);
  for (const [name, value] of Object.entries(variables)) {
    document.documentElement.style.setProperty(name, value);
  }

  syncBrowserChromeTheme();
}
