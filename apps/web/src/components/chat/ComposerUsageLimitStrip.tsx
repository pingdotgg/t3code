import type { OrchestrationSessionUsageLimit } from "@t3tools/contracts";
import { HourglassIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { usageLimitWindowLabel } from "@t3tools/shared/usageLimit";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Compact "1h 24m" / "24m" countdown. Under a minute collapses to "<1m" so the
 * strip never reads as though the window has already reopened.
 */
export function formatUsageLimitCountdown(remainingMs: number): string {
  if (remainingMs < MINUTE_MS) {
    return "<1m";
  }
  const hours = Math.floor(remainingMs / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * One-line strip copy, e.g. `5-hour limit reached · resets in 1h 24m`.
 *
 * Falls back to the generic headline for unknown window types and to
 * "resets soon" when the provider gave no reset timestamp.
 */
export function formatUsageLimitStripLabel(input: {
  readonly windowType?: string | undefined;
  readonly remainingMs?: number | undefined;
}): string {
  const windowLabel = usageLimitWindowLabel(input.windowType);
  const headline = windowLabel ? `${windowLabel} limit reached` : "Usage limit reached";
  return input.remainingMs === undefined
    ? `${headline} · resets soon`
    : `${headline} · resets in ${formatUsageLimitCountdown(input.remainingMs)}`;
}

/**
 * Re-render on the minute (and exactly at `resetsAt`) rather than every second.
 *
 * The next tick is scheduled at whichever comes first: the upcoming minute
 * boundary, or the reset itself — so the strip hides the instant the window
 * reopens without polling the server.
 */
function useUsageLimitNow(resetsAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (resetsAt === undefined) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const current = Date.now();
      setNow(current);
      if (current >= resetsAt) {
        return;
      }
      const untilNextMinute = MINUTE_MS - (current % MINUTE_MS);
      timeout = setTimeout(schedule, Math.min(untilNextMinute, resetsAt - current));
    };
    schedule();
    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [resetsAt]);

  return now;
}

/**
 * Slim usage-limit notice docked to the top edge of the composer.
 *
 * Lives at the composer rather than the timeline's error slot because "am I
 * out of usage?" is a can-I-keep-going question about the next message, not a
 * failure of the last one. Renders purely from `session.usageLimit`.
 */
export const ComposerUsageLimitStrip = memo(function ComposerUsageLimitStrip({
  usageLimit,
}: {
  usageLimit: OrchestrationSessionUsageLimit | null | undefined;
}) {
  const resetsAt =
    usageLimit?.resetsAt !== undefined && Number.isFinite(usageLimit.resetsAt)
      ? usageLimit.resetsAt
      : undefined;
  const now = useUsageLimitNow(resetsAt);

  if (!usageLimit) return null;
  // The window reopened while the strip was mounted; hide without waiting for
  // the server to clear `session.usageLimit`.
  if (resetsAt !== undefined && now >= resetsAt) return null;

  const label = formatUsageLimitStripLabel({
    ...(usageLimit.windowType !== undefined ? { windowType: usageLimit.windowType } : {}),
    ...(resetsAt !== undefined ? { remainingMs: resetsAt - now } : {}),
  });
  const absolute =
    resetsAt === undefined
      ? "The provider did not report a reset time."
      : `Resets at ${new Date(resetsAt).toLocaleString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })}`;

  return (
    <div className="chat-composer-notice-strip -mb-4 mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] items-center gap-1.5 px-3 pt-1.5 pb-5 text-xs">
      <HourglassIcon aria-hidden className="size-3 shrink-0 text-warning" />
      <Tooltip>
        {/* Amber is carried by the icon and surface tint; 12px amber body text
            would not clear contrast on the light surface. */}
        <TooltipTrigger
          render={<div className="min-w-0 truncate font-medium text-foreground/80" />}
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="top">{absolute}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
