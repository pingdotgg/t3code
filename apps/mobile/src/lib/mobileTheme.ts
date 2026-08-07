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
    "--color-backdrop",
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
  sidebar: [],
  sidebarForeground: [],
  sidebarMutedForeground: [],
  sidebarControlSurface: ["--color-sidebar-search"],
  sidebarRowHover: [],
  sidebarRowActive: [],
  sidebarRowSelected: [],
  sidebarBorder: [],
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
  "--color-backdrop": [0.22, 0.48],
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
  for (const [variable, [lightAlpha, darkAlpha]] of Object.entries(MOBILE_THEME_VARIABLE_ALPHA)) {
    const source = variable === "--color-primary-shadow" ? colors.text : variables[variable];
    if (source !== undefined) {
      variables[variable] = themeColorWithAlpha(source, dark ? darkAlpha : lightAlpha);
    }
  }

  return variables;
}

/**
 * Small semantic helpers for native surfaces. Keeping these beside the CSS
 * bridge makes derivations auditable when a new mobile surface is added.
 */
export function getMobileThemeRole(colors: ThemeColors, role: ThemeColorRole): string {
  return colors[role];
}
