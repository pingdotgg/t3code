/**
 * Inline code that is *only* a CSS color literal gets a swatch rendered next to
 * it, the way editors decorate color literals in source. Prose keeps its meaning
 * when the swatch is stripped, so the match has to be exact — a span containing
 * a color plus anything else stays plain code.
 */

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Numbers, percentages, angles, `none`, separators, and the alpha slash — the
// full argument grammar these functions share, and nothing that could close the
// declaration this value ends up in.
const COLOR_FUNCTION_ARGUMENTS_PATTERN = /^[0-9a-z%.,/\s+-]*$/i;
const COLOR_FUNCTION_PATTERN = /^([a-z]+)\(([^()]*)\)$/i;
const COLOR_FUNCTION_NAMES = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
]);

function supportsColorValue(value: string): boolean {
  // jsdom has no CSS.supports; the patterns above already bound what can reach
  // a style attribute, so shape validation stands on its own there.
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  return CSS.supports("color", value);
}

/**
 * Returns the color to paint a swatch with, or null when the text isn't a
 * standalone color literal.
 */
export function resolveInlineCodeColor(text: string): string | null {
  const value = text.trim();
  if (value.length === 0 || value.length > 64) return null;

  if (HEX_COLOR_PATTERN.test(value)) {
    return supportsColorValue(value) ? value : null;
  }

  const functionMatch = COLOR_FUNCTION_PATTERN.exec(value);
  const functionName = functionMatch?.[1]?.toLowerCase();
  const functionArguments = functionMatch?.[2];
  if (
    functionName == null ||
    functionArguments == null ||
    !COLOR_FUNCTION_NAMES.has(functionName) ||
    !COLOR_FUNCTION_ARGUMENTS_PATTERN.test(functionArguments)
  ) {
    return null;
  }

  return supportsColorValue(value) ? value : null;
}
