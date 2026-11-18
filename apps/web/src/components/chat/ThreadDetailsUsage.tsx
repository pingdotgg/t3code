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
  type LimitPace,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { msg, useGT, useLocale, useMessages } from "gt-react";
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
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
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
  const gt = useGT();
  const m = useMessages();
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
  const notice = limitsNotice(limits, m);

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label={gt("Limits", { $context: "usage limits row label" })}
            fill={null}
            tone={null}
            value={gt("Unavailable")}
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
  const gt = useGT();
  return (
    <ThreadDetailsSection
      headingId="thread-details-stats-heading"
      title={gt("Context and cost")}
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
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <UsageRow
      label={gt("Context", { $context: "context window row label" })}
      fill={used}
      tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
      tick={tick}
      muted
      value={
        maxTokens !== null ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}` : usedTokens
      }
      ariaValue={
        used !== null
          ? gt("{used}% used", { used })
          : gt("{usedTokens} tokens used", { usedTokens })
      }
      tooltip={
        <>
          <span className="text-foreground">
            {used !== null
              ? gt("Context: {used}% used", { used })
              : gt("Context: {usedTokens} tokens used", { usedTokens })}
          </span>
          {maxTokens !== null ? (
            <span className="text-muted-foreground">
              {gt("{used} of {max} tokens", {
                used: usage.usedTokens.toLocaleString(locale),
                max: maxTokens.toLocaleString(locale),
              })}
            </span>
          ) : null}
          {threshold !== null && threshold > 0 ? (
            <span className="text-muted-foreground">
              {formatContextWindowCompactionMessage(threshold, m)}
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
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usage = useThreadUsage({ environmentId, threadId });
  // No records means the provider's usage is not read here, which is not a cost of zero.
  if (usage === null || usage.records === 0) return null;
  const tokens = gt("{tokens} tokens", { tokens: formatContextWindowTokens(usage.totalTokens) });
  const label = gt("Cost", { $context: "thread cost row label" });
  const { unpricedShare } = usage.costQuality;
  if (unpricedShare >= 1) {
    return (
      <UsageRow
        label={label}
        fill={null}
        tone={null}
        value={gt("Unpriced")}
        tooltip={
          <>
            <span className="text-foreground">{gt("Cost: no known price for this model")}</span>
            <span className="text-muted-foreground">{tokens}</span>
          </>
        }
      />
    );
  }
  const value = formatCost(usage.costUsd, locale);
  // A part that rounds to no cents says nothing next to the total.
  const parts = costTypeSegments(usage.categoryCost).filter((part) => part.value >= 0.005);
  return (
    <UsageRow
      label={label}
      fill={null}
      tone={null}
      dimValue={false}
      value={value}
      tooltip={
        <>
          <span className="text-foreground">{gt("Cost: {value} · API estimate", { value })}</span>
          {parts.length > 0 ? (
            <span className="my-1 grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5">
              {parts.map((part) => (
                <Fragment key={part.label}>
                  <span className="text-muted-foreground">{m(part.label)}</span>
                  <span className="text-end text-foreground tabular-nums">
                    {formatUsd(part.value, locale)}
                  </span>
                </Fragment>
              ))}
            </span>
          ) : null}
          <span className="text-muted-foreground">{tokens}</span>
          {unpricedShare > 0 ? (
            <span className="text-muted-foreground">
              {gt("Excludes {share} unpriced records", { share: formatPercent(unpricedShare) })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** A cost that rounds to no cents still cost something. */
function formatCost(usd: number, locale: string): string {
  return usd > 0 && usd < 0.005 ? `<${formatUsd(0.01, locale)}` : formatUsd(usd, locale);
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
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
      ariaValue={gt("{left}% left", { left })}
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{m(PACE_LABEL[pace])}</span> : null}
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
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={gt("{label}: {value}", { label, value: ariaValue })}
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
