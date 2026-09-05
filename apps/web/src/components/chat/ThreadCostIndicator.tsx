import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { type ThreadCostSnapshot, useThreadCost } from "../../state/threadCost";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const STANDARD_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const SMALL_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatThreadCostUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return STANDARD_USD.format(0);
  return value < 0.01 ? SMALL_USD.format(value) : STANDARD_USD.format(value);
}

function CostRow(props: {
  readonly label: string;
  readonly tokens?: number | undefined;
  readonly costUsd: number | null;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 text-[11px] leading-5">
      <span className="min-w-0 text-secondary-label">
        {props.label}
        {props.tokens === undefined ? null : (
          <span className="ms-1 text-tertiary-label">{formatTokens(props.tokens)} tokens</span>
        )}
      </span>
      <span className="font-medium text-muted-foreground tabular-nums">
        {props.costUsd === null ? "Unavailable" : formatThreadCostUsd(props.costUsd)}
      </span>
    </div>
  );
}

export function ThreadCostIndicator({ cost }: { readonly cost: ThreadCostSnapshot }) {
  const formattedTotal = formatThreadCostUsd(cost.costUsd);
  const freshTokens = cost.uncachedInputTokens + cost.outputTokens;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            data-thread-cost-indicator="true"
            className="cursor-default rounded-full px-1.5 text-[11px] text-secondary-label tabular-nums hover:bg-muted/60 hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={`Thread API cost ${formattedTotal}`}
            onPointerDown={(event) => event.preventDefault()}
          >
            {formattedTotal}
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col p-[var(--floating-content-inset)]">
          <div className="mb-1 flex items-baseline justify-between gap-4">
            <span className="font-medium text-muted-foreground text-xs">Thread API cost</span>
            <span className="font-semibold text-foreground text-sm tabular-nums">
              {formattedTotal}
            </span>
          </div>
          <CostRow
            label="Cache writes, estimated"
            tokens={cost.cacheCreationTokens}
            costUsd={cost.cacheWriteUsd}
          />
          <CostRow
            label="Cache reads"
            tokens={cost.cachedInputTokens}
            costUsd={cost.cacheReadUsd}
          />
          <CostRow label="Fresh input + output" tokens={freshTokens} costUsd={cost.freshUsd} />
          {cost.providerReportedUsd > 0.000_001 ? (
            <CostRow label="Provider-reported remainder" costUsd={cost.providerReportedUsd} />
          ) : null}
          <p className="mt-1 border-border/60 border-t pt-2 text-tertiary-label text-[10px] leading-4">
            API-equivalent cost. Subscription billing may differ.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ComposerThreadCostIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly refreshKey: string | null;
}) {
  const { cost } = useThreadCost(props);
  return cost === null ? null : <ThreadCostIndicator cost={cost} />;
}
