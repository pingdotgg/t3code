/**
 * Shared accent-color primitives.
 *
 * Accent colors are user-chosen hex strings used to tell otherwise identical
 * UI affordances apart — provider instances in picker rails, environments in
 * the sidebar. They are always stored normalized so rendering can treat a
 * present value as directly usable in CSS.
 */

export const ACCENT_COLOR_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

export const FALLBACK_ACCENT_COLOR = ACCENT_COLOR_SWATCHES[0];

/** Accept only `#rrggbb`; anything else (including "") reads as "no color". */
export function normalizeAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}
