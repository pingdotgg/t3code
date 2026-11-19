import { T } from "gt-react";
import type { ServerProvider } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { LimitWindows } from "../usage/UsageLimits";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ComposerControl } from "./ComposerControl";

/**
 * The selected account's usage, next to the model picker: a small bar for its tightest limit
 * that opens every window it reports. Shows nothing when the provider reports no usage.
 */
export function ComposerUsageBar({ provider }: { readonly provider: ServerProvider | null }) {
  const nowMinute = useNowMinute();
  const windows = provider?.usageLimits?.windows ?? [];
  if (provider === null || windows.length === 0) return null;
  const tightest = windows.reduce((most, window) =>
    window.usedPercent > most.usedPercent ? window : most,
  );
  const used = Math.round(tightest.usedPercent);
  const left = 100 - used;
  const label = `${provider.displayName ?? provider.driver} usage: ${left}% left of ${tightest.label}`;

  return (
    <Popover>
      <PopoverTrigger
        render={<ComposerControl size="xs" />}
        aria-label={label}
        data-composer-usage-bar
        className="shrink-0 gap-1.5"
      >
        <span
          aria-hidden
          className="relative h-1.5 w-10 overflow-hidden rounded-full bg-muted-foreground/20"
        >
          <span
            className={cn(
              "absolute inset-y-0 start-0 rounded-full",
              used >= 90 ? "bg-destructive" : used >= 70 ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${Math.max(2, used)}%` }}
          />
        </span>
        <span className="tabular-nums" data-composer-control-label>
          {left}%
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-[min(26rem,calc(100vw-2rem))]">
        <PopoverTitle>{provider.displayName ?? provider.driver} usage</PopoverTitle>
        <div className="mt-2" data-composer-usage-details>
          <LimitWindows
            driver={provider.driver}
            accentColor={provider.accentColor}
            windows={windows}
            now={Date.parse(`${nowMinute}:00Z`)}
            compact
          />
        </div>
        <Link
          to="/usage"
          className="mt-2 block text-muted-foreground text-xs hover:text-foreground"
        >
          <T>Open the usage page</T>
        </Link>
      </PopoverPopup>
    </Popover>
  );
}
