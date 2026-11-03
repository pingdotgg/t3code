import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  resolveProviderUsageLimits,
  elapsedShare,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { CalendarRangeIcon, GaugeIcon, Minimize2Icon, TimerIcon } from "lucide-react";
import type { ReactNode } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};
export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}
type UsageTone = "error" | "warning" | null;

/** Provider limits share the canvas's icon, label, meter, percentage and reset columns. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const limits =
    providerInstanceId !== null
      ? resolveProviderUsageLimits(providerInstanceId, providers, sources)
      : undefined;
  const notice = limits ? limitsNotice(limits) : "This provider has not reported usage limits.";
  return (
    <ThreadDetailsSection title="Usage limits" variant="usage">
      {notice || !limits?.windows.length ? (
        <UsageRow
          label="Limits"
          icon={<TimerIcon />}
          fill={null}
          tone={null}
          value="Unavailable"
          tooltip={notice ?? "No usage windows reported."}
        />
      ) : (
        limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
      )}
    </ThreadDetailsSection>
  );
}

/** Context fills as tokens are used. Compact follows the composer's real provider command. */
export function ThreadDetailsContext({
  usage,
  onCompact,
  compactDisabled,
  compactDisabledReason,
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
  readonly compactDisabledReason?: string | null | undefined;
}) {
  if (!usage) {
    return (
      <ThreadDetailsSection title="Context window" variant="usage">
        <UsageRow
          label="Context"
          icon={<GaugeIcon />}
          fill={null}
          tone={null}
          value="N/A"
          tooltip="The provider has not reported context usage."
        />
      </ThreadDetailsSection>
    );
  }
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used = maxTokens !== null ? Math.max(0, Math.min(100, usage.usedPercentage ?? 0)) : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const tokens =
    maxTokens !== null
      ? `${formatContextWindowTokens(usage.usedTokens)} / ${formatContextWindowTokens(maxTokens)}`
      : `${formatContextWindowTokens(usage.usedTokens)} tokens`;
  return (
    <ThreadDetailsSection title="Context window" variant="usage">
      <div className="flex min-h-11 items-center gap-2 ps-3 pe-2 text-meta">
        <ContextWindowMeter
          usage={usage}
          side="left"
          onCompact={onCompact}
          compactDisabled={compactDisabled}
          compactDisabledReason={compactDisabledReason}
          trigger={
            <ThreadDetailsControl
              part="heading"
              aria-label={`Context: ${tokens}${maxTokens !== null ? " tokens" : ""}${used !== null ? `, ${Math.round(used)}% used` : " used"}`}
            >
              <GaugeIcon className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col gap-1 text-meta">
                <span className="flex items-center justify-between gap-2 text-foreground">
                  <span>Context</span>
                  {used !== null ? (
                    <span className="tabular-nums text-muted-foreground">{Math.round(used)}%</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  {used !== null ? (
                    <span className="relative h-1 min-w-0 flex-1 rounded-full bg-muted-foreground/20">
                      <span
                        className={cn(
                          "absolute inset-y-0 left-0 rounded-full",
                          used >= 90 ? "bg-error" : used >= 80 ? "bg-warning" : "bg-foreground/80",
                        )}
                        style={{ width: used > 0 ? `max(${used}%, 2px)` : "0%" }}
                      />
                      {tick !== null ? (
                        <span
                          aria-hidden
                          className="absolute -top-[3px] h-2.5 w-0.5 rounded-sm bg-muted-foreground"
                          style={{ left: `${tick}%` }}
                        />
                      ) : null}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                    {tokens}
                  </span>
                </span>
              </span>
            </ThreadDetailsControl>
          }
        />
        <span className="flex w-11 shrink-0 justify-end">
          {onCompact ? (
            <ThreadDetailsControl
              part="icon"
              aria-label="Compact context"
              disabled={compactDisabled}
              onClick={onCompact}
            >
              <Minimize2Icon className="size-3.5" />
            </ThreadDetailsControl>
          ) : null}
        </span>
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const elapsed = elapsedShare(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const remainingMs = resetsAt - now;
  const weekly = (window.windowDurationMins ?? 0) >= 24 * 60 || /week/i.test(window.label);
  const reset =
    remainingMs > 0
      ? weekly
        ? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(resetsAt)
        : formatDuration(remainingMs)
      : null;
  return (
    <UsageRow
      label={window.label}
      icon={weekly ? <CalendarRangeIcon /> : <TimerIcon />}
      fill={left}
      tick={elapsed === null ? null : (1 - elapsed) * 100}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      trailing={
        reset ? (
          <span className="truncate text-caption text-dim-foreground">{reset}</span>
        ) : undefined
      }
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && remainingMs > 0 ? (
            <span>
              <span className="block">Resets in {formatDuration(remainingMs)}</span>
              <span className="block">
                {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
              </span>
            </span>
          ) : null}
          {pace ? <span>{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

function UsageRow({
  label,
  icon,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  trailing,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly fill: number | null;
  readonly tone: UsageTone;
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <Tooltip>
      <div className="flex h-8 items-center gap-2 ps-3 pe-2 text-meta">
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              aria-label={`${label}: ${ariaValue}`}
              className="flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span className="shrink-0 text-muted-foreground [&>svg]:size-4">{icon}</span>
          <span className="w-14.5 shrink-0 truncate">{label}</span>
          {fill !== null ? (
            <span className="relative h-1 min-w-0 flex-1 rounded-full bg-muted-foreground/20">
              {fill > 0 ? (
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    tone === "error"
                      ? "bg-error"
                      : tone === "warning"
                        ? "bg-warning"
                        : "bg-foreground/80",
                  )}
                  style={{ width: `max(${fill}%, 2px)` }}
                />
              ) : null}
              {tick !== null ? (
                <span
                  aria-hidden
                  className="absolute -top-[3px] h-2.5 w-0.5 rounded-sm bg-muted-foreground"
                  style={{ left: `${tick}%` }}
                />
              ) : null}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span
            className={cn(
              "w-7.5 shrink-0 text-end tabular-nums text-muted-foreground",
              fill === null && "w-auto",
              tone === "error" && "text-error-foreground",
              tone === "warning" && "text-warning-foreground",
            )}
          >
            {value}
          </span>
        </TooltipTrigger>
        <span className="flex w-11 shrink-0 justify-end">{trailing}</span>
      </div>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5 text-muted-foreground">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
