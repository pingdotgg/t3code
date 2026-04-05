/**
 * Spring animation profiles for Niri-style spatial canvas navigation.
 *
 * Values are tuned to match the user's Niri compositor config:
 *   - damping-ratio = 1.0 (critical damping — no overshoot)
 *   - stiffness ~900–1000
 *
 * react-spring maps: tension ≈ stiffness, friction ≈ 2 * sqrt(stiffness) for critical damping.
 */
export const SPRING_PROFILES = {
  /** Horizontal thread-to-thread navigation (stiffness≈900, critical damping) */
  horizontalNav: { tension: 350, friction: 26, clamp: true },

  /** Vertical project-to-project navigation (stiffness≈1000, critical damping) */
  verticalNav: { tension: 400, friction: 28, clamp: true },

  /** Overview zoom in/out (stiffness≈900, allows slight settle) */
  overview: { tension: 350, friction: 26 },

  /** Preview card reveal (~200ms equivalent, clamped) */
  cardReveal: { tension: 400, friction: 30, clamp: true },

  /** Preview card dismiss (~200ms equivalent, clamped) */
  cardDismiss: { tension: 300, friction: 28, clamp: true },
} as const;

export type SpringProfile = keyof typeof SPRING_PROFILES;

/** Gap between columns in pixels (matches Niri's 5px gaps config) */
export const COLUMN_GAP = 5;

/** Preview card width in pixels */
export const PREVIEW_COLUMN_WIDTH = 280;

/** Available column width presets as fractions of viewport width */
export const COLUMN_WIDTH_PRESETS = [1 / 3, 1 / 2, 2 / 3, 1.0] as const;
export type ColumnWidthPreset = (typeof COLUMN_WIDTH_PRESETS)[number];

/** Default column width preset */
export const DEFAULT_COLUMN_WIDTH_PRESET: ColumnWidthPreset = 2 / 3;
