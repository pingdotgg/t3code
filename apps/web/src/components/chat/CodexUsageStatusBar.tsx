import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn, remainingPercent } from "@t3tools/shared/usageLimits";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function shortLabel(window: ServerProviderUsageWindow): string {
  if (window.kind === "session" && window.windowDurationMins === 5 * 60) return "5h";
  if (window.kind === "weekly") return "Week";
  if (window.kind === "monthly") return "Month";
  return window.label;
}

export function CodexUsageStatusBar({
  windows,
}: {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const visibleWindows = windows;
  if (visibleWindows.length === 0) return null;

  const details = visibleWindows.map((window) => {
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const resetTime = Number.isFinite(resetsAt)
      ? formatUpcomingTimestamp(window.resetsAt!, timestampFormat, now)
      : null;
    const resetsIn = formatResetsIn(window, now);
    return {
      window,
      label: shortLabel(window),
      remaining: remainingPercent(window),
      resetTime,
      resetsIn,
    };
  });
  const summary = details
    .map(
      ({ label, remaining, resetTime, resetsIn }) =>
        `${label}: ${remaining}% left${resetTime ? `, resets ${resetTime}` : ""}${resetsIn ? `, ${resetsIn}` : ""}`,
    )
    .join(". ");

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            aria-label={`Codex usage limits. ${summary}`}
            className="min-w-0"
          />
        }
      >
        <span className="inline-flex items-center gap-2">
          {details.map(({ window, label, remaining, resetsIn }) => (
            <span key={window.id} className="inline-flex items-center gap-1.5 tabular-nums">
              <span className="text-2xs text-muted-foreground">{label}</span>
              <span className="text-2xs font-medium text-foreground">{remaining}%</span>
              {resetsIn ? <span className="text-2xs text-muted-foreground">{resetsIn}</span> : null}
              <span aria-hidden className="h-1 w-5 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-foreground/45"
                  style={{ width: `${100 - window.usedPercent}%` }}
                />
              </span>
            </span>
          ))}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm" tooltipStyle>
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <span className="text-xs font-medium text-foreground">Codex usage limits</span>
          {details.map(({ window, label, remaining, resetTime, resetsIn }) => (
            <div key={window.id} className="flex flex-col gap-0.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{window.label || label}</span>
                <span className="font-medium tabular-nums text-foreground">{remaining}% left</span>
              </div>
              {resetTime ? (
                <span className="text-2xs text-muted-foreground">
                  Resets {resetTime}
                  {resetsIn ? ` · ${resetsIn}` : ""}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
