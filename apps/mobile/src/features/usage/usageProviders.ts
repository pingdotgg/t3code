import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Series and table order. The chart layers providers from a shared baseline;
 * fill paint order is decided by total usage so the lighter series stays visible.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * Claude's brand orange holds in both themes; Codex is neutral and must flip
 * with the theme or its line vanishes against the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
  };
}
