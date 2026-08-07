import {
  BUILT_IN_THEME_DEFINITIONS,
  createManagedThemeColors,
  getThemeDefinition,
  THEME_COLOR_ROLES,
} from "../src/index.ts";
import { regenerateBuiltInThemesSource } from "./generate-built-in-themes.ts";
import { PORTED_THEME_SEEDS } from "./portedSeeds.ts";

declare const Bun: {
  file(path: string | URL): { text(): Promise<string> };
};

const BUILT_IN_THEME_FILE = new URL("../src/builtInThemes.ts", import.meta.url);

function rgb(value: string): ReadonlyArray<number> {
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index + 1, index + 3), 16));
}

function luminance(value: string): number {
  return rgb(value)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(first: string, second: string, amount: number): string {
  const a = rgb(first);
  const b = rgb(second);
  return `#${a
    .map((channel, index) =>
      Math.round(channel + (b[index]! - channel) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function actionColors(action: string) {
  const light = "#fffaff";
  const dark = "#241523";
  const lightContrast = contrast(action, light);
  const darkContrast = contrast(action, dark);
  const foreground =
    Math.max(lightContrast, darkContrast) >= 4.5
      ? lightContrast >= darkContrast
        ? light
        : dark
      : contrast(action, "#ffffff") >= contrast(action, "#000000")
        ? "#ffffff"
        : "#000000";
  return {
    messageAction: action,
    messageActionForeground: foreground,
    messageActionHover: mix(
      action,
      foreground === light || foreground === "#ffffff" ? "#000000" : "#ffffff",
      0.12,
    ),
  };
}

function applyTerminal(
  colors: Record<string, string>,
  terminal: Readonly<{
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
  }>,
): Record<string, string> {
  if (contrast(terminal.foreground, terminal.background) < 4.5) return colors;
  return {
    ...colors,
    terminalBackground: terminal.background,
    terminalForeground: terminal.foreground,
    terminalCursor: terminal.cursor,
    terminalSelection: terminal.selection,
  };
}

if (BUILT_IN_THEME_DEFINITIONS.length !== 29) {
  throw new Error(`Expected 29 built-in themes, found ${BUILT_IN_THEME_DEFINITIONS.length}.`);
}

const checkedInSource = await Bun.file(BUILT_IN_THEME_FILE).text();
const regeneratedSource = await regenerateBuiltInThemesSource();
if (checkedInSource !== regeneratedSource) {
  throw new Error(
    "builtInThemes.ts is not byte-for-byte identical to the deterministic generated output. Run the generator with --write.",
  );
}

for (const [id, seed] of Object.entries(PORTED_THEME_SEEDS)) {
  const theme = getThemeDefinition(id);
  if (!theme) throw new Error(`Missing generated theme ${id}.`);
  if (theme.appearance !== "light" || !theme.variants?.dark) {
    throw new Error(`${id} must have a light base and dark variant.`);
  }
  for (const mode of ["light", "dark"] as const) {
    const modeSeed = seed[mode];
    const generated = applyTerminal(
      {
        ...createManagedThemeColors(mode, modeSeed.background, modeSeed.accent, {
          exactSeeds: true,
        }),
        ...actionColors(modeSeed.action),
      },
      modeSeed.terminal,
    );
    const actual = mode === "light" ? theme.colors : theme.variants.dark;
    if (JSON.stringify(actual) !== JSON.stringify(generated)) {
      throw new Error(`Generated palette drifted for ${id}/${mode}.`);
    }
    if (Object.keys(actual).length !== THEME_COLOR_ROLES.length) {
      throw new Error(`${id}/${mode} does not contain all ${THEME_COLOR_ROLES.length} roles.`);
    }
  }
}

void Object.keys(PORTED_THEME_SEEDS).length;
