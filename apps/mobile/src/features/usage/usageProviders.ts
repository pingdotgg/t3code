import type { UsageProviderKind } from "@t3tools/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "cursor",
  "grok",
  "opencode",
];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};

/**
 * Claude's brand orange holds in both themes; neutral providers flip with the
 * theme or their bars vanish against the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  const light = scheme !== "dark";
  return {
    claude: "#d97757",
    codex: light ? "#3c3c43" : "#e6e6e6",
    cursor: light ? "#4a7c8c" : "#88c0d0",
    grok: light ? "#525252" : "#a3a3a3",
    opencode: light ? "#5c5858" : "#cfcecd",
  };
}
