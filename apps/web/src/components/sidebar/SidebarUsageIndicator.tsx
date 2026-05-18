import { ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ensureLocalApi } from "../../localApi";
import type { AppState } from "../../store";
import { useStore } from "../../store";
import { useServerProviders } from "../../rpc/serverState";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { useSidebar } from "../ui/sidebar";
import {
  deriveSidebarUsageProviderRows,
  getSidebarUsageDisplayPercent,
  getSidebarUsagePrimaryWindow,
  getSidebarUsageSummary,
  type SidebarUsageSummary,
  type SidebarUsageProviderRow,
  type SidebarUsageThreadInput,
  type SidebarUsageWindow,
} from "./SidebarUsageIndicator.logic";

const SIDEBAR_USAGE_EXPANDED_STORAGE_KEY = "t3code:sidebar-usage-expanded:v1";

function collectSidebarUsageThreads(
  environmentStateById: AppState["environmentStateById"],
): SidebarUsageThreadInput[] {
  const threads: SidebarUsageThreadInput[] = [];

  for (const environmentState of Object.values(environmentStateById)) {
    for (const threadId of environmentState.threadIds) {
      const shell = environmentState.threadShellById[threadId];
      const activityIds = environmentState.activityIdsByThreadId[threadId];
      const activityById = environmentState.activityByThreadId[threadId];
      if (!shell || !activityIds || activityIds.length === 0 || !activityById) {
        continue;
      }

      const activities = activityIds.flatMap((activityId) => {
        const activity = activityById[activityId];
        return activity ? [activity] : [];
      });
      if (activities.length === 0) {
        continue;
      }

      const session = environmentState.threadSessionById[threadId] ?? null;
      threads.push({
        id: threadId,
        title: shell.title,
        modelSelectionInstanceId: shell.modelSelection.instanceId,
        sessionProvider: session?.provider,
        sessionProviderInstanceId: session?.providerInstanceId,
        activities,
      });
    }
  }

  return threads;
}

function formatUsagePrimary(window: SidebarUsageWindow | null): string {
  if (!window) {
    return "--";
  }
  const displayPercent = getSidebarUsageDisplayPercent(window);
  if (typeof displayPercent === "number") {
    return `${Math.round(displayPercent)}%`;
  }
  if (window.status === "rejected") {
    return "Limited";
  }
  if (window.status === "allowed_warning") {
    return "Warn";
  }
  if (window.status === "allowed") {
    return "OK";
  }
  return "Updated";
}

