import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  ProviderUsageDetails,
  ProviderUsageIdentity,
  deriveProviderUsageHeadline,
  providerUsagePresentationFromSnapshot,
} from "../provider-usage/ProviderUsagePresentation";

export function ProviderUsageControl({
  environmentId,
  instanceId,
  compact,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  compact: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.providerUsage({ environmentId, input: { instanceId } }),
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const snapshot = query.data?.usage.find((candidate) => candidate.instanceId === instanceId);
  const usage = useMemo(
    () => (snapshot ? providerUsagePresentationFromSnapshot(snapshot) : null),
    [snapshot],
  );
  const headline = usage ? deriveProviderUsageHeadline(usage) : null;

  // Unsupported providers remain visible in the full settings dashboard, but
  // do not take permanent space in every chat. Initial loading is also hidden
  // rather than presenting a control with no useful content.
  if (!usage || usage.status === "unsupported") return null;
  if (usage.status === "ok" && headline === null) return null;

  const hasFailure = usage.status === "error" || usage.status === "unauthenticated";
  const usedPercent = headline?.usedPercent ?? null;
  const toneClass = hasFailure
    ? usage.status === "error"
      ? "text-destructive"
      : "text-amber-600 dark:text-amber-300"
    : usedPercent !== null && usedPercent >= 95
      ? "text-red-600 dark:text-red-400"
      : usedPercent !== null && usedPercent >= 75
        ? "text-amber-600 dark:text-amber-300"
        : "text-muted-foreground/75";
  const ariaLabel = hasFailure
    ? `${usage.displayName} subscription usage unavailable`
    : `${usage.displayName} subscription usage: ${headline?.label ?? "available"}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-6 cursor-pointer items-center justify-center gap-1 rounded-md border border-transparent px-1 text-xs font-medium outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              toneClass,
            )}
            aria-label={ariaLabel}
          >
            {hasFailure ? (
              <CircleAlertIcon className="size-3.5" />
            ) : (
              <GaugeIcon className="size-3.5" />
            )}
            {!compact && headline ? (
              <span className="hidden sm:inline">{headline.label}</span>
            ) : null}
          </button>
        }
      />
      <PopoverPopup side="top" align="end" className="w-80 max-w-[calc(100vw-1rem)] p-0">
        <div className="grid gap-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <ProviderUsageIdentity usage={usage} compact />
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              className="-mr-1 -mt-1"
              onClick={query.refresh}
              aria-label="Refresh provider usage"
            >
              <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
            </Button>
          </div>
          <ProviderUsageDetails usage={usage} nowMs={nowMs} compact />
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[11px] text-muted-foreground/65">
            <span>Subscription limits</span>
            <Button
              render={<Link to="/settings/usage" />}
              size="xs"
              variant="ghost"
              className="-my-1 -mr-2"
            >
              View all usage
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
