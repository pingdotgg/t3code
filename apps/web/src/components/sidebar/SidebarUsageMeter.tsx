import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider, ServerProviderRateLimitWindow } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useCallback } from "react";

import { primaryServerProvidersAtom } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The footer stays a predictable height: only the windows that answer "what
// stops me now" and "what stops me this week" get a row. Everything else the
// provider reports still shows up in the tooltip.
const ROW_LABELS: ReadonlyArray<string> = ["5h", "Weekly"];

interface UsageRow {
  readonly key: string;
  readonly provider: string;
  readonly window: string | undefined;
  readonly usedPercent: number | undefined;
  readonly resetsAt: string | undefined;
  readonly planType: string | undefined;
  readonly updatedAt: string | undefined;
  /** Every window the provider reported, for the tooltip. */
  readonly allWindows: ReadonlyArray<ServerProviderRateLimitWindow>;
}

function toUsageRows(providers: ReadonlyArray<ServerProvider>): ReadonlyArray<UsageRow> {
  return providers.flatMap((provider): ReadonlyArray<UsageRow> => {
    const name = provider.displayName ?? provider.driver;
    const rateLimits = provider.rateLimits;
    const windows = rateLimits?.windows ?? [];
    const common = {
      provider: name,
      planType: rateLimits?.planType,
      updatedAt: rateLimits?.updatedAt,
      allWindows: windows,
    };

    // `rateLimits` present but empty is the server saying plan limits do not
    // apply to this account (API key, Bedrock, Vertex) — not "still waiting".
    if (rateLimits && windows.length === 0) {
      return [];
    }

    if (!rateLimits) {
      return provider.auth.status === "authenticated"
        ? ROW_LABELS.map((label) => ({
            ...common,
            key: `${provider.instanceId}:${label}`,
            window: label,
            usedPercent: undefined,
            resetsAt: undefined,
          }))
        : [];
    }

    return windows
      .filter((window) => window.label !== undefined && ROW_LABELS.includes(window.label))
      .map((window, index) => ({
        ...common,
        key: `${provider.instanceId}:${window.label ?? index}`,
        window: window.label,
        usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
        resetsAt: window.resetsAt,
      }))
      .concat(
        // Overage is off-plan spend: it only earns a row once it is live.
        windows
          .filter((window) => window.label === "Overage" && window.usedPercent > 0)
          .map((window) => ({
            ...common,
            key: `${provider.instanceId}:Overage`,
            window: window.label,
            usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
            resetsAt: window.resetsAt,
          })),
      );
  });
}

