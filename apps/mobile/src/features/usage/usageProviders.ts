import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars. Declaration order
 * here is the single source of that order, and `satisfies` keeps it exhaustive:
 * a new provider in the contract fails to compile until it is listed.
 */
export const PROVIDER_LABEL = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  opencode: "OpenCode",
} satisfies Record<UsageProviderKind, string>;

export const PROVIDER_ORDER = Object.keys(PROVIDER_LABEL) as readonly UsageProviderKind[];

/**
 * Claude's brand orange holds in both themes; the rest are neutrals and must
 * flip with the theme or their bars vanish against the matching background.
 * Codex, Grok and OpenCode all have monochrome marks, so they share one zinc
 * ramp and step away from the foreground in declaration order rather than
 * borrowing hues they do not own — the same reasoning the web usage screen
 * encodes as 100% / 72% / 46% of `--contrast-foreground`.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    claude: "#d97757",
    codex: dark ? "#e6e6e6" : "#3c3c43",
    grok: dark ? "#a1a1aa" : "#52525b",
    // zinc-500: one stop past Grok in both directions, so the ramp converges
    // to a mid grey that reads on the dark card and on white alike.
    opencode: "#71717a",
  };
}
