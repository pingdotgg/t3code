export const T3_CHAT_THEME_ID = "t3-chat" as const;
export const T3_CHAT_THEME_LABEL = "T3 Chat";
export const GROVE_THEME_ID = "grove" as const;
export const GROVE_THEME_LABEL = "Grove";
export const OCEAN_THEME_ID = "ocean" as const;
export const OCEAN_THEME_LABEL = "Ocean";
export const EMBER_THEME_ID = "ember" as const;
export const EMBER_THEME_LABEL = "Ember";
export const IRIS_THEME_ID = "iris" as const;
export const IRIS_THEME_LABEL = "Iris";

export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeAppearance = "light" | "dark";
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;

export type ThemeDefinition = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly appearance: ThemeAppearance;
  readonly colors: ThemeColors;
  readonly variants?: ThemeVariants;
  readonly managed?: boolean;
}>;

type ThemeRgbColor = { r: number; g: number; b: number };
type ThemeHslColor = { h: number; s: number; l: number };

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 };
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 };
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 };

const T3_CHAT_LIGHT_COLORS: ThemeColors = {
  canvas: "#fdf7fd",
  chrome: "#fdf7fd",
  toolbar: "#fdf7fd",
  toolbarForeground: "#501854",
  toolbarBorder: "#efbdeb",
  toolbarControl: "#f3e6f5",
  toolbarControlForeground: "#501854",
  toolbarControlHover: "#eccfe3",
  surface: "#faf3fb",
  surfaceRaised: "#fdfafd",
  surfaceOverlay: "#ffffff",
  text: "#501854",
  textMuted: "#ac1668",
  border: "#eee1ed",
  input: "#e7c1dc",
  focus: "#db2777",
  accent: "#e33f86",
  accentForeground: "#ffffff",
  secondary: "#f1c4e6",
  secondaryForeground: "#77347c",
  muted: "#eaa7cb",
  mutedForeground: "#ac1668",
  placeholder: "#ad83b0",
  secondaryLabel: "#ac1668",
  iconMuted: "#ac1668",
  error: "#f7086c",
  errorForeground: "#9d174d",
  errorSurface: "#fde4f1",
  warning: "#f59e0b",
  warningForeground: "#b45309",
  warningSurface: "#fcf0ea",
  update: "#e33f86",
  updateForeground: "#ac1668",
  updateSurface: "#fadfef",
  accentSurface: "#f3e6f5",
  accentSurfaceForeground: "#454554",
  messageSurface: "#f7def2",
  messageForeground: "#492c61",
  messageAction: "#e33f86",
  messageActionForeground: "#ffffff",
  messageActionHover: "#d56698",
  codeBackground: "#f5ecf9",
  codeForeground: "#673c8b",
  sidebar: "#f2e1f4",
  sidebarForeground: "#454554",
  sidebarMutedForeground: "#ac1668",
  sidebarControlSurface: "#f8f8f7",
  sidebarRowHover: "#f8f8f7",
  sidebarRowActive: "#f8f8f7",
  sidebarRowSelected: "#f8f8f7",
  sidebarBorder: "#eceae9",
  terminalBackground: "#fdf7fd",
  terminalForeground: "#501854",
  terminalCursor: "#db2777",
  terminalSelection: "#f1c4e6",
  terminalScrollbar: "#e7c1dc",
  terminalScrollbarHover: "#eaa7cb",
};

const T3_CHAT_DARK_COLORS: ThemeColors = {
  canvas: "#1f1a24",
  chrome: "#1f1a24",
  toolbar: "#1f1a24",
  toolbarForeground: "#f9f8fb",
  toolbarBorder: "#27242c",
  toolbarControl: "#362d3d",
  toolbarControlForeground: "#d4c7e1",
  toolbarControlHover: "#463753",
  surface: "#29232d",
  surfaceRaised: "#2c2631",
  surfaceOverlay: "#100a0e",
  text: "#f9f8fb",
  textMuted: "#e7d0dd",
  border: "#27242c",
  input: "#302029",
  focus: "#db2777",
  accent: "#a3004c",
  accentForeground: "#fbd0e8",
  secondary: "#362d3d",
  secondaryForeground: "#d4c7e1",
  muted: "#423a45",
  mutedForeground: "#e7d0dd",
  placeholder: "#8f8699",
  secondaryLabel: "#e7d0dd",
  iconMuted: "#d4c7e1",
  error: "#9d174d",
  errorForeground: "#fbd0e8",
  errorSurface: "#331a2b",
  warning: "#f59e0b",
  warningForeground: "#fbbf24",
  warningSurface: "#412f20",
  update: "#a3004c",
  updateForeground: "#fbd0e8",
  updateSurface: "#37152b",
  accentSurface: "#463753",
  accentSurfaceForeground: "#f8f1f5",
  messageSurface: "#2b2431",
  messageForeground: "#f2ebfa",
  messageAction: "#a3004c",
  messageActionForeground: "#fbd0e8",
  messageActionHover: "#a2004c",
  codeBackground: "#1f1a24",
  codeForeground: "#d8c3ef",
  sidebar: "#171018",
  sidebarForeground: "#f4f4f5",
  sidebarMutedForeground: "#e7d0dd",
  sidebarControlSurface: "#261922",
  sidebarRowHover: "#261922",
  sidebarRowActive: "#261922",
  sidebarRowSelected: "#261922",
  sidebarBorder: "#322028",
  terminalBackground: "#1f1a24",
  terminalForeground: "#f9f8fb",
  terminalCursor: "#db2777",
  terminalSelection: "#362d3d",
  terminalScrollbar: "#302029",
  terminalScrollbarHover: "#423a45",
};

