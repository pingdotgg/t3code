import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { formatPercent, formatUsd } from "@t3tools/shared/usageFormat";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Fragment, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useThreadUsage } from "../../state/usage";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { costTypeSegments } from "../usage/usageBreakdown";
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
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
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

/** The thread's own figures. They share one grid, so their labels and values line up. */
export function ThreadDetailsStats({
  contextWindow,
  cost,
}: {
  readonly contextWindow: ContextWindowSnapshot | null;
  /** The thread to price. Null hides the cost row. */
  readonly cost: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}) {
  return (
    <ThreadDetailsSection
      headingId="thread-details-stats-heading"
      title="Context and cost"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {contextWindow ? <ContextRow usage={contextWindow} /> : null}
        {cost ? <CostRow {...cost} /> : null}
      </div>
    </ThreadDetailsSection>
  );
}

/** The bar fills as context is used; the tick marks auto-compaction. */
function ContextRow({ usage }: { readonly usage: ContextWindowSnapshot }) {
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
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <UsageRow
      label="Context"
      fill={used}
      tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
      tick={tick}
      muted
      value={
        maxTokens !== null ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}` : usedTokens
      }
      ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
      tooltip={
        <>
          <span className="text-foreground">
            {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
          </span>
          {maxTokens !== null ? (
            <span className="text-muted-foreground">
              {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
              tokens
            </span>
          ) : null}
          {threshold !== null && threshold > 0 ? (
            <span className="text-muted-foreground">
              {formatContextWindowCompactionMessage(threshold)}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/**
 * What the thread's model usage would cost at API prices, as the Usage tab prices it. A figure,
 * not a meter, so it has no bar. Renders nothing until the server reports usage for the thread.
 */
function CostRow({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const usage = useThreadUsage({ environmentId, threadId });
  // No records means the provider's usage is not read here, which is not a cost of zero.
  if (usage === null || usage.records === 0) return null;
  const { unpricedShare } = usage.costQuality;
  if (unpricedShare >= 1) {
    return (
      <UsageRow
        label="Cost"
        fill={null}
        tone={null}
        value="Unpriced"
        tooltip={
          <>
            <span className="text-foreground">Cost: no known price for this model</span>
            <span className="text-muted-foreground">
              {formatContextWindowTokens(usage.totalTokens)} tokens
            </span>
          </>
        }
      />
    );
  }
  const value = formatCost(usage.costUsd);
  // A part that rounds to no cents says nothing next to the total.
  const parts = costTypeSegments(usage.categoryCost).filter((part) => part.value >= 0.005);
  return (
    <UsageRow
      label="Cost"
      fill={null}
      tone={null}
      dimValue={false}
      value={value}
      tooltip={
        <>
          <span className="text-foreground">Cost: {value} · API estimate</span>
          {parts.length > 0 ? (
            <span className="my-1 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5">
              {parts.map((part) => (
                <Fragment key={part.label}>
                  <span className="text-muted-foreground">{part.label}</span>
                  <span className="text-end text-foreground tabular-nums">
                    {formatUsd(part.value)}
                  </span>
                </Fragment>
              ))}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {formatContextWindowTokens(usage.totalTokens)} tokens
          </span>
          {unpricedShare > 0 ? (
            <span className="text-muted-foreground">
              Excludes {formatPercent(unpricedShare)} unpriced records
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** A cost that rounds to no cents still cost something. */
function formatCost(usd: number): string {
  return usd > 0 && usd < 0.005 ? "<$0.01" : formatUsd(usd);
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
  dimValue,
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
  /** A row without a bar dims its value, as a notice. False keeps it a figure. */
  readonly dimValue?: boolean;
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
                : (dimValue ?? fill === null)
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
