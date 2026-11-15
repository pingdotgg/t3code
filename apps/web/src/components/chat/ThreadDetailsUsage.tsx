import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  resolveProviderLimitPool,
  resolveProviderUsageLimits,
  displayLimitWindows,
  elapsedShare,
  formatDuration,
  type LimitPace,
  type LimitPoolWindow,
  limitPoolNotice,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { BoxIcon, CalendarRangeIcon, GaugeIcon, Minimize2Icon, TimerIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { observeResize } from "../../lib/observeResize";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ContextWindowSegments } from "./ContextWindowMeter";
import { contextWindowSegments } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const USAGE_ROW_CLASS =
  "col-span-full grid min-w-0 grid-cols-subgrid items-center gap-x-1.5 text-meta";

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

/** Provider limits share the canvas's icon and label columns. */
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
  const ownNotice = limits ? limitsNotice(limits) : "This provider has not reported usage limits.";
  const pool =
    providerInstanceId !== null && ownNotice !== null
      ? resolveProviderLimitPool(providerInstanceId, providers, sources, now)
      : undefined;
  const rows = pool
    ? displayLimitWindows(pool).map((pooled) => ({
        window: pooledWindow(pooled, now),
        accounts: pooled.members.length,
      }))
    : (limits?.windows ?? []).map((window) => ({ window, accounts: 1 }));
  const poolNotice =
    providerInstanceId !== null && ownNotice !== null && !pool
      ? limitPoolNotice(providerInstanceId, providers, sources)
      : null;
  const notice = pool ? null : (poolNotice ?? ownNotice);
  return (
    <ThreadDetailsSection title="Usage limits" variant="usage">
      {notice || !rows.length ? (
        <UsageRow
          label="Limits"
          icon={<TimerIcon />}
          fill={null}
          tone={null}
          value={
            poolNotice && !sources.some((source) => source.error) ? "Not linked" : "Unavailable"
          }
          tooltip={notice ?? "No usage windows reported."}
        />
      ) : (
        <>
          {rows.map(({ window, accounts }) => (
            <LimitRow key={window.id} window={window} now={now} pooledAccounts={accounts} />
          ))}
        </>
      )}
    </ThreadDetailsSection>
  );
}