export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CHAT_DARK_COLORS : T3_CHAT_LIGHT_COLORS;
}

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!match?.[1]) return fallback;
  const raw = match[1];
  const hex =
    raw.length <= 4
      ? raw
          .slice(0, 3)
          .split("")
          .map((part) => part.repeat(2))
          .join("")
      : raw.slice(0, 6);
  return hex.length === 6
    ? {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      }
    : fallback;
}

function themeRgbToHexColor(color: ThemeRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function themeRgbToHsl(color: ThemeRgbColor): ThemeHslColor {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness };
}

function themeHslToRgb(color: ThemeHslColor): ThemeRgbColor {
  const hue = ((color.h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const hueSector = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const match = color.l - chroma / 2;
  const [red, green, blue] =
    hueSector < 1
      ? [chroma, secondary, 0]
      : hueSector < 2
        ? [secondary, chroma, 0]
        : hueSector < 3
          ? [0, chroma, secondary]
          : hueSector < 4
            ? [0, secondary, chroma]
            : hueSector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

function mixThemeRgbColors(
  base: ThemeRgbColor,
  overlay: ThemeRgbColor,
  amount: number,
): ThemeRgbColor {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  };
}

function themeRelativeLuminance(color: ThemeRgbColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
  const firstLuminance = themeRelativeLuminance(first);
  const secondLuminance = themeRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableThemeForeground(background: ThemeRgbColor): ThemeRgbColor {
  const lightContrast = themeContrastRatio(background, THEME_LIGHT_FOREGROUND);
  const darkContrast = themeContrastRatio(background, THEME_DARK_FOREGROUND);
  if (Math.max(lightContrast, darkContrast) >= 4.5) {
    return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND;
  }
  return themeContrastRatio(background, THEME_WHITE_FOREGROUND) >=
    themeContrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND;
}

function readableThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
  amount: number,
  minimumRatio: number,
): ThemeRgbColor {
  const softened = mixThemeRgbColors(foreground, background, amount);
  if (themeContrastRatio(softened, background) >= minimumRatio) return softened;
  let readable = foreground;
  let lowerAmount = 0;
  let upperAmount = amount;
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lowerAmount + upperAmount) / 2;
    const candidate = mixThemeRgbColors(foreground, background, candidateAmount);
    if (themeContrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate;
      lowerAmount = candidateAmount;
    } else {
      upperAmount = candidateAmount;
    }
  }
  return readable;
}

function standardMutedThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
): ThemeRgbColor {
  const target = themeRelativeLuminance(background) < 0.179 ? 5.082 : 4.705;
  return readableThemeText(background, foreground, 1, target);
}

function standardStatusColors(canvas: ThemeRgbColor) {
  const dark = themeRelativeLuminance(canvas) < 0.179;
  const standard = dark
    ? {
        error: "#fb414a",
        errorForeground: "#ff6467",
        warning: "#fe9a00",
        warningForeground: "#ffb900",
      }
    : {
        error: "#fb2c36",
        errorForeground: "#c10007",
        warning: "#fe9a00",
        warningForeground: "#bb4d00",
      };
  const amount = dark ? 0.16 : 0.08;
  const surfaceOf = (value: string) =>
    mixThemeRgbColors(canvas, parseThemeRgbColor(value, canvas), amount);
  const errorSurface = surfaceOf(standard.error);
  const warningSurface = surfaceOf(standard.warning);
  return {
    ...standard,
    errorForeground: themeRgbToHexColor(readableThemeForeground(errorSurface)),
    errorSurface: themeRgbToHexColor(errorSurface),
    warningForeground: themeRgbToHexColor(readableThemeForeground(warningSurface)),
    warningSurface: themeRgbToHexColor(warningSurface),
  };
}

