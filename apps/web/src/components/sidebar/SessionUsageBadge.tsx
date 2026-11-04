import { type EnvironmentId, type ThreadId, UsageDay } from "@t3tools/contracts";
import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatSessionCost, sessionTokenCount } from "../../lib/sessionUsage";

const WINDOW = {
  sinceDay: UsageDay.make("2000-01-01"),
  untilDay: UsageDay.make("9999-12-31"),
  timeZone: "UTC",
  includeThreadUsage: true,
};
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function SessionUsageBadge({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const query = useEnvironmentQuery(
    canRead ? serverEnvironment.threadUsageSummary({ environmentId, input: WINDOW }) : null,
  );
  const usage = query.data?.threadUsage?.find((entry) => entry.threadId === threadId);
  if (!canRead) return null;
  const tokens = usage ? sessionTokenCount(usage.totals) : null;
  const price = usage ? formatSessionCost(usage.costUsd, usage.unpricedRecords > 0) : "$?";
  const rows = usage
    ? ([
        ["Tokens in", usage.totals.uncachedInputTokens, usage.categoryCostUsd.input],
        ["Tokens out", usage.totals.outputTokens, usage.categoryCostUsd.output],
        [
          "Cached tokens in (reads)",
          usage.totals.cachedInputTokens,
          usage.categoryCostUsd.cacheRead,
        ],
        ["Cache writes", usage.totals.cacheCreationTokens, usage.categoryCostUsd.cacheWrite],
      ] as const)
    : [];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
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
      </TooltipTrigger>
      <TooltipPopup side="top">
        {usage ? (
          <div className="grid grid-cols-[auto_auto_auto] gap-x-3 gap-y-1 text-xs tabular-nums">
            <span className="col-span-3 font-medium">
              Session usage · API-equivalent USD estimate
            </span>
            <span>Category</span>
            <span>Tokens</span>
            <span>Cost</span>
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
            <span>Not reported</span>
            <span>N/A</span>
            {usage.unsplitCostUsd > 0 ? (
              <>
                <span className="col-span-2">Provider-reported cost without breakdown</span>
                <span>{money.format(usage.unsplitCostUsd)}</span>
              </>
            ) : null}
            <span className="col-span-2 font-medium">Total</span>
            <span>
              {usage.unpricedRecords > 0
                ? `At least ${money.format(usage.costUsd)}`
                : money.format(usage.costUsd)}
            </span>
            <span className="col-span-3 text-muted-foreground">
              Cache writes are input saved for reuse. Updates every minute.
            </span>
            {usage.unpricedRecords > 0 ? (
              <span className="col-span-3">Some records have no known price.</span>
            ) : null}
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
