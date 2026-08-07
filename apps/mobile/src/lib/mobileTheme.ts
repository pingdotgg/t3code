import type { ThemeColorRole, ThemeColors } from "@t3tools/themes";

/**
 * The mobile stylesheet intentionally keeps its literal values as the boot
 * fallback. Once a theme is selected, this table is the single bridge from
 * canonical product roles to the mobile token names used by Uniwind.
 *
 * Empty entries are native-only roles. Terminal and review adapters consume
 * those roles directly because they do not render through the CSS variable
 * layer. Roles with several names intentionally share one canonical value;
 * for example, the mobile primary action is the theme accent and all of the
 * subtle separators are derived from the theme border. Every CSS variable in
 * global.css appears in this table at least once.
 */
export const MOBILE_THEME_VARIABLES: Readonly<Record<ThemeColorRole, ReadonlyArray<string>>> = {
  canvas: ["--color-screen", "--color-status-bar"],
  chrome: ["--color-header"],
  toolbar: ["--color-sheet"],
  toolbarForeground: ["--color-wordmark"],
  toolbarBorder: ["--color-header-border"],
  toolbarControl: ["--color-glass-tint"],
  toolbarControlForeground: ["--color-foreground-secondary"],
  toolbarControlHover: ["--color-subtle-strong"],
  surface: ["--color-card-alt"],
  surfaceRaised: ["--color-card"],
  surfaceOverlay: [
    "--color-card-translucent",
    "--color-glass-surface",
    "--color-drawer",
    // Seeded here for the audit table; themeColorsToMobileCSSVariables
    // replaces it with the contrasting backdrop source below.
    "--color-backdrop",
    // The drawer has its own canonical sidebar role; the backdrop is derived
    // separately below so light themes do not turn modal dimming into a white
    // wash.
  ],
  text: ["--color-foreground", "--color-md-body", "--color-md-strong", "--color-icon"],
  textMuted: ["--color-foreground-secondary", "--color-md-code-text"],
  border: [
    "--color-border",
    "--color-border-subtle",
    "--color-separator",
    "--color-secondary-border",
    "--color-input-border",
    "--color-md-blockquote-border",
    "--color-md-hr",
    "--color-dot-separator",
    "--color-drawer-shadow",
    // The stylesheet has no separate shadow role; border is the least
    // surprising theme-derived fallback for the existing shadow utility.
    "--color-primary-shadow",
  ],
  input: ["--color-input"],
  focus: [],
  // `primary` is the app's main action token, so map it to the theme accent.
  accent: ["--color-primary", "--color-md-link", "--color-inline-skill-foreground"],
  accentForeground: ["--color-primary-foreground"],
  secondary: ["--color-secondary"],
  secondaryForeground: ["--color-secondary-foreground"],
  muted: ["--color-subtle"],
  mutedForeground: ["--color-foreground-muted"],
  placeholder: [
    "--color-foreground-tertiary",
    "--color-placeholder",
    "--color-icon-subtle",
    "--color-chevron",
  ],
  secondaryLabel: [],
  iconMuted: ["--color-icon-muted"],
  error: ["--color-danger-border"],
  errorForeground: ["--color-danger-foreground"],
  errorSurface: ["--color-danger"],
  warning: ["--color-inline-skill-border"],
  warningForeground: [],
  warningSurface: [],
  update: ["--color-switch-active"],
  updateForeground: [],
  updateSurface: ["--color-subtle-strong"],
  accentSurface: ["--color-inline-skill-background", "--color-md-blockquote-bg"],
  accentSurfaceForeground: ["--color-inline-skill-border"],
  messageSurface: ["--color-md-user-code-bg", "--color-md-user-fence-bg"],
  messageForeground: ["--color-md-user-code-text", "--color-md-user-fence-text"],
  messageAction: ["--color-user-bubble"],
  messageActionForeground: ["--color-user-bubble-foreground"],
  messageActionHover: ["--color-user-bubble-foreground-muted"],
  codeBackground: ["--color-md-code-bg"],
  codeForeground: [],
  // These dedicated variables keep canonical sidebar roles isolated from
  // screen-wide foreground/action tokens when a theme intentionally gives the
  // sidebar a different tone.
  sidebar: ["--color-sidebar-background"],
  sidebarForeground: ["--color-sidebar-foreground"],
  sidebarMutedForeground: ["--color-sidebar-muted-foreground"],
  sidebarControlSurface: ["--color-sidebar-control", "--color-sidebar-search"],
  sidebarRowHover: ["--color-sidebar-row-hover"],
  sidebarRowActive: ["--color-sidebar-row-active"],
  sidebarRowSelected: ["--color-sidebar-row-selected"],
  sidebarBorder: ["--color-sidebar-border"],
  terminalBackground: [],
  terminalForeground: [],
  terminalCursor: [],
  terminalSelection: [],
  terminalScrollbar: [],
  terminalScrollbarHover: [],
};

