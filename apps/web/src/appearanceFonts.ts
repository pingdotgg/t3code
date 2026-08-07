/**
 * Font preferences from Settings → Appearance, applied as CSS custom
 * properties. The default stacks mirror the `--font-sans` / `--font-mono`
 * definitions in `index.css`; a custom family is always prepended to the
 * matching default stack so glyph coverage never regresses.
 */

import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_PROMPT_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
} from "@t3tools/contracts";

export const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Concrete names first: some engines alias `ui-monospace` to the
// proportional system UI font, which would break every code surface.
export const DEFAULT_CODE_FONT_STACK =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export const TYPOGRAPHY_ADVANCED_STORAGE_KEY = "t3code:typography-advanced";

/**
 * Sans faces the app ships as webfonts. Always offered in the Appearance
 * pickers (and treated as available) so users can pick them without installing
 * the face locally or granting Local Font Access.
 */
export const BUNDLED_SANS_FONT_FAMILIES = ["Atkinson Hyperlegible Next"] as const;

const BUNDLED_SANS_FONT_FAMILY_SET: ReadonlySet<string> = new Set(BUNDLED_SANS_FONT_FAMILIES);

export function isBundledSansFontFamily(family: string): boolean {
  return BUNDLED_SANS_FONT_FAMILY_SET.has(family.trim());
}

/**
 * Curated faces shown even when Local Font Access is denied or unsupported.
 * Monospace rows stay empty until a bundled mono ships — proportional faces
 * must not appear there.
 */
export function curatedFontFamilies(requireMonospace: boolean): readonly string[] {
  return requireMonospace ? [] : BUNDLED_SANS_FONT_FAMILIES;
}

/** Installed families plus curated faces, de-duplicated and sorted. */
export function mergeFontFamilyCatalog(
  installed: readonly string[],
  curated: readonly string[],
): string[] {
  const families = new Set(installed);
  for (const family of curated) families.add(family);
  return [...families].sort((left, right) => left.localeCompare(right));
}

/**
 * Ensure a committed custom family stays visible in the picker catalog even
 * when Local Font Access did not enumerate it. A case-insensitive match keeps
 * the catalog spelling (e.g. stored `arial` against enumerated `Arial`).
 */
export function ensureSelectedFontFamilyInCatalog(
  catalog: readonly string[],
  selectedFamily: string,
): string[] {
  const trimmed = selectedFamily.trim();
  if (trimmed.length === 0) return [...catalog];
  if (catalog.some((family) => family.toLowerCase() === trimmed.toLowerCase())) {
    return [...catalog];
  }
  return mergeFontFamilyCatalog(catalog, [trimmed]);
}

/**
 * Map a committed family onto the catalog spelling when they differ only by
 * case, so the combobox value and checkmark line up with the listed row.
 */
export function resolveFontFamilyPickerSelection(
  catalog: readonly string[],
  selectedFamily: string,
): string {
  const trimmed = selectedFamily.trim();
  if (trimmed.length === 0) return "";
  return catalog.find((family) => family.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
}

/**
 * Build the searchable picker rows: Default (when the query is empty),
 * catalog matches, and — when the typed name is not already listed but is
 * accepted — a leading custom entry so free-text families work without
 * Local Font Access.
 */
export function buildFontFamilyPickerItems(input: {
  readonly catalog: readonly string[];
  readonly query: string;
  readonly acceptCustom: (candidate: string) => boolean;
  readonly defaultValue: string;
}): string[] {
  const trimmedQuery = input.query.trim();
  const lowerQuery = trimmedQuery.toLowerCase();
  const catalogLower = new Set(input.catalog.map((family) => family.toLowerCase()));
  const result: string[] = [];
  if (trimmedQuery.length === 0) result.push(input.defaultValue);
  result.push(
    ...input.catalog.filter(
      (family) => lowerQuery.length === 0 || family.toLowerCase().includes(lowerQuery),
    ),
  );
  if (
    trimmedQuery.length > 0 &&
    !catalogLower.has(lowerQuery) &&
    input.acceptCustom(trimmedQuery)
  ) {
    result.unshift(trimmedQuery);
  }
  return result;
}

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
  /** Grayscale `antialiased` rendering; false keeps the heavier platform default. */
  readonly smoothing: boolean;
}

/**
 * Apply the preferences to the root element. Unset families remove the
 * override so the stylesheet defaults (and theme changes) stay in charge.
 *
 * Sizes are always written: the interface size drives the root font size (and
 * with it every rem-based dimension), while the prompt and code sizes stay in
 * absolute pixels so they do not scale twice.
 */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const families: ReadonlyArray<readonly [variable: string, custom: string, fallback: string]> = [
    ["--font-sans", preferences.sans, DEFAULT_SANS_FONT_STACK],
    ["--font-mono", preferences.code, DEFAULT_CODE_FONT_STACK],
    // The composer falls back to whatever the sans preference resolves to.
    ["--font-composer", preferences.composer, "var(--font-sans)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list === null) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(variable, `${list}, ${fallback}`);
    }
  }

  root.style.fontSize = `${clampInterfaceFontSize(preferences.sizeInterface)}px`;
  root.style.setProperty("--font-size-prompt", `${clampPromptFontSize(preferences.sizePrompt)}px`);
  const code = clampCodeFontSize(preferences.sizeCode);
  root.style.setProperty("--font-size-code", `${code}px`);
  // The @pierre/diffs surfaces read their own hook for code text.
  root.style.setProperty("--diffs-font-size", `${code}px`);

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
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `16px ${fontList}`;
  return fontProbeContext.measureText(FONT_PROBE_TEXT).width;
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
  // Bundled webfonts are offered before document.fonts has finished loading.
  if (isBundledSansFontFamily(family)) return true;
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
 * Whether a family renders every character on the same advance. Cell-grid
 * surfaces (the terminal) require this: a proportional face draws its text
 * narrower than the lattice the cursor and selection are placed on, which
 * reads as ragged gaps and a cursor stranded to the right of the text.
 *
 * Unmeasurable environments answer true, so a missing canvas never blocks a
 * legitimate font.
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
  // No nameable face matched; on Apple platforms that means one of the San
  // Francisco faces, which CSS cannot name. Comparing against -apple-system
  // tells the UI face apart from SF Mono.
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform)) {
    const systemWidth = measureDomProbeWidth("-apple-system");
    if (systemWidth !== null && widthsMatch(genericWidth, systemWidth)) return "SF Pro";
    return monoLike ? "SF Mono" : "SF Pro";
  }
  return null;
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
   * prompt. Both leave the picker on the curated (bundled) catalog, with
   * free-text entry still available for installed family names.
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
      // Dot-prefixed families are macOS-internal UI faces; selecting one is
      // never intended and most refuse to render for web content anyway.
      .filter((family) => !family.startsWith("."))
      .sort((left, right) => left.localeCompare(right));
    // A denied permission check resolves with an empty list instead of
    // throwing; no machine has zero fonts, so treat empty as denied.
    if (families.length === 0) return { families: [], status: "denied" };
    installedFamiliesCache = { families, status: "granted" };
    return installedFamiliesCache;
  } catch {
    return { families: [], status: "denied" };
  }
}