function formatResetsAt(resetsAt: string | undefined): string | undefined {
  if (!resetsAt) {
    return undefined;
  }
  const parsed = new Date(resetsAt);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// "resets in 2h" answers the question the meter raises better than a wall
// clock time does; the absolute time stays in the accessible label.
function formatResetsIn(resetsAt: string | undefined): string | undefined {
  if (!resetsAt) {
    return undefined;
  }
  const parsed = new Date(resetsAt);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  const minutes = Math.round((parsed.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) {
    return "resets now";
  }
  if (minutes < 60) {
    return `resets in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `resets in ${hours}h` : `resets in ${Math.round(hours / 24)}d`;
}

// Claude only refreshes when a turn ends, so a stale row would otherwise look
// identical to a live one.
function formatUpdatedAgo(updatedAt: string | undefined): string | undefined {
  if (!updatedAt) {
    return undefined;
  }
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  const minutes = Math.floor((Date.now() - parsed.getTime()) / 60_000);
  if (minutes < 1) {
    return "Updated just now";
  }
  if (minutes < 60) {
    return `Updated ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Updated ${hours}h ago` : `Updated ${Math.floor(hours / 24)}d ago`;
}

// Quota meters earn attention as they fill: quiet until it matters.
function barToneClass(usedPercent: number): string {
  if (usedPercent >= 90) {
    return "bg-destructive/70";
  }
  if (usedPercent >= 75) {
    return "bg-warning/70";
  }
  return "bg-primary/60";
}

// One window inside the tooltip: label and reset on top, bar and percent
// below, so every window lines up on the same two axes.
function TooltipWindowRow({
  window,
  isCurrent,
}: {
  window: ServerProviderRateLimitWindow;
  isCurrent: boolean;
}) {
  const percent = Math.round(Math.min(100, Math.max(0, window.usedPercent)));
  const resetsIn = formatResetsIn(window.resetsAt);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={isCurrent ? "font-medium text-popover-foreground" : "text-muted-foreground"}
        >
          {window.label}
        </span>
        {resetsIn ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{resetsIn}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${barToneClass(percent)} ${
              isCurrent ? "" : "opacity-55"
            }`}
            style={{ width: `${percent}%` }}
          />
        </span>
        <span
          className={`w-8 shrink-0 text-right tabular-nums ${
            isCurrent ? "text-popover-foreground" : "text-muted-foreground"
          }`}
        >
          {percent}%
        </span>
      </div>
    </div>
  );
}

export function SidebarUsageMeter() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const openProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  const rows = toUsageRows(providers.filter((p) => ["claudeAgent", "codex"].includes(p.driver)));
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-0.5 px-1 py-0.5">
      {rows.map((row) => {
        const label = row.window ? `${row.provider} ${row.window}` : row.provider;
        const isPending = row.usedPercent === undefined;
        const rounded = isPending ? undefined : Math.round(row.usedPercent ?? 0);
        const detailWindows = row.allWindows.filter((window) => window.label !== undefined);
        const updatedAgo = formatUpdatedAgo(row.updatedAt);
        // Screen readers get the whole card as one sentence.
        const ariaLabel = [
          isPending ? `${label} — waiting for first report` : `${label} — ${rounded}% used`,
          row.planType ? `Plan: ${row.planType}` : undefined,
          formatResetsAt(row.resetsAt) ? `Resets ${formatResetsAt(row.resetsAt)}` : undefined,
          updatedAgo,
          ...detailWindows
            .filter((window) => window.label !== row.window)
            .map((window) => `${window.label}: ${Math.round(window.usedPercent)}%`),
          "Open provider settings",
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <Tooltip key={row.key}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={ariaLabel}
                  className={`flex h-6 w-full items-center gap-2 rounded-md px-1.5 text-xs hover:bg-sidebar-row-hover hover:text-sidebar-foreground ${
                    isPending
                      ? "text-sidebar-muted-foreground/45"
                      : "text-sidebar-muted-foreground/80"
                  }`}
                  onClick={openProviderSettings}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                  <span
                    aria-hidden="true"
                    className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-sidebar-row-hover"
                  >
                    {isPending ? null : (
                      <span
                        className={`absolute inset-y-0 left-0 rounded-full ${barToneClass(row.usedPercent ?? 0)}`}
                        style={{ width: `${row.usedPercent ?? 0}%` }}
                      />
                    )}
                  </span>
                  <span className="w-8 shrink-0 text-right tabular-nums">
                    {isPending ? "—" : `${rounded}%`}
                  </span>
                </button>
              }
            />
            <TooltipPopup side="right" align="end" className="w-60">
              <div className="flex flex-col gap-2.5 py-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-popover-foreground">{row.provider}</span>
                  {row.planType ? (
                    <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[10px] text-muted-foreground uppercase tracking-wide">
                      {row.planType}
                    </span>
                  ) : null}
                </div>

                {detailWindows.length === 0 ? (
                  <p className="text-muted-foreground leading-snug">
                    {row.provider} hasn&apos;t reported usage yet. Limits arrive when a turn ends.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {detailWindows.map((window) => (
                      <TooltipWindowRow
                        key={window.label}
                        window={window}
                        isCurrent={window.label === row.window}
                      />
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
                  <span>{updatedAgo ?? "Not updated yet"}</span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    Open settings
                    <ArrowUpRightIcon className="size-2.5" />
                  </span>
                </div>
              </div>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
