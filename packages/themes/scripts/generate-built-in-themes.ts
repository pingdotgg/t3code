import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createManagedThemeColors,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "../src/index.ts";
import { PORTED_THEME_SEEDS, type PortedThemeSeed } from "./portedSeeds.ts";

declare const Bun: {
  file(path: string | URL): { text(): Promise<string> };
  write(path: string | URL, data: string): Promise<number>;
};

const BUILT_IN_THEME_FILE = fileURLToPath(new URL("../src/builtInThemes.ts", import.meta.url));

const PORTED_THEME_MARKER = "export const AURORA_THEME: ThemeDefinition = {";
const CODE_COLORS_MARKER = "export const T3_CODE_LIGHT_THEME_COLORS: ThemeColors = {";
const REGISTRY_MARKER =
  "export const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = [";

// The five original themes and the standard code palettes remain literal source
// in the generated module. Hashing their template sections makes drift fail
// verification instead of allowing the generator to silently copy it forward.
const EXPECTED_TEMPLATE_HASHES = {
  prefix: "eb9bd04a0c72cb76ad39fe9fc243a916acf3bbd421c179c0ff7b1c531a18970f",
  codeColors: "dfa888f5ccd44d22d23a2830c62ce94738af46c484fd45674d5f5ba0a0252355",
} as const;

const STANDARD_THEME_CONSTANTS = [
  "T3_CHAT_THEME",
  "GROVE_THEME",
  "OCEAN_THEME",
  "EMBER_THEME",
  "IRIS_THEME",
] as const;

const PORTED_THEME_IDS = Object.keys(PORTED_THEME_SEEDS).sort();

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

function actionColors(
  action: string,
): Pick<ThemeColors, "messageAction" | "messageActionForeground" | "messageActionHover"> {
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

function applyTerminal(colors: ThemeColors, terminal: PortedThemeSeed["terminal"]): ThemeColors {
  if (contrast(terminal.foreground, terminal.background) < 4.5) return colors;
  return {
    ...colors,
    terminalBackground: terminal.background,
    terminalForeground: terminal.foreground,
    terminalCursor: terminal.cursor,
    terminalSelection: terminal.selection,
  };
}

export function buildPortedTheme(
  id: string,
  seed: Readonly<{ label: string; light: PortedThemeSeed; dark: PortedThemeSeed }>,
): ThemeDefinition {
  const buildMode = (appearance: ThemeAppearance, modeSeed: PortedThemeSeed): ThemeColors =>
    applyTerminal(
      {
        ...createManagedThemeColors(appearance, modeSeed.background, modeSeed.accent, {
          exactSeeds: true,
        }),
        ...actionColors(modeSeed.action),
      },
      modeSeed.terminal,
    );

  return {
    id,
    label: seed.label,
    appearance: "light",
    colors: buildMode("light", seed.light),
    variants: { dark: buildMode("dark", seed.dark) },
  };
}

function themeConstantName(id: string): string {
  return `${id.replaceAll("-", "_").toUpperCase()}_THEME`;
}

function serialize(value: unknown, indent = 0): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";

  const indentation = " ".repeat(indent);
  const childIndentation = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    return `[
${value.map((entry) => `${childIndentation}${serialize(entry, indent + 2)},`).join("\n")}
${indentation}]`;
  }
  if (typeof value !== "object") {
    throw new Error(`Cannot serialize ${typeof value} in generated theme source.`);
  }

  const entries = Object.entries(value);
  return `{
${entries
  .map(([key, entry]) => `${childIndentation}${key}: ${serialize(entry, indent + 2)},`)
  .join("\n")}
${indentation}}`;
}

function renderTheme(name: string, theme: ThemeDefinition): string {
  return `export const ${name}: ThemeDefinition = ${serialize(theme)};`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitTemplate(source: string): {
  prefix: string;
  codeColors: string;
} {
  const portedStart = source.indexOf(PORTED_THEME_MARKER);
  const codeColorsStart = source.indexOf(CODE_COLORS_MARKER);
  const registryStart = source.indexOf(REGISTRY_MARKER);
  if (portedStart < 0 || codeColorsStart < 0 || registryStart < 0) {
    throw new Error("Could not find generated theme sections in builtInThemes.ts.");
  }

  const prefix = source.slice(0, portedStart);
  const codeColors = source.slice(codeColorsStart, registryStart);
  if (hash(prefix) !== EXPECTED_TEMPLATE_HASHES.prefix) {
    throw new Error(
      "The original built-in theme template has drifted; update the generator template.",
    );
  }
  if (hash(codeColors) !== EXPECTED_TEMPLATE_HASHES.codeColors) {
    throw new Error(
      "The standard code palette template has drifted; update the generator template.",
    );
  }
  return { prefix, codeColors };
}

function renderRegistry(): string {
  const constants = [...STANDARD_THEME_CONSTANTS, ...PORTED_THEME_IDS.map(themeConstantName)];
  return `${REGISTRY_MARKER}
${constants.map((constant) => `  ${constant},`).join("\n")}
];
`;
}

export async function regenerateBuiltInThemesSource(): Promise<string> {
  const template = await Bun.file(BUILT_IN_THEME_FILE).text();
  const { prefix, codeColors } = splitTemplate(template);
  const portedThemes = PORTED_THEME_IDS.map((id) =>
    renderTheme(themeConstantName(id), buildPortedTheme(id, PORTED_THEME_SEEDS[id]!)),
  ).join("\n\n");
  return `${prefix}${portedThemes}\n\n${codeColors}${renderRegistry()}`;
}

async function main(): Promise<void> {
  const generated = await regenerateBuiltInThemesSource();
  if (process.argv.includes("--write")) {
    await Bun.write(BUILT_IN_THEME_FILE, generated);
    return;
  }
  process.stdout.write(generated);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
