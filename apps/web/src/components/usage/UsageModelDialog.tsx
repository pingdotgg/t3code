import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";
import { useMemo } from "react";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";
import {
  cacheHitRate,
  costPerMillionTokens,
  costTypeSegments,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageChartWindow {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly referenceTime: string | undefined;
  readonly hour12: boolean;
}

/**
 * One model's usage in the current window, opened from the Breakdown list.
 * The trend and mixes come from the same merge as the page, narrowed to this
 * model's buckets.
 */
export function UsageModelDialog({
  model,
  environments,
  metric,
  chartWindow,
  onSetPrice,
  onClose,
}: {
  readonly model: ModelTotals;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly metric: UsageChartMetric;
  readonly chartWindow: UsageChartWindow;
  readonly onSetPrice: () => void;
  readonly onClose: () => void;
}) {
  const usage = useMemo(
    () =>
      mergeAnsweredUsage(
        environments,
        (bucket) => bucket.provider === model.provider && bucket.model === model.model,
      ),
    [environments, model.provider, model.model],
  );
  const providers = useMemo(() => [model.provider], [model.provider]);
  const presentation = PROVIDER_PRESENTATION[model.provider];
  const costUnknown = isModelCostUnknown(model);
  const hitRate = cacheHitRate(model);
  const perMillion = costPerMillionTokens(model);
  const stats = [
    { label: "Cost", value: costUnknown ? "Unpriced" : formatUsd(model.costUsd) },
    { label: "Tokens", value: formatTokens(model.totalTokens) },
    perMillion === null ? null : { label: "Per 1M tokens", value: formatUsd(perMillion) },
    hitRate === null ? null : { label: "Cache hit", value: formatPercent(hitRate) },
  ].filter((stat) => stat !== null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.label}
              iconClassName="size-5"
            />
            <DialogTitle>{model.model}</DialogTitle>
          </div>
          <DialogDescription>
            {presentation.label}
            {costUnknown ? "" : ` · ${formatPercent(model.costShare)} of cost`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-8">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">{stat.label}</span>
                  <span className="text-2xl font-semibold text-foreground">{stat.value}</span>
                </div>
              ))}
            </div>

            {/* Unpriced cost is unknown, not zero, so its trend shows tokens. */}
            <UsageProviderChart
              providers={providers}
              days={chartWindow.days}
              daily={usage.daily}
              hours={chartWindow.hours}
              hourly={usage.hourly}
              metric={costUnknown ? "tokens" : metric}
              referenceTime={chartWindow.referenceTime}
              resolution={chartWindow.resolution}
              timeZone={chartWindow.timeZone}
              hour12={chartWindow.hour12}
            />

            <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {costUnknown ? null : (
                <UsageShareBar
                  label="Cost by type"
                  segments={costTypeSegments(usage.categoryCost)}
                  format={formatUsd}
                />
              )}
              <UsageShareBar
                label="Tokens by type"
                segments={tokenTypeSegments(model.tokens)}
                format={formatTokens}
              />
              {usage.speedCost.fast + usage.speedCost.ultrafast > 0 ? (
                <UsageShareBar
                  label="Cost by speed"
                  segments={speedCostSegments(usage.speedCost)}
                  format={formatUsd}
                  aside={<SpeedPremium premiumUsd={usage.speedCost.premium} />}
                />
              ) : null}
            </div>
          </div>
        </DialogPanel>
        {model.unpricedTokens > 0 ? (
          <DialogFooter variant="bare" className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {formatTokens(model.unpricedTokens)} tokens have no known price
            </span>
            <Button onClick={onSetPrice}>Set price</Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** What the faster speeds cost above standard rates, beside the speed bar. */
export function SpeedPremium({ premiumUsd }: { readonly premiumUsd: number }) {
  return (
    <span className="text-xs text-muted-foreground">
      Premium <span className="text-foreground tabular-nums">{formatUsd(premiumUsd)}</span>
    </span>
  );
}
