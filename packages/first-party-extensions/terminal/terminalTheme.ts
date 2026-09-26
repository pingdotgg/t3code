import type { GhosttyColor, GhosttyTheme } from "@t3tools/ghostty-terminal/core";
import type { GhosttyTerminalFont } from "@t3tools/ghostty-terminal/surface";

function parseTerminalColor(value: string, fallback: GhosttyColor): GhosttyColor {
  if (typeof document === "undefined") return fallback;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return fallback;

  return {
    r: red ?? fallback.r,
    g: green ?? fallback.g,
    b: blue ?? fallback.b,
  };
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

/**
 * Resolves a custom property that may be a `var(--name, fallback)` token
 * stream — getPropertyValue never substitutes var() references, and the
 * contract publishes `--t3-terminal-*` overrides in exactly that shape. Each
 * hop is looked up on the same computed style (custom properties inherit
 * onto the mount) with a depth cap; an unresolvable chain falls back rather
 * than feeding the canvas a token stream.
 */
function readThemeColor(styles: CSSStyleDeclaration, variable: string, fallback: string): string {
  let value = styles.getPropertyValue(variable).trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (!value.startsWith("var(") || !value.endsWith(")")) break;
    const inner = value.slice(4, -1);
    // Split at the first top-level comma: var(--name, fallback).
    let split = -1;
    let nested = 0;
    for (let i = 0; i < inner.length; i += 1) {
      const char = inner[i];
      if (char === "(") nested += 1;
      else if (char === ")") nested -= 1;
      else if (char === "," && nested === 0) {
        split = i;
        break;
      }
    }
    const name = (split === -1 ? inner : inner.slice(0, split)).trim();
    const next = styles.getPropertyValue(name).trim();
    value = next !== "" ? next : split === -1 ? "" : inner.slice(split + 1).trim();
    if (value === "") return fallback;
  }
  return normalizeComputedColor(value, fallback);
}

/**
 * Theme path (t3.ui adoption): the host's `--terminal-*` CSS
 * variables and the contract-published `--t3-terminal-*` overrides both
 * inherit into extension DOM, so the surface reads them from its own mount
 * — contract vars first, legacy vars next, document colors last. The
 * `--t3-terminal-color-scheme` bridge on the mount feeds the dark-mode
 * fallback decision. When the contract feed dies its properties clear and
 * the legacy chain governs again — the degraded path is automatic.
 */
export function terminalThemeFromApp(mountElement?: HTMLElement | null): GhosttyTheme {
  if (typeof document === "undefined") {
    return {
      background: { r: 255, g: 255, b: 255 },
      foreground: { r: 28, g: 33, b: 41 },
      cursor: { r: 38, g: 56, b: 78 },
    };
  }
  const themeStyles = getComputedStyle(mountElement ?? document.body);
  const colorScheme = themeStyles.colorScheme;
  const isDark =
    colorScheme === "dark"
      ? true
      : colorScheme === "light"
        ? false
        : document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const bodyStyles = getComputedStyle(document.body);
  const rootThemeStyles = getComputedStyle(document.documentElement);
  const background = normalizeComputedColor(
    themeStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    themeStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );
  const terminalBackground = readThemeColor(
    themeStyles,
    "--t3-terminal-background",
    readThemeColor(
      themeStyles,
      "--terminal-background",
      readThemeColor(rootThemeStyles, "--terminal-background", background),
    ),
  );
  const terminalForeground = readThemeColor(
    themeStyles,
    "--t3-terminal-foreground",
    readThemeColor(
      themeStyles,
      "--terminal-foreground",
      readThemeColor(rootThemeStyles, "--terminal-foreground", foreground),
    ),
  );
  const terminalCursor = readThemeColor(
    themeStyles,
    "--terminal-cursor",
    isDark ? "rgb(180, 203, 255)" : "rgb(38, 56, 78)",
  );
  const terminalSelection = readThemeColor(
    themeStyles,
    "--t3-terminal-selection",
    readThemeColor(
      themeStyles,
      "--terminal-selection-background",
      isDark ? "rgba(180, 203, 255, 0.25)" : "rgba(37, 63, 99, 0.2)",
    ),
  );
  return {
    background: parseTerminalColor(
      terminalBackground,
      isDark ? { r: 14, g: 18, b: 24 } : { r: 255, g: 255, b: 255 },
    ),
    foreground: parseTerminalColor(
      terminalForeground,
      isDark ? { r: 237, g: 241, b: 247 } : { r: 28, g: 33, b: 41 },
    ),
    cursor: parseTerminalColor(
      terminalCursor,
      isDark ? { r: 180, g: 203, b: 255 } : { r: 38, g: 56, b: 78 },
    ),
    selectionBackground: terminalSelection,
  };
}

/**
 * Published `--t3-terminal-font-*` overrides → surface font request, for
 * both `options.font` at creation and live `setFont` updates. The
 * appearance contract publishes literals (a family string, `Npx`); a var()
 * token stream cannot resolve here — fonts have no legacy variable to fall
 * through to — so unresolvable values are skipped and the surface keeps its
 * packaged defaults. An empty map (feed cleared) yields `{}`, which resets
 * the surface to those same defaults. Family/size only: the surface has no
 * line-height or ligature options, so those published vars intentionally
 * reach only the DOM fallback path.
 */
export function terminalFontFromVars(vars: Record<string, string> | null): GhosttyTerminalFont {
  if (vars === null) return {};
  const family = vars["--t3-terminal-font-family"]?.trim();
  const sizeMatch = /^\s*([0-9]*\.?[0-9]+)px\s*$/.exec(vars["--t3-terminal-font-size"] ?? "");
  return {
    family: family === undefined || family === "" || family.startsWith("var(") ? undefined : family,
    size: sizeMatch === null ? undefined : Number.parseFloat(sizeMatch[1] ?? ""),
  };
}
