import { THEME_FILE_MAX_BYTES, type PickedThemeFile } from "@t3tools/contracts";

import {
  getAvailableOmarchyLinkedTheme,
  OMARCHY_LINKED_THEME_ID,
  OMARCHY_LINKED_THEME_LABEL,
  setOmarchyLinkedTheme,
  type ThemeDefinition,
} from "./themePalette";
import { isVsCodeThemeFile, parseVsCodeThemeFile } from "./vscodeThemeImport";

export type OmarchyLinkedThemeSyncResult =
  | Readonly<{ status: "updated"; theme: ThemeDefinition }>
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "preserved"; theme: ThemeDefinition | null; error: unknown }>;

export function syncOmarchyLinkedTheme(file: PickedThemeFile | null): OmarchyLinkedThemeSyncResult {
  if (file === null) {
    setOmarchyLinkedTheme(null);
    return { status: "removed" };
  }

  try {
    if (file.size > THEME_FILE_MAX_BYTES || file.text.length === 0) {
      throw new Error("The generated Omarchy theme file is empty or too large.");
    }
    const value: unknown = JSON.parse(file.text);
    if (!isVsCodeThemeFile(value)) {
      throw new Error("The generated Omarchy theme is not a VS Code color theme.");
    }
    const imported = parseVsCodeThemeFile(value);
    const theme: ThemeDefinition = {
      ...imported,
      id: OMARCHY_LINKED_THEME_ID,
      label: OMARCHY_LINKED_THEME_LABEL,
    };
    setOmarchyLinkedTheme(theme);
    return { status: "updated", theme };
  } catch (error) {
    return { status: "preserved", theme: getAvailableOmarchyLinkedTheme(), error };
  }
}