/** Inverse lookup used by tests and by future native token audits. */
export const MOBILE_THEME_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  Object.values(MOBILE_THEME_VARIABLES).flat(),
);

/**
 * These variables are translucent in global.css. Canonical theme roles are
 * opaque hex colors, so preserve the mobile compositing behavior while still
 * deriving their hue from the selected palette. Tuple order is light, dark.
 */
const MOBILE_THEME_VARIABLE_ALPHA: Readonly<Record<string, readonly [number, number]>> = {
  "--color-sheet": [0.98, 0.98],
  "--color-card-translucent": [0.8, 0.8],
  "--color-border-subtle": [0.06, 0.04],
  "--color-separator": [0.04, 0.03],
  "--color-subtle": [0.04, 0.04],
  "--color-subtle-strong": [0.08, 0.08],
  "--color-inline-skill-background": [0.12, 0.12],
  "--color-inline-skill-border": [0.25, 0.25],
  "--color-primary-shadow": [0.18, 0.22],
  "--color-secondary-border": [0.08, 0.06],
  "--color-danger-border": [0.12, 0.18],
  "--color-input-border": [0.1, 0.08],
  "--color-sidebar-search": [0.12, 0.24],
  "--color-header": [0.97, 0.97],
  "--color-header-border": [0.06, 0.06],
  "--color-glass-surface": [0.72, 0.78],
  "--color-glass-tint": [0.18, 0.24],
  "--color-md-blockquote-border": [0.08, 0.1],
  "--color-md-blockquote-bg": [0.02, 0.03],
  "--color-md-code-bg": [0.04, 0.06],
  "--color-md-user-code-bg": [0.22, 0.18],
  "--color-md-user-fence-bg": [0.16, 0.28],
  "--color-md-hr": [0.08, 0.08],
  "--color-user-bubble-foreground-muted": [0.78, 0.78],
  "--color-drawer": [0.99, 0.99],
  "--color-drawer-shadow": [0.12, 0.32],
  "--color-dot-separator": [0.2, 0.2],
  "--color-chevron": [0.2, 0.2],
};

function themeColorWithAlpha(value: string, alpha: number): string {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match?.[1]) return value;
  const raw =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((part) => part.repeat(2))
          .join("")
      : match[1];
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function isDarkThemeCanvas(value: string): boolean {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match?.[1]) return false;
  const raw =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((part) => part.repeat(2))
          .join("")
      : match[1];
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 128;
}

export function themeColorsToMobileCSSVariables(colors: ThemeColors): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const role of Object.keys(MOBILE_THEME_VARIABLES) as Array<ThemeColorRole>) {
    const color = colors[role];
    for (const variable of MOBILE_THEME_VARIABLES[role]) {
      variables[variable] = color;
    }
  }

  const dark = isDarkThemeCanvas(colors.canvas);
  // A light surfaceOverlay is intentionally not suitable for a modal
  // backdrop. Use the dark canvas in dark mode and the contrasting text role
  // in light mode, with a slightly stronger dark-mode veil.
  variables["--color-backdrop"] = themeColorWithAlpha(
    dark ? colors.canvas : colors.text,
    dark ? 0.48 : 0.22,
  );
  for (const [variable, [lightAlpha, darkAlpha]] of Object.entries(MOBILE_THEME_VARIABLE_ALPHA)) {
    const source = variable === "--color-primary-shadow" ? colors.text : variables[variable];
    if (source !== undefined) {
      variables[variable] = themeColorWithAlpha(source, dark ? darkAlpha : lightAlpha);
    }
  }

  return variables;
}

/**
 * Literal values from global.css, kept as the active reset target after a
 * user clears a theme. Fresh installs never inject these values, preserving
 * the stylesheet as the source of truth at rest.
 */
const MOBILE_DEFAULT_CSS_VARIABLES: Readonly<
  Record<"light" | "dark", Readonly<Record<string, string>>>
