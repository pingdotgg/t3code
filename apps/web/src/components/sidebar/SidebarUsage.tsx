import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";

const MINUTE_MS = 60_000;

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reset countdowns follow the wall clock
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Each provider's subscription windows as used-percent bars, above the sidebar's links. */
export function SidebarUsage() {
  const gt = useGT();
  const m = useMessages();
  const now = useMinuteNow();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  if (pools.length === 0) return null;
  return (
    <div className="mx-2 mb-1 flex max-h-56 flex-col gap-3 overflow-y-auto rounded-xl border border-input/50 bg-muted/40 p-3 group-data-[collapsible=icon]:hidden">
      <Link
        to="/usage"
        className="font-mono text-2xs text-muted-foreground uppercase tracking-widest outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {gt("Usage")}
      </Link>
      {pools.map((pool) => {
        const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
        const color = barColor(pool.driver);
        const plan = pool.accounts.find((account) => account.plan)?.plan;
        return (
          <section key={pool.driver} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={label}
                indicatorBackground="var(--muted)"
                className="size-4"
                iconClassName="size-3.5 text-foreground/80"
              />
              <span className="shrink-0">{label}</span>
              {plan ? (
                <span className="ms-auto min-w-0 truncate rounded-md border border-input/60 px-1.5 text-2xs font-normal text-muted-foreground">
                  {plan.replace(/^Claude\s+/i, "").replace(/\s+Subscription$/i, "")}
                </span>
              ) : null}
            </div>
            {pool.windows.map((window) => {
              const first = window.members[0]?.window;
              const resets = first ? formatResetsIn(first, now, m) : null;
              const used = Math.round(window.usedPercent);
              return (
                <div key={`${window.kind}:${window.id}`} className="flex flex-col gap-1">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="text-foreground">{window.label}</span>
                    <span className="font-medium text-foreground tabular-nums">{used}%</span>
                    <span className="ms-auto truncate text-muted-foreground tabular-nums">
                      {resets ?? ""}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-input/50">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, Math.max(0, used))}%`,
                        backgroundColor: color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
