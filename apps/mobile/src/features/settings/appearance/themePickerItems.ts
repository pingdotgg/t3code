import {
  BUILT_IN_THEME_DEFINITIONS,
  createManagedThemeColors,
  type ThemeDefinition,
} from "@t3tools/themes";

export const DEFAULT_THEME_PICKER_ID = "__t3-default__";

const DEFAULT_THEME_DEFINITION: ThemeDefinition = {
  id: DEFAULT_THEME_PICKER_ID,
  label: "Default",
  appearance: "light",
  colors: createManagedThemeColors("light", "#f2f2f7", "#007aff", { exactSeeds: true }),
  variants: {
    dark: createManagedThemeColors("dark", "#0a0a0a", "#0a84ff", { exactSeeds: true }),
  },
};

export interface ThemePickerItem {
  readonly id: string;
  readonly label: string;
  readonly definition: ThemeDefinition;
}

/** Kept platform-free so roster behavior can be tested without loading React Native. */
export function buildThemePickerItems(
  definitions: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEME_DEFINITIONS,
): ReadonlyArray<ThemePickerItem> {
  return [
    {
      id: DEFAULT_THEME_PICKER_ID,
      label: "Default",
      definition: DEFAULT_THEME_DEFINITION,
    },
    ...definitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      definition,
    })),
  ];
}
