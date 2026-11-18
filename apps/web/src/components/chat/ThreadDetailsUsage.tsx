import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
  UsageLimitsReport,
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

interface ThreadDetailsResolvedLimits {
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly isLimited?: boolean;
  readonly notice?: string | null;
}

function resolveThreadDetailsLimits(
  report: UsageLimitsReport | null,
  providerInstanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
): ThreadDetailsResolvedLimits | null {
  if (providerInstanceId === null) return null;

  const instanceLimits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;

  // If the instance itself has native, working limits, prefer them.
  if (instanceLimits && !limitsNotice(instanceLimits) && instanceLimits.windows.length > 0) {
    return { windows: instanceLimits.windows, isLimited: false, notice: null };
  }

  // Otherwise, look across accounts in the pool for this driver
  const driver = providers.find((p) => p.instanceId === providerInstanceId)?.driver;
  const pooledAccounts = (report?.accounts ?? []).filter((account) => {
    if (driver && account.driver !== driver) return false;
    return Boolean(
      account.limits && account.limits.windows.length > 0 && !account.limits.unavailable?.reason,
    );
  });

  // 1. Accounts with a 5-hour window
  const accountsWith5h = pooledAccounts
    .map((acc) => {
      const sessionWindow = acc.limits.windows.find(
        (w) => w.kind === "session" || (w.windowDurationMins ?? 0) <= 300,
      );
      if (!sessionWindow) return null;
      const weeklyWindow = acc.limits.windows.find(
        (w) =>
          w.kind === "weekly" ||
          ((w.windowDurationMins ?? 0) > 300 && (w.windowDurationMins ?? 0) <= 10080),
      );
      const sessionRemaining = remainingPercent(sessionWindow);
      const weeklyRemaining = weeklyWindow ? remainingPercent(weeklyWindow) : null;
      return {
        sessionWindow,
        weeklyWindow,
        sessionRemaining,
        weeklyRemaining,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const nonZero5h = accountsWith5h.filter((entry) => entry.sessionRemaining > 0);

  // Берём минимальный пятичасового и у него уже берём недельный (показываем вместе)
  if (nonZero5h.length > 0) {
    nonZero5h.sort((a, b) => {
      if (a.sessionRemaining !== b.sessionRemaining) {
        return a.sessionRemaining - b.sessionRemaining;
      }
      if (a.weeklyRemaining !== null && b.weeklyRemaining !== null) {
        return a.weeklyRemaining - b.weeklyRemaining;
      }
      return 0;
    });
    const chosen = nonZero5h[0];
    if (chosen) {
      const windows = [chosen.sessionWindow, chosen.weeklyWindow].filter(
        (w): w is ServerProviderUsageWindow => Boolean(w),
      );
      return { windows, isLimited: false, notice: null };
    }
  }

  // Если все по нулям, то у месячного берём максимальный (если ток месячный у аккаунта, то пишем Limited)
  const accountsWithMonthly = pooledAccounts
    .map((acc) => {
      const monthlyWindow = acc.limits.windows.find(
        (w) => w.kind === "monthly" || (w.windowDurationMins ?? 0) > 10080,
      );
      if (!monthlyWindow) return null;
      const monthlyRemaining = remainingPercent(monthlyWindow);
      const onlyMonthly = acc.limits.windows.every(
        (w) => w.kind === "monthly" || w.id === monthlyWindow.id,
      );
      return {
        monthlyWindow,
        monthlyRemaining,
        onlyMonthly,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (accountsWithMonthly.length > 0) {
    accountsWithMonthly.sort((a, b) => b.monthlyRemaining - a.monthlyRemaining);
    const chosen = accountsWithMonthly[0];
    if (chosen) {
      return {
        windows: [chosen.monthlyWindow],
        isLimited: chosen.onlyMonthly,
        notice: null,
      };
    }
  }

  // Если нет месячных, но есть 5-часовые (все с 0% остатка), показываем 5-часовой и недельный
  if (accountsWith5h.length > 0) {
    accountsWith5h.sort((a, b) => {
      const resetA = a.sessionWindow.resetsAt
        ? Date.parse(a.sessionWindow.resetsAt)
        : Number.POSITIVE_INFINITY;
      const resetB = b.sessionWindow.resetsAt
        ? Date.parse(b.sessionWindow.resetsAt)
        : Number.POSITIVE_INFINITY;
      return resetA - resetB;
    });
    const chosen = accountsWith5h[0];
    if (chosen) {
      const windows = [chosen.sessionWindow, chosen.weeklyWindow].filter(
        (w): w is ServerProviderUsageWindow => Boolean(w),
      );
      return { windows, isLimited: false, notice: null };
    }
  }

  // Fallback к стандартному поведению инстанса
  if (!instanceLimits) return null;
  const notice = limitsNotice(instanceLimits);
  return { windows: instanceLimits.windows, isLimited: false, notice };
}

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

  const resolved = resolveThreadDetailsLimits(report, providerInstanceId, providers);
  if (!resolved) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {resolved.notice ? (
          <UsageRow
            label="Limits"
            fill={null}
            tone={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{resolved.notice}</span>}
          />
        ) : (
          <>
            {resolved.isLimited ? (
              <UsageRow
                label="Limits"
                fill={null}
                tone="warning"
                value="Limited"
                tooltip={<span className="text-foreground">Limited plan</span>}
              />
            ) : null}
            {resolved.windows.map((window) => (
              <LimitRow key={window.id} window={window} now={now} />
            ))}
          </>
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
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
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Context"
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
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
