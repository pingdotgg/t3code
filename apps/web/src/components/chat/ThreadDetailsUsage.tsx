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
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ContextWindowSegments } from "./ContextWindowMeter";
import { contextWindowSegments } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

// The canvas reserves the same icon, label, meter, percent and trailing columns in every row.
const USAGE_ROW_CLASS =
  "grid grid-cols-[1rem_3.625rem_minmax(0,1fr)_1.875rem_2.75rem] items-center gap-x-2 ps-3 pe-2 text-meta";

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
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
}) {
  const [collapsed, setCollapsed] = useLocalStorage(
    "thread-details:collapsed:Context breakdown",
    true,
    Schema.Boolean,
  );
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
  const tokens =
    maxTokens !== null
      ? `${formatContextWindowTokens(usage.usedTokens)} / ${formatContextWindowTokens(maxTokens)}`
      : `${formatContextWindowTokens(usage.usedTokens)} tokens`;
  return (
    <ThreadDetailsSection title="Context window" variant="usage">
      <Collapsible open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
        {/* The trailing column shrinks to the compact button so it sits flush right. */}
        <div
          className={cn(
            USAGE_ROW_CLASS,
            "h-8 grid-cols-[1rem_3.625rem_minmax(0,1fr)_1.875rem_1.5rem]",
          )}
        >
          <CollapsibleTrigger
            render={<ThreadDetailsControl part="usage" />}
            aria-label={`Context: ${tokens}${maxTokens !== null ? " tokens" : ""}${used !== null ? `, ${Math.round(used)}% used` : " used"}`}
          >
            <GaugeIcon className="size-4 shrink-0" />
            <span className="flex h-6 items-center text-foreground">Context</span>
            {used !== null ? <ContextWindowSegments usage={usage} minSegmentWidth={2} /> : <span />}
            <span className="text-end tabular-nums text-muted-foreground">
              {used !== null ? `${Math.round(used)}%` : ""}
            </span>
          </CollapsibleTrigger>
          <span className="flex">
            {onCompact ? (
              <Button
                size="icon-xs"
                variant="secondary"
                aria-label="Compact context"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon className="size-[13px]" />
              </Button>
            ) : null}
          </span>
        </div>
        <CollapsiblePanel>
          <div className="px-0.5 pb-0.5">
            <div className="surface-composer rounded-lg p-0.5">
              <dl className="text-meta">
                {contextWindowSegments(usage).map((segment) => (
                  <div
                    key={segment.label}
                    className="flex h-8 items-center justify-between gap-2 px-2.5"
                  >
                    <dt className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className={cn("size-2 shrink-0 rounded-xs", segment.color)}
                      />
                      {segment.label}
                    </dt>
                    <dd className="text-caption tabular-nums text-muted-foreground">
                      {segment.tokens.toLocaleString("en-US")}
                    </dd>
                  </div>
                ))}
                <div className="flex min-h-8 items-center justify-between gap-2 px-2.5">
                  <dt>{maxTokens !== null ? "Used / max" : "Used"}</dt>
                  <dd className="text-caption tabular-nums text-muted-foreground">
                    {usage.usedTokens.toLocaleString("en-US")}
                    {maxTokens !== null ? ` / ${maxTokens.toLocaleString("en-US")}` : null}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
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
      <div className={cn(USAGE_ROW_CLASS, "h-8")}>
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              aria-label={`${label}: ${ariaValue}`}
              className={cn(
                "grid min-w-0 cursor-default grid-cols-subgrid items-center gap-x-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                fill === null ? "col-span-5" : "col-span-4",
              )}
            />
          }
        >
          <span className="shrink-0 text-muted-foreground [&>svg]:size-4">{icon}</span>
          <span className="truncate">{label}</span>
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
          ) : null}
          <span
            className={cn(
              "text-end tabular-nums text-muted-foreground",
              fill === null && "col-span-3",
              tone === "error" && "text-error-foreground",
              tone === "warning" && "text-warning-foreground",
            )}
          >
            {value}
          </span>
        </TooltipTrigger>
        {fill !== null ? <span className="flex justify-end">{trailing}</span> : null}
      </div>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5 text-muted-foreground">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
