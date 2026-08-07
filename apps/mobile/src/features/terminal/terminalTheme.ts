import type { ThemeColors } from "@t3tools/themes";

export type TerminalAppearanceScheme = "light" | "dark";

export interface TerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly cursorForeground: string;
  readonly cursorBackground: string;
  readonly selectionBackground?: string;
  readonly palette: readonly string[];
}

const PIERRE_LIGHT_THEME: TerminalTheme = {
  // Pierre terminal palette with the app's shared screen background.
  background: "#f2f2f7",
  foreground: "#6C6C71",
  mutedForeground: "#8E8E95",
  border: "#eeeeef",
  cursorForeground: "#009fff",
  cursorBackground: "#f2f2f7",
  palette: [
    "#1F1F21",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#1F1F21",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
};

const PIERRE_DARK_THEME: TerminalTheme = {
  // Pierre terminal palette with the app's shared screen background.
  background: "#0a0a0a",
  foreground: "#adadb1",
  mutedForeground: "#8E8E95",
  border: "#2e2e30",
  cursorForeground: "#009fff",
  cursorBackground: "#0a0a0a",
  palette: [
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
};

export function getPierreTerminalTheme(scheme: TerminalAppearanceScheme): TerminalTheme {
  return scheme === "light" ? PIERRE_LIGHT_THEME : PIERRE_DARK_THEME;
}

/**
 * Keeps Pierre's ANSI-16 palette while replacing the four large terminal
 * surfaces with the canonical theme roles. The optional colors argument is
 * null for a fresh install, preserving the existing Pierre appearance.
 */
export function getTerminalThemeForColors(
  scheme: TerminalAppearanceScheme,
  colors: ThemeColors | null | undefined,
): TerminalTheme {
  const pierre = getPierreTerminalTheme(scheme);
  if (!colors) return pierre;

  return {
    ...pierre,
    background: colors.terminalBackground,
    foreground: colors.terminalForeground,
    mutedForeground: colors.textMuted,
    border: colors.border,
    cursorForeground: colors.terminalCursor,
    // Ghostty's cursor text uses the terminal foreground role, while the
    // cursor itself uses terminalCursor.
    cursorBackground: colors.terminalForeground,
    selectionBackground: colors.terminalSelection,
  };
}

export function buildGhosttyThemeConfig(theme: TerminalTheme): string {
  const lines = [
    `background = ${theme.background}`,
    `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursorForeground}`,
    `cursor-text = ${theme.cursorBackground}`,
  ];
  if (theme.selectionBackground) {
    lines.push(`selection-background = ${theme.selectionBackground}`);
  }

  for (const [index, color] of theme.palette.entries()) {
    lines.push(`palette = ${index}=${color}`);
  }

  return `${lines.join("\n")}\n`;
}
