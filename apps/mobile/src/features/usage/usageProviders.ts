import type { UsageProviderKind } from "@t3tools/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "grok", "opencode"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

/**
 * Claude's brand orange holds in both themes; Codex, Grok, and OpenCode are
 * neutral and must flip with the theme or their bars vanish against the
 * matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    grok: scheme === "dark" ? "#a8a29e" : "#57534e",
    opencode: scheme === "dark" ? "#cfcecd" : "#6b7280",
  };
}
