// Fork: Kaluwa's built-in themes, built from the presets in kaluwaPalette.ts. themePalette.ts
// passes its own generator in, so this module never imports it back.
import type {
  ThemeAppearance,
  ThemeColorRole,
  ThemeColors,
  ThemeDefinition,
} from "@t3tools/shared/themePalettes";

import {
  KALUWA_PRESETS,
  KALUWA_PRESET_IDS,
  kaluwaThemeRoleColors,
  type KaluwaPreset,
} from "./kaluwaPalette";

export type KaluwaThemeBuilders = Readonly<{
  /** A full palette generated from a canvas and accent, for the roles a preset leaves out. */
  generate: (appearance: ThemeAppearance, canvas: string, accent: string) => ThemeColors;
  /** The app's canonical form of a colour, or null when it does not parse. */
  canonical: (value: string) => string | null;
}>;

const KALUWA_THEME_LABELS: Readonly<Record<string, string>> = {
  ember: "Kaluwa Ember",
  tide: "Graphite Tide",
  noir: "Noir Rider",
  paper: "Paper",
};

function presetColors(
  preset: KaluwaPreset,
  scheme: ThemeAppearance,
  builders: KaluwaThemeBuilders,
): ThemeColors {
  const base = builders.generate(scheme, preset[scheme].bg, preset[scheme].accent);
  const colors: Record<ThemeColorRole, string> = { ...base };
  for (const [role, value] of Object.entries(kaluwaThemeRoleColors(preset, scheme))) {
    const canonical = value === undefined ? null : builders.canonical(value);
    if (canonical !== null) colors[role as ThemeColorRole] = canonical;
  }
  return colors;
}

/** Every Kaluwa preset except "Kaluwa today", which is the stock theme, as a theme definition. */
export function buildKaluwaThemes(builders: KaluwaThemeBuilders): ReadonlyArray<ThemeDefinition> {
  const themes: ThemeDefinition[] = [];
  for (const id of KALUWA_PRESET_IDS) {
    const preset = KALUWA_PRESETS[id];
    if (preset.themeId === null) continue;
    const other: ThemeAppearance = preset.scheme === "dark" ? "light" : "dark";
    themes.push({
      id: preset.themeId,
      label: KALUWA_THEME_LABELS[id] ?? id,
      appearance: preset.scheme,
      colors: presetColors(preset, preset.scheme, builders),
      variants: { [other]: presetColors(preset, other, builders) },
      // Keeps Kaluwa's sidebar band, which the stock theme shows too.
      sidebarArtwork: true,
    });
  }
  return themes;
}
