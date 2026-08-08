import type { ThemeColors } from "@t3tools/themes";

export type SidebarRowTextRole = "foreground" | "muted";

/** Returns the canonical sidebar text role, or undefined for the stock palette. */
export function getSidebarRowTextColor(
  themeColors: ThemeColors | null | undefined,
  role: SidebarRowTextRole,
): string | undefined {
  if (!themeColors) return undefined;
  return role === "foreground" ? themeColors.sidebarForeground : themeColors.sidebarMutedForeground;
}
