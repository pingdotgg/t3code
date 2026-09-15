import { useAtomValue } from "@effect/atom-react";
import { formatDuration } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";
import {
  collectSidebarLimits,
  type SidebarLimitTone,
  type SidebarLimitView,
} from "./SidebarUsageLimits.logic";

const TONE_STYLES: Record<SidebarLimitTone, string> = {
  ok: "text-sidebar-foreground",
  low: "text-warning",
  critical: "text-destructive",
};

/**
 * Remaining subscription quota per provider, one segment each, sitting above
 * the sidebar's utility row. Reads the provider snapshots every client already
 * holds, so it costs no request; a segment opens Usage → Limits for the rest.
 */
export function SidebarUsageLimitsPill() {
  const enabled = useClientSettings((settings) => settings.sidebarUsageLimitsEnabled);
  return enabled ? <SidebarUsageLimitsPillContent /> : null;
}

function SidebarUsageLimitsPillContent() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // Anchored once per mount: the clock only feeds pace, which the pill does
  // not show, so re-pooling on every tick would repaint the sidebar for nothing.
  const [mountedAt] = useState(() => Date.now());
  const limits = useMemo(
    () => collectSidebarLimits(presentations, mountedAt),
    [mountedAt, presentations],
  );
  const openLimits = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  if (limits.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Usage limits"
      className="flex h-7 w-full items-stretch overflow-hidden rounded-lg bg-sidebar-control-surface text-xs font-medium"
    >
      {limits.map((limit) => (
        <SidebarLimitSegment key={limit.driver} limit={limit} onClick={openLimits} />
      ))}
    </div>
  );
}

function SidebarLimitSegment({
  limit,
  onClick,
}: {
  readonly limit: SidebarLimitView;
  readonly onClick: () => void;
}) {
  const option = getDriverOption(limit.driver);
  const Mark = option?.icon ?? GaugeIcon;
  const label = option?.label ?? String(limit.driver);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${limit.remainingPercent}% left. Open usage limits.`}
            className={cn(
              "flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover",
              TONE_STYLES[limit.tone],
            )}
            onClick={onClick}
          />
        }
      >
        <Mark aria-hidden className="size-3.5 shrink-0" />
        <span className="tabular-nums">{limit.remainingPercent}%</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        <SidebarLimitDetails label={label} limit={limit} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** Mounted when the tooltip opens, so every countdown is fresh at that moment. */
function SidebarLimitDetails({
  label,
  limit,
}: {
  readonly label: string;
  readonly limit: SidebarLimitView;
}) {
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground">
        {label}
        {limit.accountCount > 1 ? ` · ${limit.accountCount} accounts` : ""}
      </span>
      {limit.windows.map((window) => (
        <span key={window.id} className="text-muted-foreground tabular-nums">
          {window.label}: {window.remainingPercent}% left
          {window.resetsAt === null
            ? ""
            : window.resetsAt <= now
              ? " · resets now"
              : ` · resets in ${formatDuration(window.resetsAt - now)}`}
        </span>
      ))}
    </div>
  );
}
