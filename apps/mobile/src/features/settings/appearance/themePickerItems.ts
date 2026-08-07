import { BUILT_IN_THEME_DEFINITIONS, type ThemeDefinition } from "@t3tools/themes";

export interface ThemePickerItem {
  readonly id: string;
  readonly label: string;
  readonly definition: ThemeDefinition;
}

/** Kept platform-free so roster behavior can be tested without loading React Native. */
export function buildThemePickerItems(
  definitions: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEME_DEFINITIONS,
): ReadonlyArray<ThemePickerItem> {
  return definitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    definition,
  }));
}
