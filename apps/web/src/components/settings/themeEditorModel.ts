import {
  createVividThemeColors,
  THEME_COLOR_ROLES,
  getStandardThemeColors,
  getThemeColorsForMode,
  installCustomTheme,
  isThemeColor,
  removeCustomTheme,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeColorRole,
  type ThemeDefinition,
} from "../../themePalette";
import { THEME_EDITOR_ROLE_GROUPS } from "./ThemeEditorPanelParts";

export const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

export type ThemeEditorColorFamily = Readonly<{
  id: string;
  label: string;
  role: ThemeColorRole;
  roles: ReadonlyArray<ThemeColorRole>;
}>;

export const THEME_EDITOR_COLOR_FAMILIES = THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families);
export const THEME_EDITOR_COLOR_FAMILY_BY_ROLE = new Map(
  THEME_EDITOR_COLOR_FAMILIES.flatMap((family) =>
    family.roles.map((role) => [role, family] as const),
  ),
);

export function getThemeEditorColorFamily(role: ThemeColorRole): ThemeEditorColorFamily | null {
  return THEME_EDITOR_COLOR_FAMILY_BY_ROLE.get(role) ?? null;
}

export type ThemeEditorColors = ThemeColors;
export type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

export function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
}

export function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

export function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
}

export function getManagedEditorColors(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): ThemeEditorColors {
  const defaults = getStandardThemeColors(appearance);
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

export const PANEL_MARGIN = 8;
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MIN_HEIGHT = 220;

/** Keeps the panel horizontally inside the viewport. Vertically only its header must stay
 * visible, so users can park the panel low to see the app behind it. */
export function clampPanelPosition(
  viewport: { readonly width: number; readonly height: number },
  x: number,
  y: number,
  width: number,
) {
  const maxX = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, viewport.height - 48);
  return {
    x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
    y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
  };
}

export const readWindowViewport = () => ({ width: window.innerWidth, height: window.innerHeight });

// Kept out of the component: the compiler cannot lower a throw inside try/catch.
export function retireMergedTheme(retired: ThemeDefinition, mergeTarget: ThemeDefinition) {
  try {
    removeCustomTheme(retired.id);
  } catch (cause) {
    // Restore the pre-merge target on retirement failure; leaving the persisted merge would collide on retry.
    try {
      updateCustomTheme(mergeTarget);
    } catch {}
    throw cause;
  }
}
