/**
 * Font preferences from Settings → Appearance, applied as CSS custom
 * properties. The default stacks mirror the `--font-sans` / `--font-mono`
 * definitions in `index.css`; a custom family is always prepended to the
 * matching default stack so glyph coverage never regresses.
 */

import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_CODE_LINE_HEIGHT,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_INTERFACE_LINE_HEIGHT,
  DEFAULT_PROMPT_FONT_SIZE,
  DEFAULT_PROMPT_LINE_HEIGHT,
  LINE_HEIGHT_STEP,
  MAX_CODE_FONT_SIZE,
  MAX_CODE_LINE_HEIGHT,
  MAX_INTERFACE_FONT_SIZE,
  MAX_INTERFACE_LINE_HEIGHT,
  MAX_PROMPT_FONT_SIZE,
  MAX_PROMPT_LINE_HEIGHT,
  MIN_CODE_FONT_SIZE,
  MIN_CODE_LINE_HEIGHT,
  MIN_INTERFACE_FONT_SIZE,
  MIN_INTERFACE_LINE_HEIGHT,
  MIN_PROMPT_FONT_SIZE,
  MIN_PROMPT_LINE_HEIGHT,
} from "@t3tools/contracts";

export const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif';

// Some engines map `ui-monospace` to a proportional font, so prefer concrete names.
export const DEFAULT_CODE_FONT_STACK =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export const TYPOGRAPHY_ADVANCED_STORAGE_KEY = "t3code:typography-advanced";

/**
 * Simple typography treats the terminal as another monospace surface. In
 * Advanced mode an empty terminal preference means the terminal default,
 * keeping later code-font changes isolated to code surfaces.
 */
export function resolveTerminalFontPreference(input: {
  readonly advanced: boolean;
  readonly code: string;
  readonly terminal: string;
}): string {
  if (input.advanced) return input.terminal;
  return input.code;
}

export function resolveTerminalFontSizePreference(input: {
  readonly advanced: boolean;
  readonly code: number;
  readonly terminal: number;
}): number {
  if (input.advanced) return input.terminal;
  return input.code;
}

/**
 * Simple typography has no terminal row, so the terminal follows the code line
 * height - but only once the user moved it. The code default (1.625) is looser
 * than the terminal's own (1.35); following it unconditionally would change
 * every terminal the moment this setting shipped.
 */
