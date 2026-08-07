import type { DesktopBridge } from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  DEFAULT_THEME_PALETTE,
  ThemePaletteSchema,
  normalizeThemePalette,
  type ThemePalette,
} from "../lib/themePalettes";

const ThemePreference = Schema.Literals(["light", "dark", "system"]);
type Theme = typeof ThemePreference.Type;
type ThemeSnapshot = {
  theme: Theme;
  palette: ThemePalette;
  systemDark: boolean;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "t3code:theme";
/**
 * The palette is kept in its own flat key rather than in client settings so
 * the pre-boot script in `index.html` can read it synchronously. Client
 * settings hydrate asynchronously from a JSON blob, which would show a flash
 * of the default palette on every load.
 */
const PALETTE_STORAGE_KEY = "t3code:theme-palette";
/** Read by the pre-boot script in `index.html`; format is `palette:mode:color`. */
const CHROME_COLOR_STORAGE_KEY = "t3code:theme-chrome";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  palette: DEFAULT_THEME_PALETTE,
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
    palette: Schema.optional(ThemePaletteSchema),
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
let lastDesktopChromeColor: string | null = null;
let lastAppliedTheme: ThemeSnapshot | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;
let paletteStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
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

export function readThemePalette(): ThemePalette {
  if (typeof window === "undefined") return DEFAULT_THEME_PALETTE;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PALETTE_STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: PALETTE_STORAGE_KEY,
      cause,
    });
  }
  return normalizeThemePalette(raw);
}

export function writeThemePalette(palette: ThemePalette): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
    paletteStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: PALETTE_STORAGE_KEY,
      palette,
      cause,
    });
  }
}

function getStoredPalette(): ThemePalette {
  if (paletteStorageReadFailure !== null) {
    return DEFAULT_THEME_PALETTE;
  }
  try {
    return readThemePalette();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: PALETTE_STORAGE_KEY,
          cause,
        });
    paletteStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_PALETTE;
  }
}

function getStored(): Theme {
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
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
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

/**
 * A palette's chrome color can only be known once the stylesheet has applied,
 * which is after the pre-boot script in `index.html` has already had to paint
 * something. Cache the resolved value, tagged with the palette and mode it
 * belongs to, so the next load starts in the right color instead of flashing
 * the neutral fallback.
 */
function cacheBootChromeColor(backgroundColor: string) {
  if (typeof window === "undefined") return;
  const palette = document.documentElement.dataset.themePalette ?? DEFAULT_THEME_PALETTE;
  const mode = document.documentElement.classList.contains("dark") ? "dark" : "light";
  try {
    window.localStorage.setItem(CHROME_COLOR_STORAGE_KEY, `${palette}:${mode}:${backgroundColor}`);
  } catch {
    // A read-only or full storage only costs a one-frame flash on next boot.
  }
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
  cacheBootChromeColor(backgroundColor);
  syncDesktopChromeColor(backgroundColor);
}

function applyTheme(theme: Theme, palette: ThemePalette, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
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
    document.documentElement.classList.add("no-transitions");
  }
  const isDark = theme === "dark" || (theme === "system" && systemDark);
  document.documentElement.classList.toggle("dark", isDark);
  // Must land before syncBrowserChromeTheme so the chrome color is read from
  // the palette that is actually about to paint. Guarded because this runs at
  // module load, where a partial DOM would otherwise take the whole app down
  // over a cosmetic attribute.
  if (document.documentElement.dataset) {
    document.documentElement.dataset.themePalette = palette;
  }
  lastAppliedTheme = { theme, palette, systemDark };
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

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
): Promise<void> {
  try {
    await bridge.setTheme(theme);
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

/**
 * Hands the resolved chrome color to the Electron shell so it can persist it
 * and open the next window in the palette's background. Without this the
 * native window frame paints its hardcoded neutral before the renderer's first
 * frame, which reads as a flash on any strongly tinted palette.
 */
export function syncDesktopChromeColor(backgroundColor: string) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (
    !bridge ||
    typeof bridge.setChromeBackgroundColor !== "function" ||
    lastDesktopChromeColor === backgroundColor
  ) {
    return;
  }

  lastDesktopChromeColor = backgroundColor;
  void bridge.setChromeBackgroundColor(backgroundColor).catch((cause: unknown) => {
    console.error("Failed to sync the chrome background color to the desktop shell.", {
      backgroundColor,
      ...safeErrorLogAttributes(cause),
    });
    if (lastDesktopChromeColor === backgroundColor) {
      lastDesktopChromeColor = null;
    }
  });
}

export function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void syncDesktopThemePreference(bridge, theme).catch((cause: unknown) => {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause });
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    });
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored(), getStoredPalette());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
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

  lastSnapshot = { theme, palette, systemDark };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // Listen for system preference changes
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", getStoredPalette(), true);
    emitChange();
  };
  mq?.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === PALETTE_STORAGE_KEY) {
      if (e.key === STORAGE_KEY) themeStorageReadFailure = null;
      if (e.key === PALETTE_STORAGE_KEY) paletteStorageReadFailure = null;
      applyTheme(getStored(), getStoredPalette(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq?.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;
  const palette = snapshot.palette;

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (snapshot.systemDark ? "dark" : "light") : theme;

  const setTheme = useCallback((next: Theme) => {
    if (typeof window === "undefined") return;
    try {
      writeThemePreference(next);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: STORAGE_KEY,
            theme: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });
      return;
    }
    applyTheme(next, getStoredPalette(), true);
    emitChange();
  }, []);

  const setPalette = useCallback((next: ThemePalette) => {
    if (typeof window === "undefined") return;
    try {
      writeThemePalette(next);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: PALETTE_STORAGE_KEY,
            palette: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        palette: next,
        ...safeErrorLogAttributes(error),
      });
      return;
    }
    applyTheme(getStored(), next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme, palette);
  }, [palette, theme]);

  return { theme, setTheme, resolvedTheme, palette, setPalette } as const;
}
