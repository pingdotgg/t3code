/**
 * Unified appearance hook — replaces `useTheme`.
 *
 * All appearance state (colorMode, activeThemeId, accentHue) is
 * server-authoritative and pushed to every client via `serverConfigUpdated`.
 *
 * A localStorage write-through cache prevents FOUC: module-scope code below
 * reads the cache synchronously and applies the `.dark` class + theme tokens
 * before React mounts.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ColorMode } from "@t3tools/contracts/settings";
import type { DesktopAppearance } from "@t3tools/contracts";
import { applyThemeTokens, findThemeById, removeThemeTokens, BUILT_IN_THEMES } from "~/lib/themes";
import { useSettings, useUpdateSettings } from "./useSettings";

// ── Constants ────────────────────────────────────────────────────

const APPEARANCE_CACHE_KEY = "t3code:appearance-cache";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

// ── Helpers ──────────────────────────────────────────────────────

function getSystemDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

function suppressTransitions(fn: () => void) {
  document.documentElement.classList.add("no-transitions");
  fn();
  // Force reflow so the no-transitions class takes effect before removal
  // oxlint-disable-next-line no-unused-expressions
  document.documentElement.offsetHeight;
  requestAnimationFrame(() => {
    document.documentElement.classList.remove("no-transitions");
  });
}

// ── Desktop bridge relay ─────────────────────────────────────────

let lastDesktopAppearance: string | null = null;

function syncDesktopAppearance(appearance: DesktopAppearance): void {
  const bridge = window.desktopBridge;
  if (!bridge) return;

  const key = JSON.stringify(appearance);
  if (lastDesktopAppearance === key) return;
  lastDesktopAppearance = key;

  if (typeof bridge.setAppearance === "function") {
    void bridge.setAppearance(appearance).catch(() => {
      if (lastDesktopAppearance === key) lastDesktopAppearance = null;
    });
  } else {
    // Fallback for older Electron builds that only expose setTheme
    void bridge.setTheme(appearance.mode).catch(() => {
      if (lastDesktopAppearance === key) lastDesktopAppearance = null;
    });
  }
}

// ── FOUC prevention (module scope — runs before React mounts) ───

try {
  const cached = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null") as {
    colorMode?: string;
    activeThemeId?: string;
    accentHue?: number | null;
  } | null;
  if (cached) {
    const isDark =
      cached.colorMode === "dark" || (cached.colorMode === "system" && getSystemDark());
    document.documentElement.classList.toggle("dark", isDark);
    const theme = findThemeById(cached.activeThemeId ?? "t3code");
    if (theme) applyThemeTokens(theme, cached.accentHue ?? null, isDark ? "dark" : "light");
  }
} catch {
  // Cache unreadable — fall through to React reconciliation.
}

// ── System-dark external store (for "system" mode live updates) ──

let systemDarkListeners: Array<() => void> = [];
let cachedSystemDark: boolean | null = null;

function getSystemDarkSnapshot(): boolean {
  if (cachedSystemDark === null) cachedSystemDark = getSystemDark();
  return cachedSystemDark;
}

function subscribeSystemDark(listener: () => void): () => void {
  systemDarkListeners.push(listener);
  const mq = window.matchMedia(MEDIA_QUERY);
  const handler = () => {
    cachedSystemDark = mq.matches;
    for (const l of systemDarkListeners) l();
  };
  mq.addEventListener("change", handler);
  return () => {
    systemDarkListeners = systemDarkListeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handler);
  };
}

// ── Hook ─────────────────────────────────────────────────────────

export function useAppearance() {
  const { colorMode, activeThemeId, accentHue } = useSettings((s) => ({
    colorMode: s.colorMode,
    activeThemeId: s.activeThemeId,
    accentHue: s.accentHue,
  }));
  const { updateSettings } = useUpdateSettings();
  const activeTheme = findThemeById(activeThemeId) ?? BUILT_IN_THEMES[0]!;

  // Track system dark preference reactively
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDarkSnapshot);

  const resolvedTheme: "light" | "dark" = useMemo(
    () => (colorMode === "system" ? (systemDark ? "dark" : "light") : colorMode),
    [colorMode, systemDark],
  );

  // Apply .dark class, theme tokens, cache, and relay to Electron
  useEffect(() => {
    suppressTransitions(() => {
      document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
      applyThemeTokens(activeTheme, accentHue, resolvedTheme);
    });

    // Write-through cache for FOUC prevention on next load
    localStorage.setItem(
      APPEARANCE_CACHE_KEY,
      JSON.stringify({ colorMode, activeThemeId, accentHue }),
    );

    // Sync to Electron
    syncDesktopAppearance({ mode: colorMode, themeId: activeThemeId, accentHue });

    return () => removeThemeTokens();
  }, [resolvedTheme, activeTheme, accentHue, colorMode, activeThemeId]);

  const setColorMode = useCallback(
    (mode: ColorMode) => updateSettings({ colorMode: mode }),
    [updateSettings],
  );

  const setThemeId = useCallback(
    (id: string) => updateSettings({ activeThemeId: id }),
    [updateSettings],
  );

  const setAccentHue = useCallback(
    (hue: number | null) => updateSettings({ accentHue: hue }),
    [updateSettings],
  );

  return {
    colorMode,
    resolvedTheme,
    activeTheme,
    accentHue,
    setColorMode,
    setThemeId,
    setAccentHue,
  } as const;
}