export function resolveTerminalLineHeightPreference(input: {
  readonly advanced: boolean;
  readonly code: number;
  readonly terminal: number;
}): number {
  if (input.advanced) return input.terminal;
  return input.code === DEFAULT_CODE_LINE_HEIGHT ? input.terminal : input.code;
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

/**
 * Normalize a user-entered family (single name or comma-separated list) into a
 * safe CSS font-family list, or null when the input is effectively empty.
 */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

/** The full stack a preference resolves to: custom families before the default. */
export function appearanceFontStack(custom: string, defaultStack: string): string {
  const families = cssFontFamilies(custom);
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

export interface AppearanceFontPreferences {
  readonly sans: string;
  readonly code: string;
  readonly composer: string;
  readonly sizeInterface: number;
  readonly sizePrompt: number;
  readonly sizeCode: number;
  readonly lineHeightInterface: number;
  readonly lineHeightPrompt: number;
  readonly lineHeightCode: number;
  /** Grayscale `antialiased` rendering; false keeps the heavier platform default. */
  readonly smoothing: boolean;
  readonly separate: boolean;
}

/**
 * Apply the preferences to the root. Unset families drop the override. Sizes are always
 * written: the interface size sets the root font size, prompt and code sizes stay in px
 * (the prompt follows the interface text size unless separate fonts are on).
 */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const families: ReadonlyArray<readonly [variable: string, custom: string, fallback: string]> = [
    ["--font-sans", preferences.sans, DEFAULT_SANS_FONT_STACK],
    ["--font-mono", preferences.code, DEFAULT_CODE_FONT_STACK],
    // The composer falls back to whatever the sans preference resolves to.
    ["--font-composer", preferences.separate ? preferences.composer : "", "var(--font-sans)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list === null) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(variable, `${list}, ${fallback}`);
    }
  }

  const markerWidth = probeWidth(
    appearanceFontStack(preferences.sans, DEFAULT_SANS_FONT_STACK),
    LIST_MARKER_PROBE_TEXT,
  );
  if (markerWidth === null) {
    root.style.removeProperty("--list-marker-sans");
  } else {
    root.style.setProperty("--list-marker-sans", `${(markerWidth / PROBE_FONT_SIZE).toFixed(3)}em`);
  }

  root.style.fontSize = `${clampInterfaceFontSize(preferences.sizeInterface)}px`;
  root.style.setProperty(
    "--font-size-prompt",
    preferences.separate ? `${clampPromptFontSize(preferences.sizePrompt)}px` : "var(--text-sm)",
  );
  const code = clampCodeFontSize(preferences.sizeCode);
  root.style.setProperty("--font-size-code", `${code}px`);
  // The @pierre/diffs surfaces read their own hook for code text.
  root.style.setProperty("--diffs-font-size", `${code}px`);

  for (const [variable, value] of Object.entries(appearanceLineHeightVariables(preferences))) {
    if (value === null) root.style.removeProperty(variable);
    else root.style.setProperty(variable, value);
  }

  // Inherited from the root; only macOS engines honor the property, so no
  // platform gate is needed here. Smoothing on means grayscale `antialiased`
  // (thinner strokes); off restores the platform default, which macOS renders
  // with heavier stem darkening.
  if (preferences.smoothing) {
    root.style.setProperty("-webkit-font-smoothing", "antialiased");
  } else {
    root.style.removeProperty("-webkit-font-smoothing");
  }
}

/**
 * Line-height custom properties (null removes one): the interface scale for text tokens, the
 * prompt and code values replacing `leading-relaxed`, and `--diffs-line-height`, set only off
 * the default because @pierre/diffs uses a fixed 20px.
 */
export function appearanceLineHeightVariables(
  preferences: Pick<
    AppearanceFontPreferences,
    "lineHeightInterface" | "lineHeightPrompt" | "lineHeightCode"
  >,
): Readonly<Record<string, string | null>> {
  const interfaceLineHeight = clampInterfaceLineHeight(preferences.lineHeightInterface);
  const code = clampCodeLineHeight(preferences.lineHeightCode);
  return {
    "--line-height-interface-scale": String(
      Math.round((interfaceLineHeight / DEFAULT_INTERFACE_LINE_HEIGHT) * 10_000) / 10_000,
    ),
    "--line-height-prompt": String(clampPromptLineHeight(preferences.lineHeightPrompt)),
    "--line-height-code": String(code),
    "--diffs-line-height": code === DEFAULT_CODE_LINE_HEIGHT ? null : String(code),
  };
}

function clampLineHeight(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  // Steps are 0.05 and a default is 1.625; rounding to thousandths keeps 1.35 from
  // drifting to 1.3500000000000001 without moving either.
  return Math.round(Math.min(maximum, Math.max(minimum, value)) * 1000) / 1000;
}

/** The values the line-height pickers offer: every 0.05 from `min` to `max`. */
export function lineHeightOptions(min: number, max: number): number[] {
  const count = Math.round((max - min) / LINE_HEIGHT_STEP);
  return Array.from(
    { length: count + 1 },
    (_, index) => Math.round((min + index * LINE_HEIGHT_STEP) * 100) / 100,
  );
}

export function clampInterfaceLineHeight(value: number): number {
  return clampLineHeight(
    value,
    MIN_INTERFACE_LINE_HEIGHT,
    MAX_INTERFACE_LINE_HEIGHT,
    DEFAULT_INTERFACE_LINE_HEIGHT,
  );
}

function clampPromptLineHeight(value: number): number {
  return clampLineHeight(
    value,
    MIN_PROMPT_LINE_HEIGHT,
    MAX_PROMPT_LINE_HEIGHT,
    DEFAULT_PROMPT_LINE_HEIGHT,
  );
}

export function clampCodeLineHeight(value: number): number {
  return clampLineHeight(
    value,
    MIN_CODE_LINE_HEIGHT,
    MAX_CODE_LINE_HEIGHT,
    DEFAULT_CODE_LINE_HEIGHT,
  );
}

function clampFontSize(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function clampInterfaceFontSize(value: number): number {
  return clampFontSize(
    value,
    MIN_INTERFACE_FONT_SIZE,
    MAX_INTERFACE_FONT_SIZE,
    DEFAULT_INTERFACE_FONT_SIZE,
  );
}

export function clampPromptFontSize(value: number): number {
  return clampFontSize(value, MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE);
}

export function clampCodeFontSize(value: number): number {
  return clampFontSize(value, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);
}

const FONT_PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";
// The widest single-digit `ol` marker; CSS can't measure it to size the list gutter.
const LIST_MARKER_PROBE_TEXT = "0. ";
const PROBE_FONT_SIZE = 16;
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string, text = FONT_PROBE_TEXT): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `${PROBE_FONT_SIZE}px ${fontList}`;
  return fontProbeContext.measureText(text).width;
}

