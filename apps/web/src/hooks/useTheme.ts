import { useCallback, useSyncExternalStore } from "react";
import type {
  DesktopTheme,
  DiscoveredColorTheme,
  ResolvedColorTheme,
  ThemePreference,
} from "@t3tools/contracts";
import { DEFAULT_THEME_PREFERENCE } from "@t3tools/contracts";
import { EXTERNAL_APP_THEME_VARIABLES, isDarkThemeKind } from "@t3tools/shared/themeMapping";

type BuiltInTheme = "light" | "dark" | "system";
type ThemeStatus = "idle" | "loading" | "ready" | "error";
type ThemeSnapshot = {
  preference: ThemePreference;
  systemDark: boolean;
  resolvedKind: "light" | "dark";
  resolvedColorTheme: ResolvedColorTheme | null;
  discoveredThemes: readonly DiscoveredColorTheme[];
  status: ThemeStatus;
  message: string | null;
};

const STORAGE_KEY = "t3code:theme";
const PREFERENCE_STORAGE_KEY = "t3code:theme-preference:v1";
const BOOTSTRAP_THEME_CACHE_KEY = "t3code:resolved-theme-cache:v1";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: DesktopTheme | null = null;
let themeRuntimeRefCount = 0;
let stopThemeRuntime: (() => void) | null = null;
let refreshThemesPromise: Promise<void> | null = null;
const preferenceLoadPromises = new Map<string, Promise<void>>();
let state: ThemeSnapshot = {
  preference: DEFAULT_THEME_PREFERENCE,
  systemDark: false,
  resolvedKind: "light",
  resolvedColorTheme: null,
  discoveredThemes: [],
  status: "idle",
  message: null,
};

function emitChange() {
  for (const listener of listeners) listener();
}

function hasThemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark() {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function builtInToPreference(theme: BuiltInTheme): ThemePreference {
  return theme === "system" ? { mode: "system" } : { mode: "builtin", theme };
}

function preferenceToBuiltInTheme(preference: ThemePreference): BuiltInTheme {
  if (preference.mode === "builtin") return preference.theme;
  return "system";
}

function parsePreference(value: string | null): ThemePreference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    if ("mode" in parsed && parsed.mode === "system") return { mode: "system" };
    if ("mode" in parsed && parsed.mode === "builtin" && "theme" in parsed) {
      if (parsed.theme === "light" || parsed.theme === "dark") {
        return { mode: "builtin", theme: parsed.theme };
      }
    }
    if ("mode" in parsed && parsed.mode === "external" && "themeId" in parsed) {
      return typeof parsed.themeId === "string"
        ? { mode: "external", themeId: parsed.themeId }
        : null;
    }
    if ("mode" in parsed && parsed.mode === "follow-editor" && "source" in parsed) {
      if (
        parsed.source === "vscode" ||
        parsed.source === "cursor" ||
        parsed.source === "vscode-insiders"
      ) {
        return { mode: "follow-editor", source: parsed.source };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function getStoredPreference(): ThemePreference {
  if (!hasThemeStorage()) return DEFAULT_THEME_PREFERENCE;
  const savedPreference = parsePreference(localStorage.getItem(PREFERENCE_STORAGE_KEY));
  if (savedPreference) return savedPreference;
  const legacy = localStorage.getItem(STORAGE_KEY);
  if (legacy === "light" || legacy === "dark" || legacy === "system") {
    const migrated = builtInToPreference(legacy);
    localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  }
  return DEFAULT_THEME_PREFERENCE;
}

function setStoredPreference(preference: ThemePreference) {
  if (!hasThemeStorage()) return;
  localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
  localStorage.setItem(STORAGE_KEY, preferenceToBuiltInTheme(preference));
}

function isSamePreference(a: ThemePreference, b: ThemePreference) {
  if (a.mode !== b.mode) return false;
  if (a.mode === "builtin") return a.theme === (b.mode === "builtin" ? b.theme : null);
  if (a.mode === "external") return a.themeId === (b.mode === "external" ? b.themeId : null);
  if (a.mode === "follow-editor") {
    return a.source === (b.mode === "follow-editor" ? b.source : null);
  }
  return true;
}

function themePreferenceKey(preference: ThemePreference) {
  switch (preference.mode) {
    case "builtin":
      return `builtin:${preference.theme}`;
    case "external":
      return `external:${preference.themeId}`;
    case "follow-editor":
      return `follow-editor:${preference.source}`;
    case "system":
      return "system";
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) return element;

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

function clearExternalThemeVariables(root: HTMLElement) {
  for (const name of EXTERNAL_APP_THEME_VARIABLES) {
    root.style.removeProperty(name);
  }
}

function syncDesktopTheme(theme: DesktopTheme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge?.setTheme || lastDesktopTheme === theme) return;

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) lastDesktopTheme = null;
  });
}

