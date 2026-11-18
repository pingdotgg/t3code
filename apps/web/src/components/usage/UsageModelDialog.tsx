import { T, useGT, useLocale, Var } from "gt-react";
import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";

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
  const gt = useGT();
  const locale = useLocale();
  const usage = mergeAnsweredUsage(
    environments,
    (bucket) => bucket.provider === model.provider && bucket.model === model.model,
  );
  const providers = [model.provider];
  const presentation = PROVIDER_PRESENTATION[model.provider];
  const costUnknown = isModelCostUnknown(model);
  const hitRate = cacheHitRate(model);
  const perMillion = costPerMillionTokens(model);
  const stats = [
    { label: gt("Cost"), value: costUnknown ? gt("Unpriced") : formatUsd(model.costUsd, locale) },
    { label: gt("Tokens"), value: formatTokens(model.totalTokens) },
    perMillion === null
      ? null
      : { label: gt("Per 1M tokens"), value: formatUsd(perMillion, locale) },
    hitRate === null ? null : { label: gt("Cache hit"), value: formatPercent(hitRate) },
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
            {costUnknown
              ? ""
              : ` · ${gt("{share} of cost", { share: formatPercent(model.costShare) })}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-8">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-ui text-muted-foreground">{stat.label}</dt>
                  <dd className="text-2xl font-semibold text-foreground">{stat.value}</dd>
                </div>
              ))}
            </dl>

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
                  label={gt("Cost by type")}
                  segments={costTypeSegments(usage.categoryCost)}
                  format={(value: number) => formatUsd(value, locale)}
                />
              )}
              <UsageShareBar
                label={gt("Tokens by type")}
                segments={tokenTypeSegments(model.tokens)}
                format={formatTokens}
              />
              {usage.speedCost.fast + usage.speedCost.ultrafast > 0 ? (
                <UsageShareBar
                  label={gt("Cost by speed")}
                  segments={speedCostSegments(usage.speedCost)}
                  format={(value: number) => formatUsd(value, locale)}
                  aside={<SpeedPremium premiumUsd={usage.speedCost.premium} />}
                />
              ) : null}
            </div>
          </div>
        </DialogPanel>
        {model.unpricedTokens > 0 ? (
          <DialogFooter variant="bare" className="items-center sm:justify-between">
            <span className="text-ui text-muted-foreground">
              {gt("{tokens} tokens have no known price", {
                tokens: formatTokens(model.unpricedTokens),
              })}
            </span>
            <Button onClick={onSetPrice}>
              <T>Set price</T>
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

export function SpeedPremium({ premiumUsd }: { readonly premiumUsd: number }) {
  const locale = useLocale();
  return (
    <span className="text-ui text-muted-foreground">
      <T>
        Premium{" "}
        <span className="text-foreground tabular-nums">
          <Var>{formatUsd(premiumUsd, locale)}</Var>
        </span>
      </T>
    </span>
  );
}
