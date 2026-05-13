import { ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useMemo } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import type { AppState } from "../../store";
import { useStore } from "../../store";
import { useServerProviders } from "../../rpc/serverState";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
  deriveSidebarUsageProviderRows,
  getSidebarUsageSummaryRow,
  type SidebarUsageProviderRow,
  type SidebarUsageThreadInput,
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

function formatUsagePrimary(usage: SidebarUsageProviderRow["usage"]): string {
  if (!usage) {
    return "No usage";
  }
  if (typeof usage.usedPercentage === "number") {
    return `${Math.round(usage.usedPercentage)}%`;
  }
  return formatContextWindowTokens(usage.usedTokens);
}

function formatUsageDetail(usage: SidebarUsageProviderRow["usage"]): string {
  if (!usage) {
    return "No context usage yet";
  }
  if (typeof usage.maxTokens === "number") {
    return `${formatContextWindowTokens(usage.usedTokens)} / ${formatContextWindowTokens(
      usage.maxTokens,
    )}`;
  }
  return `${formatContextWindowTokens(usage.usedTokens)} tokens`;
}

function formatSummary(row: SidebarUsageProviderRow | null): string {
  if (!row?.usage) {
    return "No usage";
  }
  return `${row.label} ${formatUsagePrimary(row.usage)}`;
}

function SidebarUsageProviderRowView({ row }: { row: SidebarUsageProviderRow }) {
  const normalizedPercentage = Math.max(0, Math.min(100, row.usage?.usedPercentage ?? 0));
  const title = row.threadTitle
    ? `${row.label}: ${formatUsageDetail(row.usage)} in ${row.threadTitle}`
    : `${row.label}: ${formatUsageDetail(row.usage)}`;

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
          {formatUsagePrimary(row.usage)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            row.driverId === "claudeAgent" ? "bg-[#d97757]" : "bg-muted-foreground",
          )}
          style={{ width: `${normalizedPercentage}%` }}
        />
      </div>
      <div className="truncate text-[10px] text-muted-foreground/70">
        {formatUsageDetail(row.usage)}
      </div>
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
  const summaryRow = useMemo(() => getSidebarUsageSummaryRow(rows), [rows]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger
        aria-label={expanded ? "Collapse usage" : "Expand usage"}
        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground/70 outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2"
      >
        <GaugeIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs">Usage</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatSummary(summaryRow)}
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
