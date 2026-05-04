import type { CodexUsageSnapshot, CodexUsageWindow, ProviderInstanceId } from "@t3tools/contracts";
import type { CodexUsageIndicatorMode } from "@t3tools/contracts/settings";
import { useQuery } from "@tanstack/react-query";
import { GaugeIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { codexUsageQueryOptions } from "../../lib/providerReactQuery";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const sameDayResetFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const laterResetFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function labelForWindow(kind: CodexUsageWindow["kind"]): string {
  return kind === "five-hour" ? "5h" : "Weekly";
}

function selectedWindows(
  snapshot: CodexUsageSnapshot | null | undefined,
  mode: CodexUsageIndicatorMode,
): CodexUsageWindow[] {
  if (!snapshot || mode === "off") {
    return [];
  }
  if (mode === "both") {
    return snapshot.windows.filter(
      (window) => window.kind === "five-hour" || window.kind === "weekly",
    );
  }
  return snapshot.windows.filter((window) => window.kind === "five-hour");
}

function unavailableLabel(mode: CodexUsageIndicatorMode): string {
  if (mode === "both") {
    return "Usage 5h -- | Weekly --";
  }
  return "Usage 5h --";
}

function labelForDisplayWindow(window: CodexUsageWindow): string {
  return `${labelForWindow(window.kind)} ${window.remainingPercent}% left`;
}

function formatUsageTimestamp(isoDate: string, capturedAt: Date = new Date()): string | null {
  const date = new Date(isoDate);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const isSameDay =
    date.getFullYear() === capturedAt.getFullYear() &&
    date.getMonth() === capturedAt.getMonth() &&
    date.getDate() === capturedAt.getDate();
  return isSameDay ? sameDayResetFormatter.format(date) : laterResetFormatter.format(date);
}

function tooltipForSnapshot(snapshot: CodexUsageSnapshot, windows: readonly CodexUsageWindow[]) {
  const lines = windows.map((window) => {
    const resetAt = window.resetsAt ? formatUsageTimestamp(window.resetsAt) : null;
    const resetLabel = resetAt ? `resets ${resetAt}` : "";
    return `${labelForWindow(window.kind)}: ${window.remainingPercent}% left${resetLabel ? `, ${resetLabel}` : ""}`;
  });
  const checkedAt = formatUsageTimestamp(snapshot.checkedAt);
  if (checkedAt) {
    lines.push(`Checked ${checkedAt}`);
  }
  if (snapshot.rateLimitReachedType) {
    lines.push(`Limit state: ${snapshot.rateLimitReachedType}`);
  }
  return lines.join("\n");
}

export const CodexUsageIndicator = memo(function CodexUsageIndicator({
  instanceId,
  mode,
}: {
  readonly instanceId: ProviderInstanceId;
  readonly mode: CodexUsageIndicatorMode;
}) {
  const usageQuery = useQuery(
    codexUsageQueryOptions({
      instanceId,
      enabled: mode !== "off",
    }),
  );
  const windows = useMemo(() => selectedWindows(usageQuery.data, mode), [mode, usageQuery.data]);

  if (mode === "off") {
    return null;
  }

  const isUnavailable = !usageQuery.data || windows.length === 0;
  const hasReachedLimit = Boolean(usageQuery.data?.rateLimitReachedType);
  const snapshot = usageQuery.data;
  const label = isUnavailable
    ? unavailableLabel(mode)
    : `Usage ${windows.map((window) => labelForDisplayWindow(window)).join(" | ")}`;
  const tooltip =
    isUnavailable || !snapshot
      ? "Codex usage is unavailable for this account or session. The selected Codex account did not return displayable 5h or weekly limits."
      : tooltipForSnapshot(snapshot, windows);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 text-sm font-medium tabular-nums sm:text-xs",
              "text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80",
              hasReachedLimit && "text-amber-600 hover:text-amber-600",
            )}
          >
            <GaugeIcon className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">{label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="whitespace-pre-line">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
});
