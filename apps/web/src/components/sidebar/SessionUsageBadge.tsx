import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { sessionUsageAtom } from "../../state/sessionUsage";
import { useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatSessionCost, sessionTokenCount, sessionSpendRate } from "../../lib/sessionUsage";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function SessionUsageBadge({
  environmentId,
  threadId,
  working,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  working: boolean;
}) {
  const rowAnchor = useRef<HTMLElement | null>(null);
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const query = useEnvironmentQuery(canRead ? sessionUsageAtom(environmentId) : null);
  const usage = query.data?.threadUsage?.find((entry) => entry.threadId === threadId);
  const sampleKey = `${environmentId}:${threadId}:${working}`;
  const [sample, setSample] = useState({ key: sampleKey, at: 0, cost: 0, rate: 0 });
  if (sample.key !== sampleKey || (usage && query.dataUpdatedAt !== sample.at)) {
    setSample({
      key: sampleKey,
      at: query.dataUpdatedAt,
      cost: usage?.costUsd ?? 0,
      rate:
        working && sample.key === sampleKey && usage
          ? sessionSpendRate(sample.cost, sample.at, usage.costUsd, query.dataUpdatedAt)
          : 0,
    });
  }
  const burningFast = working && sample.key === sampleKey && sample.rate >= 1;
  if (!canRead) return null;
  const tokens = usage ? sessionTokenCount(usage.totals) : null;
  const price = usage ? formatSessionCost(usage.costUsd, usage.unpricedRecords > 0) : "$?";
  const rows = usage
    ? ([
        ["Tokens in", usage.totals.uncachedInputTokens, usage.categoryCostUsd.input],
        ["Tokens out", usage.totals.outputTokens, usage.categoryCostUsd.output],
        ["Cached tokens in", usage.totals.cachedInputTokens, usage.categoryCostUsd.cacheRead],
        ["Cache writes", usage.totals.cacheCreationTokens, usage.categoryCostUsd.cacheWrite],
      ] as const)
    : [];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            ref={(element) => {
              rowAnchor.current = element?.closest<HTMLElement>("[data-sidebar-row]") ?? element;
            }}
            className="pointer-events-auto inline-flex shrink-0 items-center gap-1 tabular-nums"
            tabIndex={0}
            aria-label={
              tokens === null
                ? "Session usage unavailable"
                : `${tokens.toLocaleString("en-US")} tokens, estimated cost ${price}`
            }
          />
        }
      >
        {tokens === null ? null : (
          <span className="hidden @min-[19rem]/session:inline">
            {new Intl.NumberFormat("en-US", {
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(tokens)}
          </span>
        )}
        <span>{price}</span>
        {burningFast ? (
          <span className="text-destructive font-bold" aria-label="High spending rate">
            !
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="right" align="start" sideOffset={4} anchor={rowAnchor} variant="glass">
        {usage ? (
          <div className="flex max-w-72 flex-col items-start gap-1 text-xs tabular-nums">
            <span className="font-medium">Session usage · API-equivalent USD estimate</span>
            {burningFast ? (
              <span className="text-destructive">
                High spending: ${sample.rate.toFixed(2)}/min (warning at $1/min).
              </span>
            ) : null}
            <div className="grid grid-cols-[max-content_max-content_max-content] gap-x-2 gap-y-1">
              <span>Category</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
              {rows.map(([label, count, cost]) => (
                <div key={label} className="contents">
                  <span>{label}</span>
                  <span className="text-right">{count.toLocaleString("en-US")}</span>
                  <span className="text-right">
                    {usage.unpricedRecords > 0 ? "Unavailable" : money.format(cost)}
                  </span>
                </div>
              ))}
              <span>Cached tokens out</span>
              <span className="text-right">Not reported</span>
              <span className="text-right">N/A</span>
              {usage.unsplitCostUsd > 0 ? (
                <>
                  <span className="col-span-2">Provider-reported cost without breakdown</span>
                  <span className="text-right">{money.format(usage.unsplitCostUsd)}</span>
                </>
              ) : null}
              <span className="col-span-2 font-medium">Total</span>
              <span className="text-right">
                {usage.unpricedRecords > 0
                  ? `At least ${money.format(usage.costUsd)}`
                  : money.format(usage.costUsd)}
              </span>
            </div>
            <span className="max-w-64 text-muted-foreground">
              Cache writes save input for reuse. Refreshes every minute while working.
            </span>
            {usage.unpricedRecords > 0 ? <span>Some records have no known price.</span> : null}
          </div>
        ) : query.isPending ? (
          "Loading session usage…"
        ) : (
          "Session usage is unavailable. No matching provider transcript, or this server needs updating."
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
