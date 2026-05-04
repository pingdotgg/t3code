import { type ThemeMode } from "@t3tools/contracts/settings";
import { useCallback, useEffect, useMemo } from "react";
import { useSettings, useUpdateSettings } from "./useSettings";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

function getSystemDark() {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
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

export const THEMES = {
  dracula: {
    label: "Dracula",
    colors: {
      bg: "231 15% 18%",
      fg: "60 30% 96%",
      card: "231 15% 16%",
      primary: "265 89% 78%",
      secondary: "231 15% 25%",
      accent: "326 100% 74%",
    },
    css: `
      .dark.dracula {
        color-scheme: dark;
        --background: hsl(231 15% 18%);
        --app-chrome-background: hsl(231 15% 18%);
        --foreground: hsl(60 30% 96%);
        --card: hsl(231 15% 16%);
        --card-foreground: hsl(60 30% 96%);
        --popover: hsl(231 15% 14%);
        --popover-foreground: hsl(60 30% 96%);
        --primary: hsl(265 89% 78%);
        --primary-foreground: hsl(231 15% 10%);
        --secondary: hsl(231 15% 25%);
        --secondary-foreground: hsl(60 30% 96%);
        --muted: hsl(231 15% 22%);
        --muted-foreground: hsl(60 10% 65%);
        --accent: hsl(326 100% 74%);
        --accent-foreground: hsl(60 30% 96%);
        --destructive: hsl(0 100% 67%);
        --destructive-foreground: hsl(60 30% 96%);
        --border: hsl(231 15% 22%);
        --input: hsl(231 15% 22%);
        --ring: hsl(265 89% 78%);
        --sidebar-background: hsl(231 15% 15%);
        --sidebar-foreground: hsl(60 30% 90%);
        --sidebar-primary: hsl(265 89% 78%);
        --sidebar-primary-foreground: hsl(231 15% 10%);
        --sidebar-accent: hsl(231 15% 22%);
        --sidebar-accent-foreground: hsl(60 30% 96%);
        --sidebar-border: hsl(231 15% 18%);
        --sidebar-ring: hsl(265 89% 78%);
      }
    `,
  },
  "one-dark": {
    label: "One Dark Borderless",
    colors: {
      bg: "220 12% 14%",
      fg: "220 14% 71%",
      card: "220 12% 12%",
      primary: "187 47% 55%",
      secondary: "220 12% 20%",
      accent: "95 38% 62%",
    },
    css: `
      .dark.one-dark {
        color-scheme: dark;
        --background: hsl(220 12% 14%);
        --app-chrome-background: hsl(220 12% 14%);
        --foreground: hsl(220 14% 71%);
        --card: hsl(220 12% 12%);
        --card-foreground: hsl(220 14% 71%);
        --popover: hsl(220 12% 10%);
        --popover-foreground: hsl(220 14% 71%);
        --primary: hsl(187 47% 55%);
        --primary-foreground: hsl(220 12% 10%);
        --secondary: hsl(220 12% 20%);
        --secondary-foreground: hsl(220 14% 91%);
        --muted: hsl(220 12% 16%);
        --muted-foreground: hsl(220 8% 50%);
        --accent: hsl(95 38% 62%);
        --accent-foreground: hsl(220 12% 10%);
        --destructive: hsl(355 65% 65%);
        --destructive-foreground: hsl(220 14% 91%);
        --border: hsl(220 12% 16%);
        --input: hsl(220 12% 16%);
        --ring: hsl(187 47% 55%);
        --sidebar-background: hsl(220 12% 11%);
        --sidebar-foreground: hsl(220 14% 71%);
        --sidebar-primary: hsl(187 47% 55%);
        --sidebar-primary-foreground: hsl(220 12% 11%);
        --sidebar-accent: hsl(220 12% 16%);
        --sidebar-accent-foreground: hsl(220 14% 91%);
        --sidebar-border: hsl(220 12% 11%);
        --sidebar-ring: hsl(187 47% 55%);
      }
    `,
  },
  "oled-dark": {
    label: "OLED Dark",
    colors: {
      bg: "0 0% 0%",
      fg: "0 0% 90%",
      card: "0 0% 2%",
      primary: "0 0% 90%",
      secondary: "0 0% 8%",
      accent: "0 0% 20%",
    },
    css: `
      .dark.oled-dark {
        color-scheme: dark;
        --background: hsl(0 0% 0%);
        --app-chrome-background: hsl(0 0% 0%);
        --foreground: hsl(0 0% 90%);
        --card: hsl(0 0% 2%);
        --card-foreground: hsl(0 0% 90%);
        --popover: hsl(0 0% 0%);
        --popover-foreground: hsl(0 0% 90%);
        --primary: hsl(0 0% 95%);
        --primary-foreground: hsl(0 0% 0%);
        --secondary: hsl(0 0% 8%);
        --secondary-foreground: hsl(0 0% 90%);
        --muted: hsl(0 0% 6%);
        --muted-foreground: hsl(0 0% 50%);
        --accent: hsl(0 0% 12%);
        --accent-foreground: hsl(0 0% 100%);
        --destructive: hsl(0 84% 60%);
        --destructive-foreground: hsl(0 0% 100%);
        --border: hsl(0 0% 10%);
        --input: hsl(0 0% 10%);
        --ring: hsl(0 0% 90%);
        --sidebar-background: hsl(0 0% 0%);
        --sidebar-foreground: hsl(0 0% 80%);
        --sidebar-primary: hsl(0 0% 95%);
        --sidebar-primary-foreground: hsl(0 0% 0%);
        --sidebar-accent: hsl(0 0% 8%);
        --sidebar-accent-foreground: hsl(0 0% 100%);
        --sidebar-border: hsl(0 0% 5%);
        --sidebar-ring: hsl(0 0% 90%);
      }
    `,
  },
  nord: {
    label: "Nord",
    colors: {
      bg: "220 16% 22%",
      fg: "218 27% 92%",
      card: "220 16% 20%",
      primary: "193 43% 67%",
      secondary: "220 16% 28%",
      accent: "213 32% 52%",
    },
    css: `
      .dark.nord {
        color-scheme: dark;
        --background: hsl(220 16% 22%);
        --app-chrome-background: hsl(220 16% 22%);
        --foreground: hsl(218 27% 92%);
        --card: hsl(220 16% 20%);
        --card-foreground: hsl(218 27% 92%);
        --popover: hsl(220 16% 18%);
        --popover-foreground: hsl(218 27% 92%);
        --primary: hsl(193 43% 67%);
        --primary-foreground: hsl(220 16% 14%);
        --secondary: hsl(220 16% 28%);
        --secondary-foreground: hsl(218 27% 92%);
        --muted: hsl(220 16% 26%);
        --muted-foreground: hsl(218 16% 70%);
        --accent: hsl(213 32% 52%);
        --accent-foreground: hsl(218 27% 96%);
        --destructive: hsl(354 42% 56%);
        --destructive-foreground: hsl(218 27% 96%);
        --border: hsl(220 16% 30%);
        --input: hsl(220 16% 30%);
        --ring: hsl(193 43% 67%);
        --sidebar-background: hsl(220 16% 19%);
        --sidebar-foreground: hsl(218 27% 88%);
        --sidebar-primary: hsl(193 43% 67%);
        --sidebar-primary-foreground: hsl(220 16% 14%);
        --sidebar-accent: hsl(220 16% 26%);
        --sidebar-accent-foreground: hsl(218 27% 96%);
        --sidebar-border: hsl(220 16% 26%);
        --sidebar-ring: hsl(193 43% 67%);
      }
    `,
  },
  "tokyo-night": {
    label: "Tokyo Night",
    colors: {
      bg: "229 26% 18%",
      fg: "220 27% 92%",
      card: "229 26% 15%",
      primary: "210 93% 76%",
      secondary: "229 22% 24%",
      accent: "262 83% 78%",
    },
    css: `
      .dark.tokyo-night {
        color-scheme: dark;
        --background: hsl(229 26% 18%);
        --app-chrome-background: hsl(229 26% 18%);
        --foreground: hsl(220 27% 92%);
        --card: hsl(229 26% 15%);
        --card-foreground: hsl(220 27% 92%);
        --popover: hsl(229 26% 13%);
        --popover-foreground: hsl(220 27% 92%);
        --primary: hsl(210 93% 76%);
        --primary-foreground: hsl(229 26% 10%);
        --secondary: hsl(229 22% 24%);
        --secondary-foreground: hsl(220 27% 92%);
        --muted: hsl(229 22% 22%);
        --muted-foreground: hsl(220 18% 68%);
        --accent: hsl(262 83% 78%);
        --accent-foreground: hsl(229 26% 10%);
        --destructive: hsl(352 89% 71%);
        --destructive-foreground: hsl(220 27% 96%);
        --border: hsl(229 22% 28%);
        --input: hsl(229 22% 28%);
        --ring: hsl(210 93% 76%);
        --sidebar-background: hsl(229 26% 14%);
        --sidebar-foreground: hsl(220 27% 88%);
        --sidebar-primary: hsl(210 93% 76%);
        --sidebar-primary-foreground: hsl(229 26% 10%);
        --sidebar-accent: hsl(229 22% 22%);
        --sidebar-accent-foreground: hsl(220 27% 96%);
        --sidebar-border: hsl(229 22% 24%);
        --sidebar-ring: hsl(210 93% 76%);
      }
    `,
  },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    colors: {
      bg: "30 8% 12%",
      fg: "39 24% 78%",
      card: "30 8% 15%",
      primary: "96 31% 61%",
      secondary: "186 33% 40%",
      accent: "43 55% 38%",
    },
    css: `
      .dark.gruvbox-dark {
        color-scheme: dark;
        --background: hsl(30 8% 12%);
        --app-chrome-background: hsl(30 8% 12%);
        --foreground: hsl(39 24% 78%);
        --card: hsl(30 8% 15%);
        --card-foreground: hsl(39 24% 78%);
        --popover: hsl(30 8% 13%);
        --popover-foreground: hsl(39 24% 78%);
        --primary: hsl(96 31% 61%);
        --primary-foreground: hsl(30 8% 10%);
        --secondary: hsl(186 33% 40%);
        --secondary-foreground: hsl(39 24% 82%);
        --muted: hsl(30 8% 18%);
        --muted-foreground: hsl(39 14% 58%);
        --accent: hsl(43 55% 38%);
        --accent-foreground: hsl(30 8% 10%);
        --destructive: hsl(2 75% 46%);
        --destructive-foreground: hsl(39 24% 82%);
        --border: hsl(30 8% 20%);
        --input: hsl(30 8% 20%);
        --ring: hsl(43 55% 38%);
        --sidebar-background: hsl(30 8% 11%);
        --sidebar-foreground: hsl(39 20% 74%);
        --sidebar-primary: hsl(96 31% 61%);
        --sidebar-primary-foreground: hsl(30 8% 10%);
        --sidebar-accent: hsl(186 33% 40%);
        --sidebar-accent-foreground: hsl(39 24% 82%);
        --sidebar-border: hsl(30 8% 18%);
        --sidebar-ring: hsl(43 55% 38%);
      }
    `,
  },
} as const;

