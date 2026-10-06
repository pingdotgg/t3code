import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  displayLimitWindows,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PaceIcon, barColor } from "../usage/UsageLimits";

/** The window that decides whether work can continue: the one with the least left. */
function leadWindow(pool: LimitPool): LimitPoolWindow | null {
  let lead: LimitPoolWindow | null = null;
  for (const window of displayLimitWindows(pool)) {
    if (lead === null || window.remainingPercent < lead.remainingPercent) lead = window;
  }
  return lead;
}

function SidebarUsageLimitRow({
  pool,
  now,
  onOpen,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const window = leadWindow(pool);
  if (window === null) return null;
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  const remaining = window.remainingPercent;
  const resetAt = window.resets[0]?.at;
  const resetShort =
    resetAt === undefined ? null : resetAt <= now ? "now" : formatDuration(resetAt - now);
  const resetAria =
    resetAt === undefined
      ? ""
      : resetAt <= now
        ? ", resets now"
        : `, resets in ${formatDuration(resetAt - now)}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label}: ${window.label} ${remaining}% left${resetAria}`}
      className="relative flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md bg-sidebar-control-surface px-2 text-2xs text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2"
    >
      {/* Quota left, in the provider's Usage-page colour. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 rounded-md opacity-35"
        style={{ width: `${remaining}%`, backgroundColor: barColor(pool.driver) }}
      />
      <ProviderInstanceIcon
        driverKind={pool.driver}
        displayName={label}
        indicatorBackground="var(--sidebar)"
        className="relative size-4 shrink-0"
        iconClassName="size-3.5 text-foreground/80"
      />
      <span className="relative min-w-0 flex-1 truncate text-left font-medium">{label}</span>
      {window.pace ? (
        <span className="relative shrink-0">
          <PaceIcon pace={window.pace} />
        </span>
      ) : null}
      <span className="relative shrink-0 font-semibold tabular-nums">{remaining}%</span>
      {resetShort ? (
        <span className="relative shrink-0 text-sidebar-muted-foreground tabular-nums">
          ↻ {resetShort}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Subscription quota for every provider that reports it, one compact bar per
 * driver, pinned to the sidebar footer. Reads the same global presentations the
 * Usage page does, so it adds no requests, and only the minute clock advances
 * it. Renders nothing when there is no quota to show.
 */
export function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const nowMinute = useNowMinute();
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();

  // The minute string is UTC-quantized; pin it back to a UTC instant.
  const now = Date.parse(`${nowMinute}:00.000Z`);
  const { pools, notices } = useMemo(() => {
    const accounts = collectLimitAccounts(presentations);
    return {
      pools: collectLimitPools(accounts, now),
      notices: collectLimitNotices(presentations),
    };
  }, [presentations, now]);

  const openUsage = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  // Collapsed offcanvas and the closed mobile sheet both hide the footer.
  const visible = isMobile ? openMobile : open;
  if (!visible || pools.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {notices.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <p
                role="status"
                className="flex min-w-0 items-center gap-1.5 px-2 text-2xs text-warning"
              />
            }
          >
            <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Some limits could not be read</span>
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-64">
            <div className="flex flex-col gap-0.5">
              {notices.map((notice) => (
                <span key={notice}>{notice}</span>
              ))}
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {pools.map((pool) => (
        <SidebarUsageLimitRow key={pool.driver} pool={pool} now={now} onOpen={openUsage} />
      ))}
    </div>
  );
}
