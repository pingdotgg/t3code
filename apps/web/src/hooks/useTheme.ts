import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Theme =
  | "light"
  | "dark"
  | "system"
  | "catppuccin"
  | "monokai"
  | "tokyo";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const THEME_VALUES = new Set<Theme>([
  "system",
  "light",
  "dark",
  "catppuccin",
  "monokai",
  "tokyo",
]);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

function getStored(): Theme {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (THEME_VALUES.has(raw as Theme)) return raw as Theme;
  return "system";
}

function isDarkTheme(theme: Theme): boolean {
  if (theme === "light") return false;
  if (theme === "dark" || theme === "catppuccin" || theme === "monokai" || theme === "tokyo")
    return true;
  return getSystemDark();
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const isDark = isDarkTheme(theme);
  document.documentElement.classList.toggle("dark", isDark);
  const dataTheme =
    theme === "system" ? (getSystemDark() ? "dark" : "light") : theme;
  document.documentElement.setAttribute("data-theme", dataTheme);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

// Apply immediately on module load to prevent flash
applyTheme(getStored());

function getSnapshot(): ThemeSnapshot {
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(getStored(), true);
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
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" =
    theme === "system"
      ? snapshot.systemDark
        ? "dark"
        : "light"
      : theme === "light"
        ? "light"
        : "dark";

  const resolvedThemeForCode: "light" | "dark" | "catppuccin" | "monokai" | "tokyo" =
    theme === "system"
      ? snapshot.systemDark
        ? "dark"
        : "light"
      : theme;

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme, resolvedThemeForCode } as const;
}
