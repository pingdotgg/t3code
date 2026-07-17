import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, CircleAlertIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  ProviderUsageDetails,
  type ProviderUsageHeadline,
  ProviderUsageIdentity,
  type ProviderUsagePresentation,
  deriveProviderUsageHeadline,
  providerUsagePresentationFromSnapshot,
} from "../provider-usage/ProviderUsagePresentation";

const PROVIDER_USAGE_ALERT_THRESHOLD = 75;

export function shouldShowProviderUsageAlert(
  usage: ProviderUsagePresentation,
  headline: ProviderUsageHeadline | null,
): boolean {
  if (usage.status === "error" || usage.status === "unauthenticated") return true;
  const usedPercent = headline?.usedPercent;
  return (
    usage.status === "ok" &&
    typeof usedPercent === "number" &&
    usedPercent >= PROVIDER_USAGE_ALERT_THRESHOLD
  );
}

function useProviderUsage({
  environmentId,
  instanceId,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
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

  return { usage, headline, isPending: query.isPending, refresh: query.refresh, nowMs };
}

function usageToneClass(
  usage: ProviderUsagePresentation,
  headline: ProviderUsageHeadline | null,
): string {
  if (usage.status === "error") return "text-destructive";
  if (usage.status === "unauthenticated") return "text-amber-600 dark:text-amber-300";
  const usedPercent = headline?.usedPercent ?? null;
  if (usedPercent !== null && usedPercent >= 95) return "text-red-600 dark:text-red-400";
  if (usedPercent !== null && usedPercent >= 75) return "text-amber-600 dark:text-amber-300";
  return "text-muted-foreground/75";
}

function ProviderUsageExpandedContent({
  usage,
  nowMs,
  isPending,
  onRefresh,
}: {
  usage: ProviderUsagePresentation;
  nowMs: number;
  isPending: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <ProviderUsageIdentity usage={usage} compact />
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="-mr-1 -mt-1"
          onClick={onRefresh}
          aria-label="Refresh provider usage"
        >
          <RefreshCwIcon className={isPending ? "animate-spin" : undefined} />
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
  );
}

export function ProviderUsageAlert({
  environmentId,
  instanceId,
  compact,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  compact: boolean;
}) {
  const { usage, headline, isPending, refresh, nowMs } = useProviderUsage({
    environmentId,
    instanceId,
  });

  if (!usage || !shouldShowProviderUsageAlert(usage, headline)) return null;

  const hasFailure = usage.status === "error" || usage.status === "unauthenticated";
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
              usageToneClass(usage, headline),
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
        <ProviderUsageExpandedContent
          usage={usage}
          nowMs={nowMs}
          isPending={isPending}
          onRefresh={refresh}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function ProviderUsageSelectorPanel({
  environmentId,
  instanceId,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
}) {
  const [open, setOpen] = useState(false);
  const { usage, headline, isPending, refresh, nowMs } = useProviderUsage({
    environmentId,
    instanceId,
  });

  if (!usage || usage.status === "unsupported") return null;
  if (usage.status === "ok" && headline === null) return null;

  const hasFailure = usage.status === "error" || usage.status === "unauthenticated";
  const summary = hasFailure ? "Unavailable" : (headline?.label ?? "Available");

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="shrink-0 border-t border-border/70 bg-popover/80"
    >
      <CollapsibleTrigger className="flex h-10 w-full cursor-pointer items-center gap-2 px-3 text-xs hover:bg-muted/60">
        {hasFailure ? (
          <CircleAlertIcon className={cn("size-3.5", usageToneClass(usage, headline))} />
        ) : (
          <GaugeIcon className={cn("size-3.5", usageToneClass(usage, headline))} />
        )}
        <span className="min-w-0 flex-1 truncate text-left font-medium">
          {usage.displayName} usage
        </span>
        <span className={cn("shrink-0 tabular-nums", usageToneClass(usage, headline))}>
          {summary}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/60 p-3">
          <ProviderUsageExpandedContent
            usage={usage}
            nowMs={nowMs}
            isPending={isPending}
            onRefresh={refresh}
          />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
