import { T, useGT } from "gt-react";
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
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

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);

  return (
    <ThreadDetailsSection headingId="thread-details-usage-heading" title="Usage limits">
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label="Limits"
            fill={null}
            tone={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : (
          limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const gt = useGT();
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const input = usage.inputTokens ?? null;
  const cached = usage.cachedInputTokens ?? null;
  const output = usage.outputTokens ?? null;
  const total = input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null;
  const rows = [
    ...(cached !== null ? [{ label: gt("Cache read"), value: cached, color: "bg-blue-400" }] : []),
    ...(output !== null ? [{ label: gt("Output"), value: output, color: "bg-emerald-400" }] : []),
    ...(input !== null
      ? [
          {
            label: cached !== null ? gt("Uncached input") : gt("Input"),
            value: Math.max(0, input - (cached ?? 0)),
            color: "bg-amber-400",
          },
        ]
      : []),
  ];
  return (
    <ThreadDetailsSection headingId="thread-details-context-heading" title={gt("Context")}>
      <div className="space-y-3 px-2.5 pb-0.5 text-xs">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2 tabular-nums">
            <span className="text-sm text-foreground">
              {used !== null ? (
                <>
                  {used}% <T>used</T>
                </>
              ) : (
                <>
                  {formatContextWindowTokens(usage.usedTokens)} <T>tokens</T>
                </>
              )}
            </span>
            <span className="text-muted-foreground">
              {formatContextWindowTokens(usage.usedTokens)}
              {maxTokens !== null ? ` / ${formatContextWindowTokens(maxTokens)}` : ""}
            </span>
          </div>
          {used !== null ? (
            <div
              role="progressbar"
              aria-label={gt("Context usage")}
              aria-valuenow={used}
              aria-valuemin={0}
              aria-valuemax={100}
              className="relative h-1.5 rounded-full bg-muted-foreground/20"
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  used >= 90 ? "bg-error" : used >= 80 ? "bg-warning" : "bg-foreground",
                )}
                style={{ width: `${used}%` }}
              />
              {tick !== null ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        aria-label={
                          threshold !== null
                            ? formatContextWindowCompactionMessage(threshold)
                            : undefined
                        }
                        tabIndex={0}
                        className="absolute -top-0.5 h-2.5 w-px bg-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        style={{ left: `${tick}%` }}
                      />
                    }
                  />
                  <TooltipPopup>
                    {threshold !== null ? formatContextWindowCompactionMessage(threshold) : null}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </div>
        {rows.length > 0 ? (
          <div className="space-y-1.5 border-t border-border/65 pt-3">
            <div className="flex justify-between gap-2">
              <span>
                <T>Reported usage</T>
              </span>
              <span className="tabular-nums">
                {total !== null ? formatContextWindowTokens(total) : ""} <T>tokens</T>
              </span>
            </div>
            <dl className="space-y-1">
              {rows.map((row) => (
                <div key={row.label} className="flex items-center gap-2 text-muted-foreground">
                  <span aria-hidden className={cn("size-2.5 shrink-0 rounded-sm", row.color)} />
                  <dt className="min-w-0 flex-1 truncate">{row.label}</dt>
                  <dd className="flex shrink-0 gap-3 tabular-nums">
                    <span>{formatContextWindowTokens(row.value)}</span>
                    {total !== null && total > 0 ? (
                      <span className="w-10 text-right text-foreground/80">
                        {((row.value / total) * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
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
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
