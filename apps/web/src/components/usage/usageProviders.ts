import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenAI } from "../Icons";
import { seriesKey, type ProviderTotals } from "../../usage/usageMerge";

/**
 * Series and table order. The chart layers every series from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Claude's brand orange against a neutral white for Codex. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
};

/**
 * Shade ramps within each provider's hue, used when one provider reports from
 * several homes. The first shade is the provider's base colour, so a
 * single-home setup renders exactly as before.
 */
const PROVIDER_SHADES: Record<UsageProviderKind, readonly string[]> = {
  claude: ["#d97757", "#8f4a33", "#eda183", "#5e2f20"],
  codex: ["#e6e6e6", "#8a8a8a", "#bcbcbc", "#5c5c5c"],
};

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills (`#d97757` for Claude, white on dark for OpenAI),
 * which are the same colours as the chart bands, so swapping a colour dot for a
 * mark keeps the series association intact rather than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
};

/** One chart/legend/table series: a provider home with its presentation. */
export interface UsageSeries {
  readonly key: string;
  readonly provider: UsageProviderKind;
  readonly homeLabel: string | null;
  readonly label: string;
  readonly color: string;
}

/**
 * Derives the rendered series from the merged provider totals, in stable
 * provider-then-label order with a distinct shade per home.
 */
export function buildSeries(providers: readonly ProviderTotals[]): readonly UsageSeries[] {
  const ordered = [...providers].sort(
    (a, b) =>
      PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) ||
      // The unnamed default home reads first within its provider.
      (a.homeLabel === null ? "" : a.homeLabel).localeCompare(
        b.homeLabel === null ? "" : b.homeLabel,
      ),
  );

  const shadeIndex = new Map<UsageProviderKind, number>();
  return ordered.map((totals) => {
    const index = shadeIndex.get(totals.provider) ?? 0;
    shadeIndex.set(totals.provider, index + 1);
    const shades = PROVIDER_SHADES[totals.provider];
    return {
      key: seriesKey(totals.provider, totals.homeLabel),
      provider: totals.provider,
      homeLabel: totals.homeLabel,
      label:
        totals.homeLabel === null
          ? PROVIDER_LABEL[totals.provider]
          : `${PROVIDER_LABEL[totals.provider]} · ${totals.homeLabel}`,
      color: shades[index % shades.length] ?? PROVIDER_COLOR[totals.provider],
    };
  });
}