function syncDesktopWindowColors(theme: ResolvedColorTheme | null) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge?.setWindowThemeColors || !theme) return;
  const backgroundColor =
    theme.appVariables["--app-chrome-background"] ??
    theme.appVariables["--background"] ??
    (isDarkThemeKind(theme.kind) ? "#0a0a0a" : "#ffffff");
  void bridge
    .setWindowThemeColors({
      backgroundColor,
      titleBarColor: backgroundColor,
      titleBarSymbolColor: theme.appVariables["--foreground"],
    })
    .catch(() => {});
}

function applyResolvedTheme(theme: ResolvedColorTheme | null, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = document.documentElement;
  if (suppressTransitions) root.classList.add("no-transitions");

  if (theme) {
    for (const [name, value] of Object.entries(theme.appVariables)) {
      root.style.setProperty(name, value);
    }
  } else {
    clearExternalThemeVariables(root);
  }

  const preference = state.preference;
  const isDark = theme
    ? isDarkThemeKind(theme.kind)
    : preference.mode === "builtin"
      ? preference.theme === "dark"
      : getSystemDark();
  root.classList.toggle("dark", isDark);
  root.dataset.themeSource = theme?.source ?? "builtin";
  root.dataset.themeId = theme?.id ?? "";
  syncBrowserChromeTheme();
  syncDesktopTheme(
    theme
      ? isDark
        ? "dark"
        : "light"
      : preference.mode === "system"
        ? "system"
        : isDark
          ? "dark"
          : "light",
  );
  syncDesktopWindowColors(theme);

  if (suppressTransitions) {
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

function recomputeSnapshot(next: Partial<ThemeSnapshot> = {}) {
  const preference = next.preference ?? state.preference;
  const systemDark = getSystemDark();
  const resolvedTheme =
    next.resolvedColorTheme === undefined ? state.resolvedColorTheme : next.resolvedColorTheme;
  const resolvedKind: "light" | "dark" = resolvedTheme
    ? isDarkThemeKind(resolvedTheme.kind)
      ? "dark"
      : "light"
    : preference.mode === "builtin"
      ? preference.theme
      : systemDark
        ? "dark"
        : "light";

  state = {
    ...state,
    ...next,
    preference,
    systemDark,
    resolvedKind,
    resolvedColorTheme: resolvedTheme,
  };
  lastSnapshot = null;
  emitChange();
}

async function loadPreference(preference: ThemePreference, suppressTransitions = true) {
  if (preference.mode === "external") {
    const bridge = window.desktopBridge;
    if (!bridge?.loadColorTheme) {
      recomputeSnapshot({
        preference,
        resolvedColorTheme: null,
        status: "error",
        message: "Desktop theme discovery is unavailable in browser mode.",
      });
      applyResolvedTheme(null, suppressTransitions);
      return;
    }

    recomputeSnapshot({ preference, status: "loading", message: null });
    let theme: ResolvedColorTheme | null;
    try {
      theme = await bridge.loadColorTheme(preference.themeId);
    } catch {
      if (!isSamePreference(state.preference, preference)) return;
      recomputeSnapshot({
        resolvedColorTheme: null,
        status: "error",
        message: "Could not load selected editor theme.",
      });
      applyResolvedTheme(null, suppressTransitions);
      return;
    }
    if (!isSamePreference(state.preference, preference)) return;
    if (!theme) {
      setStoredPreference(DEFAULT_THEME_PREFERENCE);
      recomputeSnapshot({
        preference: DEFAULT_THEME_PREFERENCE,
        resolvedColorTheme: null,
        status: "error",
        message: "Selected theme is unavailable. Falling back to System.",
      });
      applyResolvedTheme(null, suppressTransitions);
      return;
    }
    localStorage.setItem(
      BOOTSTRAP_THEME_CACHE_KEY,
      JSON.stringify({ id: theme.id, kind: theme.kind, appVariables: theme.appVariables }),
    );
    recomputeSnapshot({ preference, resolvedColorTheme: theme, status: "ready", message: null });
    applyResolvedTheme(theme, suppressTransitions);
    return;
  }

  recomputeSnapshot({ preference, resolvedColorTheme: null, status: "ready", message: null });
  applyResolvedTheme(null, suppressTransitions);
}

function loadThemePreference(preference: ThemePreference, suppressTransitions = true) {
  const key = themePreferenceKey(preference);
  const existing = preferenceLoadPromises.get(key);
  if (existing) return existing;

  const promise = loadPreference(preference, suppressTransitions).finally(() => {
    if (preferenceLoadPromises.get(key) === promise) {
      preferenceLoadPromises.delete(key);
    }
  });
  preferenceLoadPromises.set(key, promise);
  return promise;
}

function loadStoredPreference(suppressTransitions = true) {
  return loadThemePreference(getStoredPreference(), suppressTransitions);
}

async function refreshThemesNow() {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : null;
  if (!bridge?.discoverColorThemes) {
    recomputeSnapshot({
      discoveredThemes: [],
      status: "ready",
      message: "Open the desktop app to use VS Code and Cursor themes.",
    });
    return;
  }
  recomputeSnapshot({ status: "loading", message: null });
  try {
    const discoveredThemes = await bridge.discoverColorThemes();
    recomputeSnapshot({ discoveredThemes, status: "ready", message: null });
  } catch {
    recomputeSnapshot({ status: "error", message: "Could not refresh editor themes." });
  }
}

export function refreshThemes() {
  if (refreshThemesPromise) return refreshThemesPromise;

  refreshThemesPromise = refreshThemesNow().finally(() => {
    refreshThemesPromise = null;
  });
  return refreshThemesPromise;
}

function bootstrapCachedTheme() {
  if (!hasThemeStorage()) return null;
  const raw = localStorage.getItem(BOOTSTRAP_THEME_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResolvedColorTheme>;
    if (!parsed.id || !parsed.kind || !parsed.appVariables) return null;
    return parsed as ResolvedColorTheme;
  } catch {
    return null;
  }
}

if (typeof document !== "undefined" && hasThemeStorage()) {
  const preference = getStoredPreference();
  state.preference = preference;
  if (preference.mode === "external") {
    state.resolvedColorTheme = bootstrapCachedTheme();
  }
  applyResolvedTheme(state.resolvedColorTheme);
}

function getSnapshot(): ThemeSnapshot {
  if (lastSnapshot) return lastSnapshot;
  lastSnapshot = state;
  return lastSnapshot;
}

function getServerSnapshot() {
  return state;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function startThemeRuntimeUnsafe() {
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    recomputeSnapshot();
    applyResolvedTheme(state.resolvedColorTheme, true);
  };
  mq.addEventListener("change", handleChange);

  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === PREFERENCE_STORAGE_KEY) {
      void loadStoredPreference(true);
    }
  };
  window.addEventListener("storage", handleStorage);

  void loadStoredPreference(false).finally(() => {
    void refreshThemes();
  });

  return () => {
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function startThemeRuntime() {
  if (typeof window === "undefined") return () => {};

  themeRuntimeRefCount += 1;
  if (themeRuntimeRefCount === 1) {
    stopThemeRuntime = startThemeRuntimeUnsafe();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    themeRuntimeRefCount = Math.max(0, themeRuntimeRefCount - 1);
    if (themeRuntimeRefCount === 0) {
      stopThemeRuntime?.();
      stopThemeRuntime = null;
    }
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    setStoredPreference(preference);
    void loadThemePreference(preference, true);
  }, []);

  const setTheme = useCallback(
    (next: BuiltInTheme) => {
      setThemePreference(builtInToPreference(next));
    },
    [setThemePreference],
  );

  return {
    theme: preferenceToBuiltInTheme(snapshot.preference),
    setTheme,
    preference: snapshot.preference,
    setThemePreference,
    resolvedTheme: snapshot.resolvedKind,
    resolvedColorTheme: snapshot.resolvedColorTheme,
    discoveredThemes: snapshot.discoveredThemes,
    refreshThemes,
    status: snapshot.status,
    message: snapshot.message,
  } as const;
}
