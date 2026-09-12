import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";

function PoolWindowRow({
  window,
  color,
  now,
}: {
  readonly window: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  // The soonest reset that hands anything back, as the Usage page picks it.
  const nextReset = window.resets.find((reset) => reset.restoresPercent > 0);
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-2 leading-5">
      <span className="truncate text-muted-foreground">{window.label}</span>
      {/* Pooled across the provider's accounts, like the Usage page headline. */}
      <span aria-hidden className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
        />
      </span>
      <span className="shrink-0 text-end tabular-nums">
        <span className="font-medium text-foreground">{window.remainingPercent}%</span>
        {nextReset ? (
          <span className="text-muted-foreground">
            {" "}
            · {nextReset.at <= now ? "now" : formatDuration(nextReset.at - now)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function PoolRows({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 leading-5 font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--popover)"
          className="size-4"
          iconClassName="size-3 text-foreground/80"
        />
        {label}
        {pool.accounts.length > 1 ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {pool.accounts.length} accounts
          </span>
        ) : null}
      </span>
      {pool.windows.map((window) => (
        <PoolWindowRow
          key={`${window.kind}:${window.id}`}
          window={window}
          color={barColor(pool.driver)}
          now={now}
        />
      ))}
    </div>
  );
}

/**
 * Spend over the past day and what is left on each subscription window, read
 * from the same query and provider snapshots the Usage page uses. The footer
 * item supplies the frame and heading. Mounted only while the popover is open.
 */
export function SidebarUsagePreview() {
  // Anchored once per open: countdowns must not tick, and a fixed window keeps
  // the query key stable so it is not re-issued on every render.
  const [now] = useState(() => Date.now());
  const [window] = useState(() => makeWindow(1, new Date(now), "hour"));
  const { merged, selectedEnvironments, isPending, isPartial } = useUsage(window);
  const answered = selectedEnvironments.some((environment) => environment.summary !== null);
  const failed = selectedEnvironments.some((environment) => environment.error !== null);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const pools = useMemo(
    () => collectLimitPools(collectLimitAccounts(presentations), now),
    [now, presentations],
  );
  const notices = useMemo(() => collectLimitNotices(presentations), [presentations]);

  return (
    <>
      <div className="flex items-baseline justify-between gap-3 leading-5">
        <span className="text-muted-foreground">Spend, past 24h</span>
        <span className="font-medium text-foreground tabular-nums">
          {isPending ? "…" : answered ? formatUsd(merged.costUsd) : failed ? "Failed" : "—"}
          {answered && (isPartial || failed) ? (
            <span className="font-normal text-muted-foreground"> · partial</span>
          ) : null}
        </span>
      </div>
      {pools.length > 0 || notices.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
          {pools.map((pool) => (
            <PoolRows key={pool.driver} pool={pool} now={now} />
          ))}
          {notices.length > 0 ? (
            <ul className="flex flex-col gap-1 text-muted-foreground">
              {notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
