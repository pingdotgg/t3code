import type { UsageProviderKind } from "@t3tools/contracts";
import { flattenThemeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
];

export function usageProviderKind(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  return PROVIDER_ORDER.find((kind) => kind === driver) ?? null;
}

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse Code",
};

export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
    cursor: "#8b8b8b",
    opencode: "#5b9bbd",
    antigravity: "#8c7bd1",
    pi: "#4d9f8a",
    muse: "#0866ff",
  };
}

/** Flatten the lighter thinking bands against the chart card for native charts. */
export function useProviderThinkingColors(): Record<UsageProviderKind, string> {
  const colors = useProviderColors();
  const surface = useUniwindTheme()["--color-grouped-card"];
  const thinking = { ...colors };
  for (const provider of PROVIDER_ORDER) {
    thinking[provider] = flattenThemeColor(themeColorWithAlpha(colors[provider], 0.45), surface);
  }
  return thinking;
}

/**
 * Neutral steps for cost and token mixes, so they never borrow a provider's
 * color. Matches the web steps: oklab mixes of the codex ink into the
 * background, above the 15 ΔE separation floor for adjacent segments.
 */
export function useUsageMixColors() {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    input: dark ? "#737373" : "#848484",
    cacheRead: dark ? "#282828" : "#c0c0c0",
    cacheWrite: dark ? "#949494" : "#6d6d6d",
    output: dark ? "#e6e6e6" : "#3c3c43",
    other: dark ? "#494949" : "#a3a3a3",
    standard: dark ? "#313131" : "#b8b8b8",
    fast: dark ? "#838383" : "#797979",
    ultrafast: dark ? "#e6e6e6" : "#3c3c43",
  };
}
