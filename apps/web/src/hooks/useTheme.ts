import type { DesktopBridge } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { DEFAULT_THEME_PALETTE, isThemePalette, type ThemePalette } from "../themePalettes";

const ThemePreference = Schema.Literals(["light", "dark", "system"]);
type Theme = typeof ThemePreference.Type;
type ThemeSnapshot = {
  palette: ThemePalette;
  theme: Theme;
  systemDark: boolean;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

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

export class ThemeStorageError extends Schema.TaggedErrorClass<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedErrorClass<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;
let lastAppliedTheme: ThemeSnapshot | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

function themeErrorLogAttributes(error: ThemeStorageError | DesktopThemeSyncError) {
  if (isThemeStorageError(error)) {
    return {
      errorTag: error._tag,
      operation: error.operation,
      storageKey: error.storageKey,
    };
  }
  return {
    errorTag: error._tag,
    theme: error.theme,
  };
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return DEFAULT_THEME_SNAPSHOT.theme;
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

function writeThemePalette(palette: ThemePalette): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: PALETTE_STORAGE_KEY,
      cause,
    });
  }
}

function getStored(): Theme {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.theme;
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, themeErrorLogAttributes(error));
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function getStoredPalette(): ThemePalette {
  if (!hasThemeStorage()) return DEFAULT_THEME_SNAPSHOT.palette;
  if (themeStorageReadFailure !== null) return DEFAULT_THEME_SNAPSHOT.palette;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PALETTE_STORAGE_KEY);
  } catch {
    return DEFAULT_THEME_SNAPSHOT.palette;
  }
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
    document.querySelector<HTMLElement>("[data-theme-surface]") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inset']") ??
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
  const root = document.documentElement;
  if (!root || !root.dataset) return;
  const systemDark = theme === "system" ? getSystemDark() : false;
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.palette === palette &&
    lastAppliedTheme.systemDark === systemDark
  ) {
    syncDesktopTheme(theme);
    return;
  }

  if (suppressTransitions) {
    root.classList.add("no-transitions");
  }
  const isDark = theme === "dark" || (theme === "system" && systemDark);
  root.classList.toggle("dark", isDark);
  root.dataset.themePalette = palette;
  lastAppliedTheme = { palette, theme, systemDark };
  syncBrowserChromeTheme();
  syncDesktopTheme(theme);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => {
      root.classList.remove("no-transitions");
    });
  }
}

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
): Promise<void> {
  try {
    await bridge.setTheme(theme);
    lastDesktopTheme = theme;
  } catch (cause) {
    lastDesktopTheme = null;
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

export function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void syncDesktopThemePreference(bridge, theme).catch((error) => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
    const structuredError = isDesktopThemeSyncError(error)
      ? error
      : new DesktopThemeSyncError({ theme, cause: error });
    console.error(structuredError.message, themeErrorLogAttributes(structuredError));
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
      if (e.key === STORAGE_KEY) {
        themeStorageReadFailure = null;
      }
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
    try {
      writeThemePreference(next);
    } catch (error) {
      if (isThemeStorageError(error)) {
        console.error(error.message, themeErrorLogAttributes(error));
      }
      return;
    }
    applyTheme(next, getStoredPalette(), true);
    emitChange();
  }, []);

  const setPalette = useCallback(
    (next: ThemePalette) => {
      if (!hasThemeStorage()) return;
      try {
        writeThemePalette(next);
      } catch (error) {
        if (isThemeStorageError(error)) {
          console.error(error.message, themeErrorLogAttributes(error));
        }
        return;
      }
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
