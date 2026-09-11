import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Live countdown text that re-renders only this span each second (the same
 * self-ticking pattern as the sidebar Working duration), so a static reset
 * time can read as "resets in 14m" without repainting the banner's parents.
 */
export function UsageLimitCountdown({
  resetsAt,
  prefix = "resets in",
  className,
}: {
  resetsAt: string;
  prefix?: string | null;
  className?: string;
}) {
  const targetMs = Date.parse(resetsAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(targetMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [targetMs]);
  if (Number.isNaN(targetMs)) return null;

  const remaining = targetMs - Date.now();
  let label: ReactNode;
  if (remaining <= 0) {
    label = prefix === null ? "now" : "ready soon";
  } else {
    const totalMinutes = Math.ceil(remaining / 60_000);
    label =
      totalMinutes < 60
        ? `${totalMinutes}m`
        : `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  }
  return (
    <span className={cn("tabular-nums", className)}>
      {prefix === null ? label : `${prefix} ${label}`}
    </span>
  );
}
