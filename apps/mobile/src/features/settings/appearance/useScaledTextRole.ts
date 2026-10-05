import { useMemo } from "react";

import { resolveScaledTextRole } from "../../../lib/appearancePreferences";
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
  return useMemo(
    () => resolveScaledTextRole(role, appearance.baseFontSize),
    [appearance.baseFontSize, role],
  );
}