/** Context fills as tokens are used. Compact follows the composer's real provider command. */
export function ThreadDetailsContext({
  usage,
  onCompact,
  compactUnavailableReason,
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly onCompact?: (() => void) | undefined;
  /** Why compacting cannot start now; the button stays hoverable to say so. */
  readonly compactUnavailableReason?: string | null | undefined;
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
      <Collapsible
        className="col-span-full grid grid-cols-subgrid"
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
      >
        <div className={cn(USAGE_ROW_CLASS, "h-8")}>
          <CollapsibleTrigger
            render={<ThreadDetailsControl part="usage" />}
            aria-label={`Context: ${tokens}${maxTokens !== null ? " tokens" : ""}${used !== null ? `, ${Math.round(used)}% used` : " used"}`}
          >
            <GaugeIcon className="size-4 shrink-0" />
            <span className="flex h-6 items-center text-foreground">Context</span>
            <span className={cn("flex items-center gap-1.5", onCompact && "pe-7.5")}>
              <span className="min-w-12 flex-1">
                {used !== null ? <ContextWindowSegments usage={usage} minSegmentWidth={2} /> : null}
              </span>
              <span className="shrink-0 text-end tabular-nums text-muted-foreground">
                {used !== null ? `${Math.round(used)}%` : ""}
              </span>
            </span>
          </CollapsibleTrigger>
          <span className="col-start-3 row-start-1 flex justify-self-end">
            {onCompact ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="secondary"
                      aria-label="Compact context"
                      aria-disabled={compactUnavailableReason ? true : undefined}
                      onClick={compactUnavailableReason ? undefined : onCompact}
                    />
                  }
                >
                  <Minimize2Icon className="size-[13px]" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {compactUnavailableReason ?? "Compact context"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </span>
        </div>
        <CollapsiblePanel className="col-span-full">
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

/** A pool's row: the share left across its accounts, and the next of their resets. */
function pooledWindow(pooled: LimitPoolWindow, now: number): ServerProviderUsageWindow {
  return {
    id: pooled.id,
    kind: pooled.kind,
    label: pooled.label,
    usedPercent: 100 - pooled.remainingPercent,
    resetsAt: pooled.resets.find((reset) => reset.at > now)?.member.window.resetsAt,
  };
}

function resetLabel(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const remainingMs = resetsAt - now;
  if (!(remainingMs > 0)) return null;
  return isWeeklyWindow(window)
    ? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(resetsAt)
    : formatDuration(remainingMs);
}

function isWeeklyWindow(window: ServerProviderUsageWindow): boolean {
  return (window.windowDurationMins ?? 0) >= 24 * 60 || /week/i.test(window.label);
}

function LimitRow({
  window,
  now,
  pooledAccounts,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly pooledAccounts: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const elapsed = elapsedShare(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const remainingMs = resetsAt - now;
  const weekly = isWeeklyWindow(window);
  const modelLabel =
    weekly && window.id.startsWith("seven_day_")
      ? /^Weekly\s*·\s*(.+)$/i.exec(window.label)?.[1]
      : undefined;
  const reset = resetLabel(window, now);
  return (
    <UsageRow
      label={modelLabel ?? window.label}
      shortLabel={weekly && !modelLabel ? window.label.replace(/\s*·\s*Weekly$/i, "") : undefined}
      icon={modelLabel ? <BoxIcon /> : weekly ? <CalendarRangeIcon /> : <TimerIcon />}
      fill={left}
      tick={elapsed === null ? null : (1 - elapsed) * 100}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      trailing={
        reset ? (
          <span className="whitespace-nowrap text-caption text-dim-foreground">{reset}</span>
        ) : undefined
      }
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && remainingMs > 0 ? (
            <span>
              <span className="block">
                {pooledAccounts > 1 ? "Next reset in" : "Resets in"} {formatDuration(remainingMs)}
              </span>
              <span className="block">
                {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
              </span>
            </span>
          ) : null}
          {pace ? <span>{PACE_LABEL[pace]}</span> : null}
          {pooledAccounts > 1 ? <span>Across {pooledAccounts} accounts</span> : null}
        </>
      }
    />
  );
}

function UsageRow({
  label,
  shortLabel,
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
  readonly shortLabel?: string | undefined;
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
              className="col-span-full grid min-w-0 cursor-default grid-cols-subgrid items-center gap-x-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span className="shrink-0 text-muted-foreground [&>svg]:size-4">{icon}</span>
          {shortLabel && shortLabel !== label ? (
            <UsageLabel key={label} label={label} shortLabel={shortLabel} />
          ) : (
            <span className="truncate">{label}</span>
          )}
          <span className="flex items-center justify-end gap-1.5">
            {fill !== null ? (
              <span className="relative h-1 min-w-12 flex-1 rounded-full bg-muted-foreground/20">
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
                "shrink-0 whitespace-nowrap text-end tabular-nums text-muted-foreground",
                tone === "error" && "text-error-foreground",
                tone === "warning" && "text-warning-foreground",
              )}
            >
              {value}
            </span>
            {fill !== null && trailing ? <span className="shrink-0">{trailing}</span> : null}
          </span>
        </TooltipTrigger>
      </div>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5 text-muted-foreground">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

function UsageLabel({
  label,
  shortLabel,
}: {
  readonly label: string;
  readonly shortLabel: string;
}) {
  const fullLabel = useRef<HTMLSpanElement>(null);
  const [shortened, setShortened] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- chooses the shorter label only when the grid's measured space cannot fit the full label
  useLayoutEffect(() => {
    const element = fullLabel.current;
    if (!element) return;
    const measure = () => setShortened(element.scrollWidth > element.clientWidth);
    measure();
    return observeResize(element, measure);
  }, []);
  return (
    <span className="relative min-w-0">
      {/* The full label retains its intrinsic width so shortening cannot oscillate the grid. */}
      <span ref={fullLabel} className={cn("block truncate", shortened && "invisible")}>
        {label}
      </span>
      {shortened ? <span className="absolute inset-0 truncate">{shortLabel}</span> : null}
    </span>
  );
}