function managedThemeBackground(value: string, appearance: ThemeAppearance): ThemeRgbColor {
  const selected = parseThemeRgbColor(
    value,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const hsl = themeRgbToHsl(selected);
  return themeHslToRgb({
    h: hsl.h,
    s: Math.min(hsl.s, appearance === "dark" ? 0.3 : 0.2),
    l:
      appearance === "dark"
        ? Math.min(0.13, Math.max(0.07, hsl.l))
        : Math.min(0.985, Math.max(0.94, hsl.l)),
  });
}

function managedThemeAccent(
  value: string,
  appearance: ThemeAppearance,
  background: ThemeRgbColor,
): ThemeRgbColor {
  const selected = parseThemeRgbColor(value, { r: 168, g: 67, b: 112 });
  const hsl = themeRgbToHsl(selected);
  const preferredLightness =
    appearance === "dark"
      ? Math.min(0.72, Math.max(0.42, hsl.l))
      : Math.min(0.58, Math.max(0.35, hsl.l));
  const lightnessRange: readonly [number, number] =
    appearance === "dark" ? [0.42, 0.82] : [0.22, 0.58];
  const saturation = Math.min(hsl.s, 0.82);
  const candidates = Array.from({ length: 61 }, (_, index) => {
    const lightness = lightnessRange[0] + ((lightnessRange[1] - lightnessRange[0]) * index) / 60;
    const color = themeHslToRgb({ h: hsl.h, s: saturation, l: lightness });
    return { color, lightness, contrast: themeContrastRatio(color, background) };
  });
  const readableCandidates = candidates.filter((candidate) => candidate.contrast >= 4.7);
  const pool = readableCandidates.length > 0 ? readableCandidates : candidates;
  return pool.reduce((best, candidate) => {
    const distance = Math.abs(candidate.lightness - preferredLightness);
    const bestDistance = Math.abs(best.lightness - preferredLightness);
    return distance < bestDistance ||
      (distance === bestDistance && candidate.contrast > best.contrast)
      ? candidate
      : best;
  }).color;
}

export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
  options?: { readonly exactSeeds?: boolean },
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvas = options?.exactSeeds
    ? parseThemeRgbColor(
        backgroundValue,
        appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
      )
    : managedThemeBackground(backgroundValue, appearance);
  const accent = options?.exactSeeds
    ? parseThemeRgbColor(accentValue, { r: 168, g: 67, b: 112 })
    : managedThemeAccent(accentValue, appearance, canvas);
  const text = readableThemeForeground(canvas);
  const textMuted = standardMutedThemeText(canvas, text);
  const chrome = canvas;
  const sidebar = mixThemeRgbColors(canvas, accent, 0.08);
  const surfaceRaised = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.12 : 0.035);
  const surfaceOverlay = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.18 : 0.06);
  const secondary = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.2 : 0.08);
  const muted = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.13 : 0.06);
  const accentSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14);
  const messageSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.36 : 0.18);
  const toolbarControl = mixThemeRgbColors(chrome, accent, appearance === "dark" ? 0.2 : 0.08);
  const toolbarBorder = mixThemeRgbColors(chrome, accent, appearance === "dark" ? 0.35 : 0.14);
  const accentForeground = readableThemeForeground(accent);
  const codeBackground = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.06 : 0.025);
  const messageActionHover = mixThemeRgbColors(
    accent,
    accentForeground === THEME_LIGHT_FOREGROUND || accentForeground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND,
    0.12,
  );
  const updateSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.32 : 0.16);
  const updateForeground = mixThemeRgbColors(
    accent,
    appearance === "dark" ? THEME_WHITE_FOREGROUND : THEME_BLACK_FOREGROUND,
    0.35,
  );
  const hex = themeRgbToHexColor;
  return {
    ...defaults,
    ...standardStatusColors(canvas),
    update: hex(accent),
    updateForeground: hex(updateForeground),
    updateSurface: hex(updateSurface),
    canvas: hex(canvas),
    chrome: hex(chrome),
    toolbar: hex(chrome),
    toolbarForeground: hex(text),
    toolbarBorder: hex(toolbarBorder),
    toolbarControl: hex(toolbarControl),
    toolbarControlForeground: hex(text),
    toolbarControlHover: hex(accentSurface),
    surface: hex(canvas),
    surfaceRaised: hex(surfaceRaised),
    surfaceOverlay: hex(surfaceOverlay),
    text: hex(text),
    textMuted: hex(textMuted),
    border: hex(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.22 : 0.1),
        text,
        0.1,
      ),
    ),
    input: hex(
      mixThemeRgbColors(
        mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14),
        text,
        appearance === "dark" ? 0.14 : 0.13,
      ),
    ),
    focus: hex(accent),
    accent: hex(accent),
    accentForeground: hex(accentForeground),
    secondary: hex(secondary),
    secondaryForeground: hex(readableThemeForeground(secondary)),
    muted: hex(muted),
    mutedForeground: hex(textMuted),
    placeholder: hex(textMuted),
    secondaryLabel: hex(textMuted),
    iconMuted: hex(textMuted),
    accentSurface: hex(accentSurface),
    accentSurfaceForeground: hex(readableThemeForeground(accentSurface)),
    messageSurface: hex(messageSurface),
    messageForeground: hex(readableThemeForeground(messageSurface)),
    messageAction: hex(accent),
    messageActionForeground: hex(accentForeground),
    messageActionHover: hex(messageActionHover),
    codeBackground: hex(codeBackground),
    codeForeground: hex(readableThemeForeground(codeBackground)),
    sidebar: hex(sidebar),
    sidebarForeground: hex(readableThemeForeground(sidebar)),
    sidebarMutedForeground: hex(standardMutedThemeText(sidebar, text)),
    sidebarControlSurface: hex(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.16 : 0.08),
    ),
    sidebarRowHover: hex(mixThemeRgbColors(sidebar, accent, 0.12)),
    sidebarRowActive: hex(mixThemeRgbColors(sidebar, accent, 0.2)),
    sidebarRowSelected: hex(mixThemeRgbColors(sidebar, accent, 0.24)),
    sidebarBorder: hex(mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.35 : 0.12)),
    terminalBackground: hex(canvas),
    terminalForeground: hex(readableThemeForeground(canvas)),
    terminalCursor: hex(accent),
    terminalSelection: hex(mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.35 : 0.18)),
    terminalScrollbar: hex(mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.42 : 0.22)),
    terminalScrollbarHover: hex(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.55 : 0.32),
    ),
  };
}

