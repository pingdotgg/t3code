import * as NodeOS from "node:os";

import type { ServerTerminalStyle, ServerTerminalThemeColors } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const PALETTE_SIZE = 16;

interface GhosttyConfigValues {
  readonly fontFamily: ReadonlyArray<string>;
  readonly fontSize: number | undefined;
  readonly theme: string | undefined;
  readonly colors: MutableThemeColors;
}

interface MutableThemeColors {
  background?: string | undefined;
  foreground?: string | undefined;
  cursor?: string | undefined;
  selectionBackground?: string | undefined;
  selectionForeground?: string | undefined;
  palette: Array<string>;
}

function emptyColors(): MutableThemeColors {
  return { palette: Array.from({ length: PALETTE_SIZE }, () => "") };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function applyColorEntry(colors: MutableThemeColors, key: string, value: string): void {
  switch (key) {
    case "background":
      colors.background = value;
      return;
    case "foreground":
      colors.foreground = value;
      return;
    case "cursor-color":
      colors.cursor = value;
      return;
    case "selection-background":
      colors.selectionBackground = value;
      return;
    case "selection-foreground":
      colors.selectionForeground = value;
      return;
    case "palette": {
      const match = value.match(/^(\d+)\s*=\s*(\S+)$/);
      if (!match) return;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) return;
      colors.palette[index] = match[2] ?? "";
      return;
    }
    default:
      return;
  }
}

/** Parse Ghostty's `key = value` config format, keeping only what the web terminal uses. */
export function parseGhosttyConfig(source: string): GhosttyConfigValues {
  const fontFamily: Array<string> = [];
  let fontSize: number | undefined;
  let theme: string | undefined;
  const colors = emptyColors();

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());

    switch (key) {
      case "font-family":
        // Repeated entries build a fallback chain; an empty value resets it.
        if (value.length === 0) {
          fontFamily.length = 0;
        } else {
          fontFamily.push(value);
        }
        break;
      case "font-size": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          fontSize = parsed;
        }
        break;
      }
      case "theme":
        theme = value.length > 0 ? value : undefined;
        break;
      default:
        applyColorEntry(colors, key, value);
        break;
    }
  }

  return { fontFamily, fontSize, theme, colors };
}

/** Split `theme = light:A,dark:B` into per-mode names; a bare name applies to both. */
export function splitThemeSelection(theme: string): { light?: string; dark?: string } {
  if (!theme.includes(":")) {
    return { light: theme, dark: theme };
  }
  const result: { light?: string; dark?: string } = {};
  for (const part of theme.split(",")) {
    const separatorIndex = part.indexOf(":");
    if (separatorIndex <= 0) continue;
    const mode = part.slice(0, separatorIndex).trim();
    const name = part.slice(separatorIndex + 1).trim();
    if (name.length === 0) continue;
    if (mode === "light") result.light = name;
    if (mode === "dark") result.dark = name;
  }
  return result;
}

function hasAnyColor(colors: MutableThemeColors): boolean {
  return (
    colors.background !== undefined ||
    colors.foreground !== undefined ||
    colors.cursor !== undefined ||
    colors.selectionBackground !== undefined ||
    colors.selectionForeground !== undefined ||
    colors.palette.some((entry) => entry.length > 0)
  );
}

function mergeColors(base: MutableThemeColors, override: MutableThemeColors): MutableThemeColors {
  return {
    background: override.background ?? base.background,
    foreground: override.foreground ?? base.foreground,
    cursor: override.cursor ?? base.cursor,
    selectionBackground: override.selectionBackground ?? base.selectionBackground,
    selectionForeground: override.selectionForeground ?? base.selectionForeground,
    palette: base.palette.map((entry, index) => {
      const overrideEntry = override.palette[index] ?? "";
      return overrideEntry.length > 0 ? overrideEntry : entry;
    }),
  };
}

function toThemeColors(colors: MutableThemeColors): ServerTerminalThemeColors | undefined {
  if (!hasAnyColor(colors)) return undefined;
  return {
    ...(colors.background !== undefined ? { background: colors.background } : {}),
    ...(colors.foreground !== undefined ? { foreground: colors.foreground } : {}),
    ...(colors.cursor !== undefined ? { cursor: colors.cursor } : {}),
    ...(colors.selectionBackground !== undefined
      ? { selectionBackground: colors.selectionBackground }
      : {}),
    ...(colors.selectionForeground !== undefined
      ? { selectionForeground: colors.selectionForeground }
      : {}),
    palette: colors.palette,
  };
}

// Bundled theme locations by platform: the macOS app bundle and the
// Linux system resource dirs documented by Ghostty.
const GHOSTTY_SYSTEM_THEME_DIRS = [
  "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
  "/usr/share/ghostty/themes",
  "/usr/local/share/ghostty/themes",
];

/**
 * Load terminal font and theme colors from the user's local Ghostty config.
 * Best effort by design: any missing file or parse problem yields `undefined`
 * so the client falls back to its built-in terminal appearance.
 */
export const loadGhosttyTerminalStyle: Effect.Effect<
  ServerTerminalStyle | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  // Per the XDG spec an empty XDG_CONFIG_HOME must be treated as unset.
  const xdgConfigHomeEnv = process.env["XDG_CONFIG_HOME"];
  const xdgConfigHome =
    xdgConfigHomeEnv !== undefined && xdgConfigHomeEnv.length > 0
      ? xdgConfigHomeEnv
      : path.join(home, ".config");

  const readFirstExisting = (candidates: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const candidate of candidates) {
        const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const content = yield* fs
          .readFileString(candidate)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (content !== undefined) return content;
      }
      return undefined;
    });

  const configSource = yield* readFirstExisting([
    path.join(xdgConfigHome, "ghostty", "config"),
    path.join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
  ]);
  if (configSource === undefined) return undefined;

  const config = parseGhosttyConfig(configSource);

  const loadThemeColors = (themeName: string) =>
    Effect.gen(function* () {
      const themeSource = yield* readFirstExisting([
        path.join(xdgConfigHome, "ghostty", "themes", themeName),
        ...GHOSTTY_SYSTEM_THEME_DIRS.map((dir) => dir + "/" + themeName),
      ]);
      if (themeSource === undefined) return emptyColors();
      return parseGhosttyConfig(themeSource).colors;
    });

  const themeSelection = config.theme ? splitThemeSelection(config.theme) : {};
  const resolveModeColors = (themeName: string | undefined) =>
    Effect.gen(function* () {
      const themeColors = themeName ? yield* loadThemeColors(themeName) : emptyColors();
      // Explicit colors in the user config override the selected theme.
      return toThemeColors(mergeColors(themeColors, config.colors));
    });

  const light = yield* resolveModeColors(themeSelection.light);
  const dark = yield* resolveModeColors(themeSelection.dark);

  const style: ServerTerminalStyle = {
    ...(config.fontFamily.length > 0 ? { fontFamily: config.fontFamily } : {}),
    ...(config.fontSize !== undefined ? { fontSize: config.fontSize } : {}),
    ...(light !== undefined ? { light } : {}),
    ...(dark !== undefined ? { dark } : {}),
  };

  const hasAnyValue =
    style.fontFamily !== undefined ||
    style.fontSize !== undefined ||
    style.light !== undefined ||
    style.dark !== undefined;
  return hasAnyValue ? style : undefined;
}).pipe(Effect.orElseSucceed(() => undefined));