export interface ThemeDefinition {
  readonly label: string;
  readonly colors: {
    readonly bg: string;
    readonly fg: string;
    readonly card: string;
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
  };
  readonly css: string;
}

export type ThemeColors = ThemeDefinition["colors"];

function applyTheme(theme: ThemeMode, customCSS: string, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  // DEFINITIVELY clear all possible theme classes first
  const allThemeClasses = [
    "dark",
    "light",
    "dracula",
    "one-dark",
    "oled-dark",
    "nord",
    "tokyo-night",
    "gruvbox-dark",
    "custom",
  ];
  document.documentElement.classList.remove(...allThemeClasses);

  const isDark =
    theme === "dark" ||
    theme === "dracula" ||
    theme === "one-dark" ||
    theme === "oled-dark" ||
    theme === "nord" ||
    theme === "tokyo-night" ||
    theme === "gruvbox-dark" ||
    (theme === "system" && getSystemDark());

  const isBaseTheme = theme === "system" || theme === "light" || theme === "dark";

  if (isBaseTheme) {
    document.documentElement.classList.add(isDark ? "dark" : "light");
  } else {
    if (isDark) {
      document.documentElement.classList.add("dark");
    }
    document.documentElement.classList.add(theme);
  }

  // Inject Custom CSS

  let styleElement = document.getElementById("t3code-custom-theme-css");
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.id = "t3code-custom-theme-css";
    document.head.appendChild(styleElement);
  }

  let fullCSS = "";
  for (const t of Object.values(THEMES)) {
    fullCSS += (t as ThemeDefinition).css;
  }
  if (theme === "custom" && customCSS) {
    fullCSS += `\n.custom {\n${customCSS}\n}`;
  }
  styleElement.textContent = fullCSS;

  syncBrowserChromeTheme();
  syncDesktopTheme(isDark ? "dark" : "light");

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

function syncDesktopTheme(theme: "light" | "dark") {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge) {
    return;
  }

  void bridge.setTheme(theme).catch(() => {});
}

export function useTheme() {
  const { theme, customCSS } = useSettings((s) => ({
    theme: s.theme,
    customCSS: s.customCSS,
  }));
  const { updateSettings } = useUpdateSettings();

  const systemDark = useMemo(() => getSystemDark(), []);

  const resolvedTheme: "light" | "dark" = useMemo(() => {
    if (theme === "system") return systemDark ? "dark" : "light";
    if (theme === "light") return "light";
    return "dark"; // All custom themes are dark for now
  }, [theme, systemDark]);

  const setTheme = useCallback(
    (next: ThemeMode) => {
      updateSettings({ theme: next });
    },
    [updateSettings],
  );

  useEffect(() => {
    applyTheme(theme, customCSS, true);
  }, [theme, customCSS]);

  // Handle system dark mode changes
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia(MEDIA_QUERY);
    const handleChange = () => {
      applyTheme("system", customCSS, true);
    };
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, [theme, customCSS]);

  return { theme, setTheme, resolvedTheme, customCSS } as const;
}