export const T3_CHAT_THEME: ThemeDefinition = {
  id: T3_CHAT_THEME_ID,
  label: T3_CHAT_THEME_LABEL,
  appearance: "light",
  colors: T3_CHAT_LIGHT_COLORS,
  variants: { dark: T3_CHAT_DARK_COLORS },
};

function themeActionColors(
  action: string,
): Pick<ThemeColors, "messageAction" | "messageActionForeground" | "messageActionHover"> {
  const rgb = parseThemeRgbColor(action, THEME_DARK_FOREGROUND);
  const foreground = readableThemeForeground(rgb);
  const towardOpposite =
    foreground === THEME_LIGHT_FOREGROUND || foreground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND;
  return {
    messageAction: action,
    messageActionForeground: themeRgbToHexColor(foreground),
    messageActionHover: themeRgbToHexColor(mixThemeRgbColors(rgb, towardOpposite, 0.12)),
  };
}

export const GROVE_THEME: ThemeDefinition = {
  id: GROVE_THEME_ID,
  label: GROVE_THEME_LABEL,
  appearance: "light",
  colors: {
    ...createManagedThemeColors("light", "#f2f8f4", "#19734a"),
    ...themeActionColors("#8f6410"),
  },
  variants: {
    dark: {
      ...createManagedThemeColors("dark", "#1d2b24", "#69d69a"),
      ...themeActionColors("#e3b34e"),
    },
  },
};
export const OCEAN_THEME: ThemeDefinition = {
  id: OCEAN_THEME_ID,
  label: OCEAN_THEME_LABEL,
  appearance: "light",
  colors: {
    ...createManagedThemeColors("light", "#f2f7fb", "#2878b8"),
    ...themeActionColors("#0a6f75"),
  },
  variants: {
    dark: {
      ...createManagedThemeColors("dark", "#1b2938", "#70b9ee"),
      ...themeActionColors("#5bd0d6"),
    },
  },
};
export const EMBER_THEME: ThemeDefinition = {
  id: EMBER_THEME_ID,
  label: EMBER_THEME_LABEL,
  appearance: "light",
  colors: {
    ...createManagedThemeColors("light", "#fff6ef", "#c4602f"),
    ...themeActionColors("#b23535"),
  },
  variants: {
    dark: {
      ...createManagedThemeColors("dark", "#30231e", "#f39a62"),
      ...themeActionColors("#f78a7a"),
    },
  },
};
export const IRIS_THEME: ThemeDefinition = {
  id: IRIS_THEME_ID,
  label: IRIS_THEME_LABEL,
  appearance: "light",
  colors: {
    ...createManagedThemeColors("light", "#f7f4fc", "#7254b9"),
    ...themeActionColors("#a82c87"),
  },
  variants: {
    dark: {
      ...createManagedThemeColors("dark", "#29243b", "#ad92f5"),
      ...themeActionColors("#f099d8"),
    },
  },
};

export const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

export function getThemeDefinition(id: string): ThemeDefinition | null {
  return BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

export function getThemeColorsForMode(
  theme: ThemeDefinition,
  mode: ThemeAppearance,
): ThemeColors | null {
  return mode === theme.appearance ? theme.colors : (theme.variants?.[mode] ?? null);
}
