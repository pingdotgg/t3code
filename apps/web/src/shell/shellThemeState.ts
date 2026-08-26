import type { ShellThemeState } from "@t3tools/contracts";

/** Theme role → the semantic CSS variable the page paints it with. */
export const SHELL_THEME_ROLE_VARIABLES: Readonly<Record<string, string>> = {
  canvas: "--background",
  chrome: "--app-chrome-background",
  toolbar: "--toolbar-background",
  toolbarForeground: "--toolbar-foreground",
  toolbarBorder: "--toolbar-border",
  toolbarControl: "--toolbar-control",
  toolbarControlForeground: "--toolbar-control-foreground",
  toolbarControlHover: "--toolbar-control-hover",
  surface: "--card",
  surfaceRaised: "--surface-raised",
  surfaceOverlay: "--popover",
  text: "--foreground",
  textMuted: "--muted-foreground",
  border: "--border",
  input: "--input",
  focus: "--ring",
  accent: "--primary",
  accentForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  placeholder: "--placeholder",
  secondaryLabel: "--secondary-label",
  iconMuted: "--icon-muted",
  error: "--destructive",
  errorForeground: "--destructive-foreground",
  errorSurface: "--error-surface",
  warning: "--warning",
  warningForeground: "--warning-foreground",
  warningSurface: "--warning-surface",
  update: "--update",
  updateForeground: "--update-foreground",
  updateSurface: "--update-surface",
  accentSurface: "--accent",
  accentSurfaceForeground: "--accent-foreground",
  messageSurface: "--message-surface",
  messageForeground: "--message-foreground",
  messageAction: "--message-action",
  messageActionForeground: "--message-action-foreground",
  messageActionHover: "--message-action-hover",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarMutedForeground: "--sidebar-muted-foreground",
  sidebarControlSurface: "--sidebar-control-surface",
  sidebarRowHover: "--sidebar-row-hover",
  sidebarRowActive: "--sidebar-row-active",
  sidebarRowSelected: "--sidebar-row-selected",
  sidebarBorder: "--sidebar-border",
  success: "--success",
  info: "--info",
};

function toHex(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}

/**
 * Resolves any CSS colour (oklch, color-mix, var chains…) to `#rrggbb[aa]` by
 * painting it: the canvas converts to sRGB for us, which QML can parse.
 */
export function createCssColorResolver(): (value: string) => string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return (value) => {
    const trimmed = value.trim();
    if (!context || trimmed.length === 0) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = trimmed;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
    return a === 255
      ? `#${toHex(r)}${toHex(g)}${toHex(b)}`
      : `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
  };
}

export function readShellThemeState(root: HTMLElement): ShellThemeState {
  const computed = getComputedStyle(root);
  const resolve = createCssColorResolver();
  const colors: Record<string, string> = {};
  for (const [role, variable] of Object.entries(SHELL_THEME_ROLE_VARIABLES)) {
    const raw = computed.getPropertyValue(variable);
    const hex = resolve(raw);
    if (hex !== null) colors[role] = hex;
  }
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.borderRadius = "var(--radius)";
  root.appendChild(probe);
  const radius = Number.parseFloat(getComputedStyle(probe).borderTopLeftRadius) || 0;
  probe.remove();
  const fontUi = computed.getPropertyValue("--font-sans").trim();
  const fontMono = computed.getPropertyValue("--font-mono").trim();
  return {
    id: root.dataset.themeId ?? null,
    appearance: root.classList.contains("dark") ? "dark" : "light",
    colors,
    radius,
    fontUi: fontUi.length > 0 ? fontUi : null,
    fontMono: fontMono.length > 0 ? fontMono : null,
  };
}
