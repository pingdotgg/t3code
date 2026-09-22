import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

export type FaviconColorScheme = "light" | "dark";

const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";
const DEFAULT_CURRENT_COLOR = "#000";
const CURRENT_COLOR_RE = /currentcolor/gi;
const PREFERS_COLOR_SCHEME_RE = /prefers-color-scheme\s*:\s*(light|dark)/i;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const COLOR_DECLARATION_RE = /(?:^|[^-\w])color\s*:\s*([^;}!]+)/gi;
const ROOT_COLOR_ATTRIBUTE_RE = /<svg\b[^>]*?\scolor\s*=\s*["']([^"']+)["']/i;

function findBlockEnd(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}" && (depth -= 1) === 0) return index;
  }
  return -1;
}

/** Unwraps `@media (prefers-color-scheme)` blocks that match and drops the rest. */
function resolveColorSchemeMediaQueries(svg: string, scheme: FaviconColorScheme): string {
  let output = svg;
  let searchFrom = 0;
  for (;;) {
    const mediaIndex = output.indexOf("@media", searchFrom);
    if (mediaIndex === -1) return output;
    const openIndex = output.indexOf("{", mediaIndex);
    if (openIndex === -1) return output;
    const closeIndex = findBlockEnd(output, openIndex);
    if (closeIndex === -1) return output;
    const prelude = output.slice(mediaIndex + "@media".length, openIndex);
    const match = PREFERS_COLOR_SCHEME_RE.exec(prelude);
    if (!match) {
      searchFrom = openIndex + 1;
      continue;
    }
    const body = match[1]?.toLowerCase() === scheme ? output.slice(openIndex + 1, closeIndex) : "";
    output = output.slice(0, mediaIndex) + body + output.slice(closeIndex + 1);
    searchFrom = mediaIndex;
  }
}

function resolveCurrentColor(svg: string): string {
  let color: string | null = null;
  for (const styleBlock of svg.matchAll(STYLE_BLOCK_RE)) {
    for (const declaration of (styleBlock[1] ?? "").matchAll(COLOR_DECLARATION_RE)) {
      const value = declaration[1]?.trim();
      if (value) color = value;
    }
  }
  color ??= ROOT_COLOR_ATTRIBUTE_RE.exec(svg)?.[1]?.trim() ?? null;
  if (!color || /^(?:currentcolor|inherit|initial|unset)$/i.test(color)) {
    return DEFAULT_CURRENT_COLOR;
  }
  return color;
}

/**
 * Native SVG rasterizers (CoreSVG on iOS, expo-image's Android decoder) ignore
 * `prefers-color-scheme` media queries and `currentColor`, so an adaptive icon
 * renders black in dark mode. Resolve both against the app's color scheme so
 * the bytes handed to the decoder already carry the intended colors.
 */
export function resolveSvgAppearance(svg: string, scheme: FaviconColorScheme): string {
  const resolved = resolveColorSchemeMediaQueries(svg, scheme);
  if (!resolved.match(CURRENT_COLOR_RE)) return resolved;
  return resolved.replace(CURRENT_COLOR_RE, resolveCurrentColor(resolved));
}

/** Rewrites an inline SVG favicon for the color scheme; other sources pass through unchanged. */
export function resolveFaviconUrlAppearance(url: string, scheme: FaviconColorScheme): string {
  if (!url.startsWith(SVG_DATA_URL_PREFIX)) return url;
  const decoded = Encoding.decodeBase64String(url.slice(SVG_DATA_URL_PREFIX.length));
  if (Result.isFailure(decoded)) return url;
  const resolved = resolveSvgAppearance(decoded.success, scheme);
  if (resolved === decoded.success) return url;
  return `${SVG_DATA_URL_PREFIX}${Encoding.encodeBase64(resolved)}`;
}
