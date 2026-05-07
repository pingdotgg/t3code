import type { ThemeKind } from "@t3tools/contracts";

export const EXTERNAL_APP_THEME_VARIABLES = [
  "--background",
  "--app-chrome-background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--info",
  "--info-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--terminal-background",
  "--terminal-foreground",
  "--terminal-cursor",
  "--terminal-selection-background",
  "--diff-inserted",
  "--diff-removed",
  "--chat-request-background",
  "--chat-request-border",
] as const;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const LIGHT_FALLBACKS = {
  background: "#ffffff",
  foreground: "#262626",
  primary: "#315cec",
  border: "#00000014",
  destructive: "#ef4444",
  info: "#3b82f6",
  success: "#10b981",
  warning: "#f59e0b",
};

const DARK_FALLBACKS = {
  background: "#111111",
  foreground: "#f5f5f5",
  primary: "#6384ff",
  border: "#ffffff14",
  destructive: "#f87171",
  info: "#60a5fa",
  success: "#34d399",
  warning: "#fbbf24",
};

export function isDarkThemeKind(kind: ThemeKind) {
  return kind === "dark" || kind === "high-contrast-dark";
}

export function normalizeCssColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function normalizeThemeColors(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const colors: Record<string, string> = {};
  for (const [key, rawColor] of Object.entries(value)) {
    const color = normalizeCssColor(rawColor);
    if (color) colors[key] = color;
  }
  return colors;
}

function firstColor(colors: Record<string, string>, keys: readonly string[]) {
  for (const key of keys) {
    const color = colors[key];
    if (color) return color;
  }
  return null;
}

function expandHexChannel(value: string) {
  return value.length === 1 ? `${value}${value}` : value;
}

function readableForeground(background: string) {
  const normalized = normalizeCssColor(background);
  if (!normalized) return "#ffffff";
  const hex = normalized.slice(1);
  const rgb =
    hex.length === 3 || hex.length === 4
      ? [hex.slice(0, 1), hex.slice(1, 2), hex.slice(2, 3)].map((channel) =>
          parseInt(expandHexChannel(channel), 16),
        )
      : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((channel) => parseInt(channel, 16));
  const [red = 0, green = 0, blue = 0] = rgb;
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.55 ? "#111111" : "#ffffff";
}

function mix(base: string, foreground: string, percentage: number) {
  return `color-mix(in srgb, ${base} ${percentage}%, ${foreground})`;
}

