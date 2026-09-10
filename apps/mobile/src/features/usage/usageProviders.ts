import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "copilot", "grok"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  grok: "Grok Build",
};

/**
 * Claude's brand orange holds in both themes; Codex and Grok are neutrals and
 * must flip with the theme or their bars vanish against the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    copilot: scheme === "dark" ? "#58a6ff" : "#1f6feb",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
  };
}
