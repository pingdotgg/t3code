import { memo } from "react";
import { useRateLimits } from "../rateLimitsStore";

function formatResetsAt(resetsAt: number | undefined): string | null {
  if (!resetsAt) return null;
  const now = Date.now() / 1000;
  const diff = resetsAt - now;
  if (diff <= 0) return null;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.ceil(diff / 60)}m`;
}

export const WeeklyLimitPill = memo(function WeeklyLimitPill() {
  const rateLimits = useRateLimits();

  const primary = rateLimits?.rateLimits?.primary;
  if (!primary || primary.usedPercent === undefined) return null;

  const usedPercent = Math.min(100, Math.max(0, primary.usedPercent));
  const remainingPercent = 100 - usedPercent;
  const resetsIn = formatResetsAt(primary.resetsAt);

  return (
    <div className="group flex flex-col gap-1 rounded-lg border border-border/50 px-2.5 py-1.5">
      <span className="text-[11px] font-medium text-muted-foreground/70">
        Weekly usage
      </span>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/40">
        <div
          className="h-full rounded-full bg-ring/50 transition-all duration-500"
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div className="flex items-center">
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {remainingPercent}% left
        </span>
        {resetsIn && (
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100">
            resets in {resetsIn}
          </span>
        )}
      </div>
    </div>
  );
});