export function mapVscodeColorsToAppVariables(input: {
  readonly kind: ThemeKind;
  readonly colors: Record<string, string>;
}): Record<string, string> {
  const fallback = isDarkThemeKind(input.kind) ? DARK_FALLBACKS : LIGHT_FALLBACKS;
  const colors = input.colors;
  const background =
    firstColor(colors, ["editor.background", "sideBar.background"]) ?? fallback.background;
  const foreground = firstColor(colors, ["foreground", "editor.foreground"]) ?? fallback.foreground;
  const primary =
    firstColor(colors, ["button.background", "activityBarBadge.background", "focusBorder"]) ??
    fallback.primary;
  const border =
    firstColor(colors, ["widget.border", "sideBar.border", "editorGroup.border", "panel.border"]) ??
    fallback.border;
  const accent =
    firstColor(colors, [
      "list.activeSelectionBackground",
      "list.hoverBackground",
      "toolbar.hoverBackground",
    ]) ?? mix(background, foreground, 92);
  const destructive =
    firstColor(colors, [
      "errorForeground",
      "editorError.foreground",
      "notificationsErrorIcon.foreground",
    ]) ?? fallback.destructive;

  return {
    "--background": background,
    "--app-chrome-background":
      firstColor(colors, ["titleBar.activeBackground", "sideBar.background"]) ?? background,
    "--foreground": foreground,
    "--card":
      firstColor(colors, ["editorGroupHeader.tabsBackground", "sideBarSectionHeader.background"]) ??
      mix(background, foreground, 94),
    "--card-foreground": foreground,
    "--popover":
      firstColor(colors, [
        "quickInput.background",
        "editorWidget.background",
        "dropdown.background",
      ]) ?? mix(background, foreground, 96),
    "--popover-foreground":
      firstColor(colors, [
        "quickInput.foreground",
        "editorWidget.foreground",
        "dropdown.foreground",
        "foreground",
      ]) ?? foreground,
    "--primary": primary,
    "--primary-foreground":
      firstColor(colors, ["button.foreground"]) ?? readableForeground(primary),
    "--secondary":
      firstColor(colors, ["button.secondaryBackground", "badge.background"]) ??
      mix(background, foreground, 90),
    "--secondary-foreground":
      firstColor(colors, ["button.secondaryForeground", "foreground"]) ?? foreground,
    "--muted":
      firstColor(colors, ["editor.lineHighlightBackground", "list.hoverBackground"]) ??
      mix(background, foreground, 92),
    "--muted-foreground":
      firstColor(colors, ["descriptionForeground", "disabledForeground"]) ??
      mix(foreground, background, 66),
    "--accent": accent,
    "--accent-foreground":
      firstColor(colors, ["list.activeSelectionForeground", "list.hoverForeground"]) ?? foreground,
    "--destructive": destructive,
    "--destructive-foreground":
      firstColor(colors, ["errorForeground", "editorError.foreground"]) ??
      readableForeground(destructive),
    "--border": border,
    "--input":
      firstColor(colors, [
        "input.background",
        "dropdown.background",
        "settings.textInputBackground",
      ]) ?? mix(background, foreground, 90),
    "--ring": firstColor(colors, ["focusBorder", "inputOption.activeBorder"]) ?? primary,
    "--info": firstColor(colors, ["textLink.foreground", "terminal.ansiBlue"]) ?? fallback.info,
    "--info-foreground":
      firstColor(colors, ["textLink.foreground", "terminal.ansiBrightBlue"]) ?? fallback.info,
    "--success":
      firstColor(colors, ["gitDecoration.addedResourceForeground", "terminal.ansiGreen"]) ??
      fallback.success,
    "--success-foreground":
      firstColor(colors, ["gitDecoration.addedResourceForeground", "terminal.ansiBrightGreen"]) ??
      fallback.success,
    "--warning":
      firstColor(colors, ["notificationsWarningIcon.foreground", "terminal.ansiYellow"]) ??
      fallback.warning,
    "--warning-foreground":
      firstColor(colors, ["notificationsWarningIcon.foreground", "terminal.ansiBrightYellow"]) ??
      fallback.warning,
    "--sidebar": firstColor(colors, ["sideBar.background", "activityBar.background"]) ?? background,
    "--sidebar-foreground": firstColor(colors, ["sideBar.foreground", "foreground"]) ?? foreground,
    "--sidebar-accent":
      firstColor(colors, ["list.activeSelectionBackground", "activityBar.activeBackground"]) ??
      accent,
    "--sidebar-accent-foreground":
      firstColor(colors, ["list.activeSelectionForeground", "sideBar.foreground"]) ?? foreground,
    "--sidebar-border": firstColor(colors, ["sideBar.border", "activityBar.border"]) ?? border,
    "--terminal-background":
      firstColor(colors, ["terminal.background", "panel.background"]) ?? background,
    "--terminal-foreground":
      firstColor(colors, ["terminal.foreground", "foreground"]) ?? foreground,
    "--terminal-cursor":
      firstColor(colors, ["terminalCursor.foreground", "editorCursor.foreground"]) ?? primary,
    "--terminal-selection-background":
      firstColor(colors, ["terminal.selectionBackground", "editor.selectionBackground"]) ??
      `color-mix(in srgb, ${primary} 24%, transparent)`,
    "--diff-inserted":
      firstColor(colors, [
        "diffEditor.insertedTextBackground",
        "gitDecoration.addedResourceForeground",
      ]) ?? fallback.success,
    "--diff-removed":
      firstColor(colors, [
        "diffEditor.removedTextBackground",
        "gitDecoration.deletedResourceForeground",
      ]) ?? fallback.destructive,
    "--chat-request-background":
      firstColor(colors, ["chat.requestBackground"]) ?? mix(background, foreground, 94),
    "--chat-request-border": firstColor(colors, ["chat.requestBorder"]) ?? border,
  };
}
