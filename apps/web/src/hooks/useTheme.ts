import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { DesktopTheme } from "@forma/contracts";
import {
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  type CustomThemeSettings,
  type ThemeMode,
  applyThemePreferenceToDocument,
  readStoredThemeSettings,
  resolveDesktopTheme,
  resolveThemeMode,
  setDynamicThemeColor,
  writeStoredThemeSettings,
} from "../theme";

type ThemeSnapshot = {
  theme: CustomThemeSettings;
  systemDark: boolean;
};

const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: readStoredThemeSettings(null),
  systemDark: false,
};

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: DesktopTheme | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(THEME_MEDIA_QUERY).matches
  );
}

function getStored(): CustomThemeSettings {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.theme;
  return readStoredThemeSettings(localStorage);
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
  setDynamicThemeColor(backgroundColor, document);
}

function syncDesktopTheme(theme: CustomThemeSettings) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const desktopTheme = resolveDesktopTheme(theme, getSystemDark());
  if (!bridge || lastDesktopTheme === desktopTheme) {
    return;
  }

  lastDesktopTheme = desktopTheme;
  void bridge.setTheme(desktopTheme).catch(() => {
    if (lastDesktopTheme === desktopTheme) {
      lastDesktopTheme = null;
    }
  });
}

function applyTheme(theme: CustomThemeSettings, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  applyThemePreferenceToDocument(theme, {
    document,
    systemDark: getSystemDark(),
  });
  syncBrowserChromeTheme();
  syncDesktopTheme(theme);

  if (suppressTransitions) {
    void document.documentElement.offsetHeight;
    window.requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

if (typeof document !== "undefined" && hasThemeStorage()) {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const systemDark = theme.mode === "system" ? getSystemDark() : false;

  if (
    lastSnapshot &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.theme.mode === theme.mode &&
    lastSnapshot.theme.hue === theme.hue &&
    lastSnapshot.theme.saturation === theme.saturation
  ) {
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

  const mq = window.matchMedia(THEME_MEDIA_QUERY);
  const handleChange = () => {
    if (getStored().mode === "system") {
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  mq.addEventListener("change", handleChange);

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) {
      return;
    }
    applyTheme(getStored(), true);
    emitChange();
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((candidate) => candidate !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;
  const resolvedTheme = resolveThemeMode(theme, snapshot.systemDark);
  const isDark = resolvedTheme === "dark";

  const updateTheme = useCallback((next: Partial<CustomThemeSettings>) => {
    if (!hasThemeStorage()) return;
    const updatedTheme = { ...getStored(), ...next };
    writeStoredThemeSettings(updatedTheme, localStorage);
    applyTheme(updatedTheme, true);
    emitChange();
  }, []);

  const setThemeMode = useCallback(
    (mode: ThemeMode) => {
      updateTheme({ mode });
    },
    [updateTheme],
  );

  const setThemeHue = useCallback(
    (hue: number) => {
      updateTheme({ hue });
    },
    [updateTheme],
  );

  const setThemeSaturation = useCallback(
    (saturation: number) => {
      updateTheme({ saturation });
    },
    [updateTheme],
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setThemeHue, setThemeMode, setThemeSaturation, resolvedTheme, isDark } as const;
}
