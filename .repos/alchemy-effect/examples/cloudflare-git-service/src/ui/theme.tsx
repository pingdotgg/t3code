/** Three-state theme: light / dark / system, persisted in localStorage.
 *  The `.dark` class on <html> is the single source of truth; the
 *  pre-paint script in index.html applies it before hydration using the
 *  same storage contract (key "theme"; absent = system). */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme";

const readPreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");

const resolve = (preference: ThemePreference): ResolvedTheme =>
  preference === "system"
    ? systemDark().matches
      ? "dark"
      : "light"
    : preference;

const apply = (resolved: ResolvedTheme) => {
  document.documentElement.classList.toggle("dark", resolved === "dark");
};

const ThemeContext = createContext<{
  preference: ThemePreference;
  /** What is actually showing right now — feed this to @pierre/diffs. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}>({ preference: "system", resolved: "light", setPreference: () => {} });

export const useTheme = () => useContext(ThemeContext);

/**
 * Options fragment for `@pierre/diffs` components (FileDiff, CodeView, …).
 * The library renders into a shadow root whose default `color-scheme` is
 * `light dark` — i.e. it follows the OS, not our `.dark` class. Passing
 * `themeType: resolved` pins the shadow root to OUR toggle. Never leave
 * themeType at "system". Spread into the component's `options` prop:
 *
 *   const diffTheme = useDiffThemeOptions();
 *   <FileDiff options={{ ...diffTheme }} ... />
 */
export const useDiffThemeOptions = (): {
  readonly theme: { readonly light: string; readonly dark: string };
  readonly themeType: ResolvedTheme;
} => {
  const { resolved } = useTheme();
  return {
    // Shiki theme pair; the library picks per light-dark() at paint time.
    theme: { light: "github-light-default", dark: "github-dark-default" },
    themeType: resolved,
  };
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(readPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolve(readPreference()),
  );

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage disabled — theme still applies for this page */
    }
    setPreferenceState(next);
    const nextResolved = resolve(next);
    setResolved(nextResolved);
    apply(nextResolved);
  }, []);

  // Track OS changes while in "system".
  useEffect(() => {
    if (preference !== "system") return;
    const media = systemDark();
    const onChange = () => {
      const nextResolved = resolve("system");
      setResolved(nextResolved);
      apply(nextResolved);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  // Cross-tab sync (another tab toggled the theme).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const next = readPreference();
      setPreferenceState(next);
      const nextResolved = resolve(next);
      setResolved(nextResolved);
      apply(nextResolved);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
};
