import { ChevronUpIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { RateLimitWindow } from "../wsNativeApi";
import { useRateLimits } from "../rateLimitsStore";
import { OpenAI } from "./Icons";

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

function classifyWindow(w: RateLimitWindow): "weekly" | "session" {
  const mins = w.windowDurationMins;
  if (mins != null && mins >= 1440) return "weekly";
  if (mins != null && mins < 1440) return "session";
  // Fallback heuristic: if resetsAt is >2 days out, treat as weekly
  if (w.resetsAt) {
    const hoursLeft = (w.resetsAt - Date.now() / 1000) / 3600;
    if (hoursLeft > 48) return "weekly";
  }
  return "session";
}

function windowLabel(kind: "weekly" | "session"): string {
  return kind === "weekly" ? "Weekly Usage" : "Session Usage";
}

function LimitBar({ label, window }: { label: string; window: RateLimitWindow }) {
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent ?? 0));
  const remainingPercent = 100 - usedPercent;
  const resetsIn = formatResetsAt(window.resetsAt);

  return (
    <div className="group/bar flex flex-col gap-1">
      <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/70">
        <OpenAI className="size-3 shrink-0" />
        {label}
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
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/40 opacity-0 transition-opacity group-hover/bar:opacity-100">
            resets in {resetsIn}
          </span>
        )}
      </div>
    </div>
  );
}

interface ClassifiedWindow {
  kind: "weekly" | "session";
  label: string;
  window: RateLimitWindow;
}

function useClassifiedWindows(
  primary: RateLimitWindow | null | undefined,
  secondary: RateLimitWindow | null | undefined,
): { session: ClassifiedWindow | null; weekly: ClassifiedWindow | null } {
  return useMemo(() => {
    const windows: ClassifiedWindow[] = [];
    if (primary && primary.usedPercent !== undefined) {
      const kind = classifyWindow(primary);
      windows.push({ kind, label: windowLabel(kind), window: primary });
    }
    if (secondary && secondary.usedPercent !== undefined) {
      const kind = classifyWindow(secondary);
      windows.push({ kind, label: windowLabel(kind), window: secondary });
    }
    return {
      session: windows.find((w) => w.kind === "session") ?? null,
      weekly: windows.find((w) => w.kind === "weekly") ?? null,
    };
  }, [primary, secondary]);
}

export const WeeklyLimitPill = memo(function WeeklyLimitPill() {
  const rateLimits = useRateLimits();
  const [expanded, setExpanded] = useState(false);

  const primary = rateLimits?.rateLimits?.primary;
  const secondary = rateLimits?.rateLimits?.secondary;
  const { session, weekly } = useClassifiedWindows(primary, secondary);

  if (!session && !weekly) return null;

  // When both exist: session is the main view, weekly expands above
  // When only one exists: show it directly
  const mainWindow = session ?? weekly;
  const expandableWindow = session && weekly ? weekly : null;

  if (!mainWindow) return null;

  return (
    <div className="flex flex-col rounded-lg border border-border/50 px-2.5 py-1.5">
      {expandableWindow && (
        <div
          className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out"
          style={{
            gridTemplateRows: expanded ? "1fr" : "0fr",
            opacity: expanded ? 1 : 0,
          }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pb-2 mb-2 border-b border-border/30">
              <LimitBar label={expandableWindow.label} window={expandableWindow.window} />
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <LimitBar label={mainWindow.label} window={mainWindow.window} />
        </div>
        {expandableWindow && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground/70"
            title={
              expanded
                ? `Hide ${expandableWindow.label.toLowerCase()}`
                : `Show ${expandableWindow.label.toLowerCase()}`
            }
          >
            <ChevronUpIcon
              className={`size-3 transition-transform duration-300 ease-in-out ${expanded ? "" : "rotate-180"}`}
            />
          </button>
        )}
      </div>
    </div>
  );
});