/**
 * Canvas metric probing instead of document.fonts.check(): check() reports
 * true for families that are not installed at all (nothing needs loading), so
 * it cannot filter the dropdown. A family exists when falling back to at
 * least one generic changes the measured advance.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true;
  try {
    for (const generic of ["monospace", "serif", "sans-serif"]) {
      const baseline = probeWidth(generic);
      const candidate = probeWidth(`${families}, ${generic}`);
      if (baseline === null || candidate === null) return false;
      if (candidate !== baseline) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

export function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

/**
 * Whether a family is monospaced, which cell-grid surfaces (the terminal) require.
 * Unmeasurable environments answer true so a missing canvas never blocks a font.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    // Fall back to a generic mono so an absent face measures as monospace and
    // is left for the normal fallback chain to resolve.
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

// Nameable faces the platform generics commonly map to, likeliest first.
// Pixel-comparing a generic against these names the actual face; Apple's own
// UI fonts are deliberately not CSS-nameable, so a miss on an Apple platform
// identifies San Francisco itself.
const SANS_GENERIC_CANDIDATES = [
  "Segoe UI",
  "Roboto",
  "Noto Sans",
  "Ubuntu",
  "Cantarell",
  "DejaVu Sans",
  "Liberation Sans",
  "Helvetica Neue",
  "Arial",
] as const;
const MONO_GENERIC_CANDIDATES = [
  "Menlo",
  "Consolas",
  "Cascadia Mono",
  "DejaVu Sans Mono",
  "Ubuntu Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Roboto Mono",
  "Monaco",
  "Courier New",
] as const;

const GENERIC_PROBE_TEXT = "RagIl10O@ fjord quiz";

/**
 * Advance width of the probe text laid out by the DOM - not canvas, whose
 * generic-family mapping diverges from real rendering (this engine draws
 * `ui-monospace` as the proportional UI font on canvas but not in CSS).
 * Identical widths at this size mean the same face for practical purposes.
 */
function measureDomProbeWidth(fontFamily: string): number | null {
  try {
    const body = document.body;
    if (!body) return null;
    const span = document.createElement("span");
    span.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px;";
    span.style.fontFamily = fontFamily;
    span.textContent = GENERIC_PROBE_TEXT;
    body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width > 0 ? width : null;
  } catch {
    return null;
  }
}

function widthsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

/**
 * Name the concrete face a generic keyword renders as, by measuring the
 * generic against nameable candidates. Null when the face cannot be
 * identified (and the platform gives no definitional answer).
 */