> = {
  light: {
    "--color-screen": "#f2f2f7",
    "--color-sheet": "rgba(242, 242, 247, 0.98)",
    "--color-card": "#ffffff",
    "--color-card-alt": "#f5f5f5",
    "--color-card-translucent": "rgba(255, 255, 255, 0.8)",
    "--color-foreground": "#262626",
    "--color-foreground-secondary": "#525252",
    "--color-foreground-muted": "#737373",
    "--color-foreground-tertiary": "#8e8e93",
    "--color-border": "rgba(0, 0, 0, 0.08)",
    "--color-border-subtle": "rgba(0, 0, 0, 0.06)",
    "--color-separator": "rgba(0, 0, 0, 0.04)",
    "--color-subtle": "rgba(0, 0, 0, 0.04)",
    "--color-subtle-strong": "rgba(0, 0, 0, 0.08)",
    "--color-inline-skill-background": "rgba(217, 70, 239, 0.12)",
    "--color-inline-skill-border": "rgba(217, 70, 239, 0.25)",
    "--color-inline-skill-foreground": "#a21caf",
    "--color-primary": "#262626",
    "--color-primary-foreground": "#ffffff",
    "--color-primary-shadow": "rgba(0, 0, 0, 0.18)",
    "--color-secondary": "#ffffff",
    "--color-secondary-foreground": "#262626",
    "--color-secondary-border": "rgba(0, 0, 0, 0.08)",
    "--color-switch-active": "#34c759",
    "--color-danger": "#fef2f2",
    "--color-danger-border": "rgba(239, 68, 68, 0.12)",
    "--color-danger-foreground": "#dc2626",
    "--color-input": "#ffffff",
    "--color-input-border": "rgba(0, 0, 0, 0.1)",
    "--color-sidebar-search": "rgba(118, 118, 128, 0.12)",
    "--color-sidebar-background": "rgba(255, 255, 255, 0.99)",
    "--color-sidebar-foreground": "#262626",
    "--color-sidebar-muted-foreground": "#737373",
    "--color-sidebar-control": "rgba(118, 118, 128, 0.12)",
    "--color-sidebar-row-hover": "rgba(0, 0, 0, 0.04)",
    "--color-sidebar-row-active": "rgba(0, 0, 0, 0.08)",
    "--color-sidebar-row-selected": "#007aff",
    "--color-sidebar-border": "rgba(0, 0, 0, 0.08)",
    "--color-placeholder": "#a3a3a3",
    "--color-icon": "#262626",
    "--color-icon-muted": "#525252",
    "--color-icon-subtle": "#a3a3a3",
    "--color-header": "rgba(255, 255, 255, 0.97)",
    "--color-header-border": "rgba(0, 0, 0, 0.06)",
    "--color-glass-surface": "rgba(255, 255, 255, 0.72)",
    "--color-glass-tint": "rgba(255, 255, 255, 0.18)",
    "--color-status-bar": "#f2f2f7",
    "--color-md-body": "#111111",
    "--color-md-strong": "#000000",
    "--color-md-link": "#2563eb",
    "--color-md-blockquote-border": "rgba(0, 0, 0, 0.08)",
    "--color-md-blockquote-bg": "rgba(0, 0, 0, 0.02)",
    "--color-md-code-bg": "rgba(0, 0, 0, 0.04)",
    "--color-md-code-text": "#262626",
    "--color-md-user-code-bg": "rgba(255, 255, 255, 0.22)",
    "--color-md-user-code-text": "#ffffff",
    "--color-md-user-fence-bg": "rgba(0, 0, 0, 0.16)",
    "--color-md-user-fence-text": "#ffffff",
    "--color-md-hr": "rgba(0, 0, 0, 0.08)",
    "--color-user-bubble": "#007aff",
    "--color-user-bubble-foreground": "#ffffff",
    "--color-user-bubble-foreground-muted": "rgba(255, 255, 255, 0.78)",
    "--color-backdrop": "rgba(0, 0, 0, 0.22)",
    "--color-drawer": "rgba(255, 255, 255, 0.99)",
    "--color-drawer-shadow": "rgba(0, 0, 0, 0.12)",
    "--color-dot-separator": "rgba(0, 0, 0, 0.2)",
    "--color-wordmark": "#262626",
    "--color-chevron": "rgba(0, 0, 0, 0.2)",
  },
  dark: {
    "--color-screen": "#0a0a0a",
    "--color-sheet": "rgba(14, 14, 14, 0.98)",
    "--color-card": "#171717",
    "--color-card-alt": "#1c1c1c",
    "--color-card-translucent": "rgba(17, 17, 17, 0.8)",
    "--color-foreground": "#f5f5f5",
    "--color-foreground-secondary": "#a3a3a3",
    "--color-foreground-muted": "#8e8e93",
    "--color-foreground-tertiary": "#636366",
    "--color-border": "rgba(255, 255, 255, 0.06)",
    "--color-border-subtle": "rgba(255, 255, 255, 0.04)",
    "--color-separator": "rgba(255, 255, 255, 0.03)",
    "--color-subtle": "rgba(255, 255, 255, 0.04)",
    "--color-subtle-strong": "rgba(255, 255, 255, 0.08)",
    "--color-inline-skill-background": "rgba(217, 70, 239, 0.12)",
    "--color-inline-skill-border": "rgba(217, 70, 239, 0.25)",
    "--color-inline-skill-foreground": "#f0abfc",
    "--color-primary": "#f5f5f5",
    "--color-primary-foreground": "#0a0a0a",
    "--color-primary-shadow": "rgba(0, 0, 0, 0.22)",
    "--color-secondary": "rgba(255, 255, 255, 0.04)",
    "--color-secondary-foreground": "#f5f5f5",
    "--color-secondary-border": "rgba(255, 255, 255, 0.06)",
    "--color-switch-active": "#30d158",
    "--color-danger": "rgba(239, 68, 68, 0.14)",
    "--color-danger-border": "rgba(248, 113, 113, 0.18)",
    "--color-danger-foreground": "#fca5a5",
    "--color-input": "#141414",
    "--color-input-border": "rgba(255, 255, 255, 0.08)",
    "--color-sidebar-search": "rgba(118, 118, 128, 0.24)",
    "--color-sidebar-background": "rgba(14, 14, 14, 0.99)",
    "--color-sidebar-foreground": "#f5f5f5",
    "--color-sidebar-muted-foreground": "#8e8e93",
    "--color-sidebar-control": "rgba(118, 118, 128, 0.24)",
    "--color-sidebar-row-hover": "rgba(255, 255, 255, 0.04)",
    "--color-sidebar-row-active": "rgba(255, 255, 255, 0.08)",
    "--color-sidebar-row-selected": "#0a84ff",
    "--color-sidebar-border": "rgba(255, 255, 255, 0.06)",
    "--color-placeholder": "#8e8e93",
    "--color-icon": "#f5f5f5",
    "--color-icon-muted": "#a3a3a3",
    "--color-icon-subtle": "#8e8e93",
    "--color-header": "rgba(10, 10, 10, 0.97)",
    "--color-header-border": "rgba(255, 255, 255, 0.06)",
    "--color-glass-surface": "rgba(23, 23, 23, 0.78)",
    "--color-glass-tint": "rgba(23, 23, 23, 0.24)",
    "--color-status-bar": "#0a0a0a",
    "--color-md-body": "#e5e5e5",
    "--color-md-strong": "#f5f5f5",
    "--color-md-link": "#60a5fa",
    "--color-md-blockquote-border": "rgba(255, 255, 255, 0.1)",
    "--color-md-blockquote-bg": "rgba(255, 255, 255, 0.03)",
    "--color-md-code-bg": "rgba(255, 255, 255, 0.06)",
    "--color-md-code-text": "#e5e5e5",
    "--color-md-user-code-bg": "rgba(255, 255, 255, 0.18)",
    "--color-md-user-code-text": "#ffffff",
    "--color-md-user-fence-bg": "rgba(0, 0, 0, 0.28)",
    "--color-md-user-fence-text": "#ffffff",
    "--color-md-hr": "rgba(255, 255, 255, 0.08)",
    "--color-user-bubble": "#0a84ff",
    "--color-user-bubble-foreground": "#ffffff",
    "--color-user-bubble-foreground-muted": "rgba(255, 255, 255, 0.78)",
    "--color-backdrop": "rgba(0, 0, 0, 0.48)",
    "--color-drawer": "rgba(14, 14, 14, 0.99)",
    "--color-drawer-shadow": "rgba(0, 0, 0, 0.32)",
    "--color-dot-separator": "rgba(255, 255, 255, 0.2)",
    "--color-wordmark": "#f5f5f5",
    "--color-chevron": "rgba(255, 255, 255, 0.2)",
  },
};

export function getDefaultMobileCSSVariables(
  mode: "light" | "dark",
): Readonly<Record<string, string>> {
  return MOBILE_DEFAULT_CSS_VARIABLES[mode];
}

/**
 * Small semantic helpers for native surfaces. Keeping these beside the CSS
 * bridge makes derivations auditable when a new mobile surface is added.
 */
export function getMobileThemeRole(colors: ThemeColors, role: ThemeColorRole): string {
  return colors[role];
}