function formatResetDistance(resetsAtMs: number | null): string | null {
  if (resetsAtMs === null) {
    return null;
  }
  const remainingMs = resetsAtMs - Date.now();
  if (remainingMs <= 0) {
    return "resetting";
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m left`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `${hours}h left`;
  }
  return `${Math.ceil(hours / 24)}d left`;
}

function formatUsageDetail(window: SidebarUsageWindow | null): string {
  if (!window) {
    return "No data";
  }
  const reset = formatResetDistance(window.resetsAtMs);
  if (reset) {
    return reset;
  }
  if (window.status) {
    return window.status.replaceAll("_", " ");
  }
  return "Updated";
}

function formatSummary(summary: SidebarUsageSummary | null): string {
  if (summary) {
    return `${summary.row.label} ${summary.window.label} ${formatUsagePrimary(summary.window)}`;
  }
  return "No limit data";
}

function formatProviderTitle(
  row: SidebarUsageProviderRow,
  primaryWindow: SidebarUsageWindow | null,
): string {
  const detail = primaryWindow
    ? `${primaryWindow.label} ${formatUsagePrimary(primaryWindow)}, ${formatUsageDetail(
        primaryWindow,
      )}`
    : "No limit data yet";
  return row.threadTitle
    ? `${row.label}: ${detail} in ${row.threadTitle}`
    : `${row.label}: ${detail}`;
}

function usageBarColor(row: SidebarUsageProviderRow, window: SidebarUsageWindow | null): string {
  const displayPercent = getSidebarUsageDisplayPercent(window);
  if (window?.status === "rejected" || (displayPercent != null && displayPercent <= 5)) {
    return "bg-destructive";
  }
  if (window?.status === "allowed_warning" || (displayPercent != null && displayPercent <= 20)) {
    return "bg-amber-500";
  }
  return row.driverId === "claudeAgent" ? "bg-[#d97757]" : "bg-muted-foreground";
}

function SidebarUsageWindowMeter({
  row,
  window,
  fallbackLabel,
}: {
  row: SidebarUsageProviderRow;
  window: SidebarUsageWindow | null;
  fallbackLabel: string;
}) {
  const normalizedPercentage = Math.max(
    0,
    Math.min(100, getSidebarUsageDisplayPercent(window) ?? 0),
  );

  return (
    <div className="min-w-0 rounded-md bg-muted/35 px-2 py-1.5">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-1">
        <span className="truncate text-[10px] font-medium text-muted-foreground/80">
          {window?.label ?? fallbackLabel}
        </span>
        <span className="shrink-0 text-[10px] font-medium tabular-nums text-foreground">
          {formatUsagePrimary(window)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-background/80">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            usageBarColor(row, window),
          )}
          style={{ width: `${normalizedPercentage}%` }}
        />
      </div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground/70">
        {formatUsageDetail(window)}
      </div>
    </div>
  );
}

function SidebarUsageDetailsGrid({ row }: { row: SidebarUsageProviderRow }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <SidebarUsageWindowMeter row={row} window={row.windows.fiveHour} fallbackLabel="5h" />
      <SidebarUsageWindowMeter row={row} window={row.windows.weekly} fallbackLabel="Week" />
    </div>
  );
}

function SidebarUsageProviderRowView({ row }: { row: SidebarUsageProviderRow }) {
  const primaryWindow = getSidebarUsagePrimaryWindow(row);
  const title = formatProviderTitle(row, primaryWindow);

  return (
    <div className="grid gap-1 rounded-md px-2 py-1.5" title={title}>
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={row.driverKind}
          displayName={row.label}
          className="size-4"
          iconClassName="size-3.5"
        />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{row.label}</span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
          {formatUsagePrimary(primaryWindow)}
        </span>
      </div>
      <SidebarUsageDetailsGrid row={row} />
    </div>
  );
}

export function SidebarUsageIndicator() {
  const [expanded, setExpanded] = useLocalStorage(
    SIDEBAR_USAGE_EXPANDED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const environmentStateById = useStore((state) => state.environmentStateById);
  const providers = useServerProviders();
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarVisible = isMobile ? openMobile : open;
  const previousSidebarVisibleRef = useRef(false);

  const threads = useMemo(
    () => collectSidebarUsageThreads(environmentStateById),
    [environmentStateById],
  );
  const rows = useMemo(
    () =>
      deriveSidebarUsageProviderRows({
        providerInstances: providers.map((provider) => ({
          instanceId: provider.instanceId,
          driverKind: provider.driver,
        })),
        threads,
      }),
    [providers, threads],
  );
  const summary = useMemo(() => getSidebarUsageSummary(rows), [rows]);

  useEffect(() => {
    const previousSidebarVisible = previousSidebarVisibleRef.current;
    previousSidebarVisibleRef.current = sidebarVisible;
    if (!sidebarVisible || (previousSidebarVisible && !expanded)) {
      return;
    }

    void ensureLocalApi()
      .server.refreshUsageLimits()
      .catch(() => undefined);
  }, [expanded, sidebarVisible]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger
        aria-label={expanded ? "Collapse usage" : "Expand usage"}
        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground/70 outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2"
      >
        <GaugeIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs">Usage</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatSummary(summary)}
        </span>
        <ChevronDownIcon
          className={cn("size-3 shrink-0 transition-transform", expanded ? "rotate-180" : "")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-1 pt-1">
          {rows.map((row) => (
            <SidebarUsageProviderRowView key={row.driverId} row={row} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
