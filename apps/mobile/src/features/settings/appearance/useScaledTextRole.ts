import { useMemo } from "react";

import {
  DEFAULT_BASE_FONT_SIZE,
  normalizeBaseFontSize,
  scaledTypographyLineHeight,
} from "../../../lib/appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "../../../lib/typography";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export interface ScaledTextRole {
  readonly fontSize: number;
  readonly lineHeight: number;
}

/**
 * Mirrors the values injected into Uniwind for style-prop consumers that
 * cannot use a `text-*` class. This deliberately does not subscribe to CSS
 * variables, so palette-only setTheme calls remain native-only.
 */
export function useScaledTextRole(role: keyof typeof MOBILE_TYPOGRAPHY): ScaledTextRole {
  const { appearance } = useAppearancePreferences();
  return useMemo(() => {
    const baseFontSize = normalizeBaseFontSize(appearance.baseFontSize);
    const typography = MOBILE_TYPOGRAPHY[role];
    return {
      fontSize: Math.max(
        8,
        Math.round(typography.fontSize * (baseFontSize / DEFAULT_BASE_FONT_SIZE)),
      ),
      lineHeight: scaledTypographyLineHeight(typography, baseFontSize),
    };
  }, [appearance.baseFontSize, role]);
}
