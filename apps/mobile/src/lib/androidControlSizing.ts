import { DEFAULT_BASE_FONT_SIZE, normalizeBaseFontSize } from "./appearancePreferences";

/** Android controls follow the app's text size; buttons and menu rows retain a 48dp touch target. */
export function resolveAndroidControlSizing(baseFontSize: number) {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  const iconSize = Math.round(24 * scale);
  const buttonSize = Math.max(48, Math.round(48 * scale));
  const fabSize = Math.max(48, Math.round(56 * scale));

  return {
    scale,
    iconSize,
    smallIconSize: Math.round(16 * scale),
    mediumIconSize: Math.round(18 * scale),
    buttonSize,
    fabSize,
    largeFabSize: Math.round(96 * scale),
    menuWidth: Math.round(250 * scale),
    menuItemHeight: Math.max(48, Math.round(48 * scale)),
    // Two floating actions, their gap, and the space below the lower action.
    fabClearance: fabSize * 2 + 36,
  };
}