function resolveGenericFamilyLabel(generic: string): string | null {
  const lower = generic.toLowerCase();
  if (lower === "serif") return null;
  const monoLike = lower === "ui-monospace" || lower === "monospace";
  const genericWidth = measureDomProbeWidth(generic);
  if (genericWidth === null) return null;
  for (const candidate of monoLike ? MONO_GENERIC_CANDIDATES : SANS_GENERIC_CANDIDATES) {
    if (!isFontFamilyAvailable(candidate)) continue;
    const candidateWidth = measureDomProbeWidth(`"${candidate}"`);
    if (candidateWidth !== null && widthsMatch(genericWidth, candidateWidth)) {
      return candidate;
    }
  }
  // Unnameable Apple faces need -apple-system metrics to distinguish the UI face from SF Mono.
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform)) {
    const systemWidth = measureDomProbeWidth("-apple-system");
    if (systemWidth !== null && widthsMatch(genericWidth, systemWidth)) return "SF Pro";
    return monoLike ? "SF Mono" : "SF Pro";
  }
  return null;
}

// Synthetic Apple labels are not necessarily available as named CSS families.
export function displayFontFamily(family: string): string {
  const label = family
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim()
    .toLowerCase();
  if (label === "sf pro") return appearanceFontStack(family, DEFAULT_SANS_FONT_STACK);
  if (label === "sf mono") return DEFAULT_CODE_FONT_STACK;
  return cssFontFamilies(family) ?? "";
}

/**
 * The first family of a default stack that will actually render - what the
 * "Default" choice means on this machine. Concrete names are probed for
 * availability; generic keywords are resolved to the face they draw with
 * where identifiable. Null when nothing can be named.
 */
export function resolveDefaultFamilyLabel(stack: string): string | null {
  for (const raw of stack.split(",")) {
    const family = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (family.length === 0) continue;
    if (
      /^(system-ui|sans-serif|serif|monospace|ui-monospace|-apple-system|BlinkMacSystemFont)$/i.test(
        family,
      )
    ) {
      const resolved = resolveGenericFamilyLabel(family);
      if (resolved !== null) return resolved;
      continue;
    }
    if (isFontFamilyAvailable(family)) return family;
  }
  return null;
}

export interface InstalledFontFamiliesResult {
  readonly families: readonly string[];
  /**
   * "unsupported" - the engine has no Local Font Access API (Safari,
   * Firefox); "denied" - the API exists but the user declined the permission
   * prompt. Both fall back to the curated catalog.
   */
  readonly status: "granted" | "denied" | "unsupported";
}

let installedFamiliesCache: InstalledFontFamiliesResult | null = null;

/**
 * Every installed family via the Local Font Access API (Chromium and
 * Electron). Call from a user gesture: the first call raises the browser's
 * local-fonts permission prompt. A denial is not cached, so reopening the
 * picker can ask again after the user changes the site setting.
 */
export async function queryInstalledFontFamilies(): Promise<InstalledFontFamiliesResult> {
  if (installedFamiliesCache !== null) return installedFamiliesCache;
  const query = (
    window as Window & {
      queryLocalFonts?: () => Promise<ReadonlyArray<{ readonly family: string }>>;
    }
  ).queryLocalFonts;
  if (typeof query !== "function") {
    installedFamiliesCache = { families: [], status: "unsupported" };
    return installedFamiliesCache;
  }
  try {
    const fonts = await query.call(window);
    const families = [...new Set(fonts.map((font) => font.family))]
      // Dot-prefixed macOS UI faces often refuse to render in web content.
      .filter((family) => !family.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    // Denied access can return an empty list instead of throwing.
    if (families.length === 0) return { families: [], status: "denied" };
    installedFamiliesCache = { families, status: "granted" };
    return installedFamiliesCache;
  } catch {
    return { families: [], status: "denied" };
  }
}
