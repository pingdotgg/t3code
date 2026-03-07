import { useCallback, useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "night" | "system";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

export const THEME_OPTIONS = [
  { value: "light", label: "Light", description: "Light mode" },
  { value: "dark", label: "Dark", description: "Balanced dark mode" },
  { value: "night", label: "Night", description: "Darkest mode" },
  { value: "system", label: "System", description: "Follow system preference" },
] as const;

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

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
  if (raw === "light" || raw === "dark" || raw === "night" || raw === "system") return raw;
  return "system";
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  
  // Determine which CSS classes to apply
  // - "dark" class = dark mode (middle ground)
  // - "night" class = darkest mode
  // - neither = light mode
  const resolvedTheme = theme === "system" 
    ? (getSystemDark() ? "dark" : "light") 
    : theme;
  
  document.documentElement.classList.remove("dark", "night");
  if (resolvedTheme === "dark") {
    document.documentElement.classList.add("dark");
  } else if (resolvedTheme === "night") {
    document.documentElement.classList.add("dark", "night");
  }
  
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

  // resolvedTheme returns "light" or "dark" for components that only care about light/dark distinction
  // (night is treated as dark for icon/color purposes)
  const resolvedTheme: "light" | "dark" =
    theme === "system" 
      ? (snapshot.systemDark ? "dark" : "light") 
      : theme === "night" 
        ? "dark" 
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

  return { theme, setTheme, resolvedTheme } as const;
}

export type { Theme };
