import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  formatDuration,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { TooltipPopup } from "../ui/tooltip";
import { barColor } from "./usageProviders";

/** Reads the existing config snapshots only while the tooltip content is mounted. */
function UsageLimitsSummary() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now] = useState(() => Date.now());
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);

  return (
    <div className="flex max-h-[min(28rem,60vh)] flex-col gap-4 overflow-y-auto p-2 text-xs">
      <h2 className="text-sm font-medium">Usage limits</h2>
      {pools.map((pool) => (
        <section key={pool.driver} className="flex flex-col gap-2">
          <h3 className="flex items-baseline justify-between gap-3 font-medium">
            <span>{getDriverOption(pool.driver)?.label ?? String(pool.driver)}</span>
            {pool.accounts.length > 1 ? (
              <span className="font-normal text-muted-foreground">
                {pool.accounts.length} accounts
              </span>
            ) : null}
          </h3>
          {pool.windows.map((window) => {
            const nextRefill = window.resets.find((reset) => reset.restoresPercent > 0);
            return (
              <div key={`${window.kind}:${window.id}`} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words">{window.label}</span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {window.remainingPercent}% left
                  </span>
                </div>
                <div aria-hidden className="h-1 overflow-hidden rounded-sm bg-muted">
                  <div
                    className="h-full rounded-sm"
                    style={{
                      width: `${window.remainingPercent}%`,
                      backgroundColor: barColor(pool.driver),
                    }}
                  />
                </div>
                {nextRefill ? (
                  <span className="text-muted-foreground tabular-nums">
                    +{nextRefill.restoresPercent}%{" "}
                    {nextRefill.at <= now ? "now" : `in ${formatDuration(nextRefill.at - now)}`}
                  </span>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
      {pools.length === 0 && notices.length === 0 ? <p>No subscription limits reported.</p> : null}
      {notices.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground">
          {notices.map((notice) => (
            <li key={notice} className="break-words">
              {notice}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function UsageLimitsTooltip({ id }: { readonly id: string }) {
  return (
    <TooltipPopup
      id={id}
      role="tooltip"
      side="top"
      align="start"
      className="pointer-events-auto w-72 max-w-[calc(100vw-2rem)] text-wrap"
    >
      <UsageLimitsSummary />
    </TooltipPopup>
  );
}
