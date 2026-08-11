import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderQuotaSnapshot,
  type ProviderQuotaSummary,
} from "@t3tools/contracts";

import type { OrderedProviderSettingsRow } from "../settings/ProviderSettingsPanel.logic";

export interface ProviderUsageStripItem {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly percentage: number | null;
  readonly headlineLabel: string | null;
  readonly snapshot: ProviderQuotaSnapshot | null;
}

export function buildProviderUsageStripItems(input: {
  readonly rows: ReadonlyArray<OrderedProviderSettingsRow>;
  readonly summary: ProviderQuotaSummary | null;
}): ReadonlyArray<ProviderUsageStripItem> {
  const snapshotsByInstanceId = new Map(
    input.summary?.instances.map((snapshot) => [snapshot.instanceId, snapshot]) ?? [],
  );

  return input.rows.flatMap((row) => {
    if (row.instance.enabled === false) return [];

    const snapshot = snapshotsByInstanceId.get(row.instanceId) ?? null;
    const headlineMetric =
      snapshot?.status === "current" && snapshot.headlineMetricKey !== null
        ? (snapshot.metrics.find((metric) => metric.key === snapshot.headlineMetricKey) ?? null)
        : null;
    const eligibleMetric = headlineMetric?.blocking === true ? headlineMetric : null;
    const remaining = eligibleMetric?.remainingPercent;
    const percentage =
      remaining === null || remaining === undefined
        ? null
        : Math.round(Math.min(100, Math.max(0, remaining)));

    return [
      {
        instanceId: row.instanceId,
        driver: row.driver,
        displayName:
          row.instance.displayName?.trim() ||
          PROVIDER_DISPLAY_NAMES[row.driver] ||
          String(row.instanceId),
        percentage,
        headlineLabel: percentage === null ? null : (eligibleMetric?.label ?? null),
        snapshot,
      },
    ];
  });
}

export function providerUsageAriaLabel(item: ProviderUsageStripItem): string {
  return item.percentage === null || item.headlineLabel === null
    ? `${item.displayName}: usage remaining unavailable`
    : `${item.displayName}: ${item.percentage}% remaining, ${item.headlineLabel}`;
}
