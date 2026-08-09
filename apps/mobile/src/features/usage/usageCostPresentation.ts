import { formatCostEstimate, formatPercent } from "@t3tools/shared/usageFormat";

export const USAGE_COST_GUIDE =
  "Cost guide: ≥ means a lower-bound estimate from matching API rates; — means no matching rate. Token totals remain complete.";

export interface UsageCostPresentation {
  readonly amount: string;
  readonly headline: string;
  readonly headlineDetail: string;
  readonly chartLabel: string;
  readonly costShare: string;
  readonly unpricedDetail: string | null;
  readonly hasUnpriced: boolean;
}

/** User-facing cost language shared by the mobile headline and breakdown rows. */
export function presentUsageCost(
  costUsd: number,
  unpricedShare: number,
  costShare: number,
): UsageCostPresentation {
  const estimate = formatCostEstimate(costUsd, unpricedShare);
  const hasUnpriced = unpricedShare > 0;

  return {
    amount: estimate.value,
    headline: estimate.value === "—" ? estimate.value : `${estimate.value}*`,
    headlineDetail: !hasUnpriced
      ? "* if billed at full API rate"
      : estimate.value === "—"
        ? estimate.detail
        : `* ${estimate.detail}`,
    chartLabel: hasUnpriced ? "Raw token cost (partial)" : "Raw token cost",
    costShare: unpricedShare >= 1 ? "—" : formatPercent(costShare),
    unpricedDetail: hasUnpriced ? `${formatPercent(unpricedShare)} unpriced` : null,
    hasUnpriced,
  };
}

/** Describes one provider/model's share without treating unpriced records as free. */
export function presentUsageCostShare(
  cost: UsageCostPresentation,
  totalUnpricedShare: number,
): string {
  if (cost.costShare === "—") {
    return `No priced-cost share${cost.unpricedDetail === null ? "" : ` · ${cost.unpricedDetail}`}`;
  }
  const label = totalUnpricedShare > 0 ? "priced cost" : "cost";
  return `${cost.costShare} of ${label}${cost.unpricedDetail === null ? "" : ` · ${cost.unpricedDetail}`}`;
}
