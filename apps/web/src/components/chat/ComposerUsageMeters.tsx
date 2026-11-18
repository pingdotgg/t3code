import type { UsageBudgetStatus, UsageBudgetWindow } from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useContextWindowMeter,
  UsageBar,
  usageValueTone,
  type UsageTone,
} from "./ThreadDetailsUsage";

/** The thread's context window and the spend of every session on this machine, for the composer footer. */
export function ComposerUsageMeters({
  contextWindow,
  budget,
}: {
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly budget: UsageBudgetStatus | null;
}) {
  if (contextWindow === null && budget === null) return null;
  return (
    <div data-chat-composer-usage="true" className="flex shrink-0 items-center text-xs">
      {contextWindow !== null ? <ContextMeter usage={contextWindow} /> : null}
      {budget !== null ? <BudgetMeters budget={budget} /> : null}
    </div>
  );
}

function ContextMeter({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const meter = useContextWindowMeter(usage);
  return (
    <Meter
      label="Context"
      fill={meter.fill}
      tone={meter.tone}
      tick={meter.tick}
      value={meter.value.replaceAll(" ", "")}
      ariaValue={meter.ariaValue}
      tooltip={meter.tooltip}
    />
  );
}

function BudgetMeters({ budget }: { readonly budget: UsageBudgetStatus }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const override =
    budget.overrideUntil !== null ? (
      <span className="text-muted-foreground">
        Limits overridden until{" "}
        {formatUpcomingTimestamp(budget.overrideUntil, timestampFormat, now)}
      </span>
    ) : null;
  return (
    <>
      <SpendMeter
        label="Hour"
        unit="hr"
        period="Last 60 minutes"
        window={budget.hour}
        details={override}
      />
      <SpendMeter
        label="Today"
        unit="today"
        period="Today"
        window={budget.day}
        details={
          <>
            <span className="text-muted-foreground">
              Resets {formatUpcomingTimestamp(budget.day.resetsAt, timestampFormat, now)}
            </span>
            {override}
          </>
        }
      />
      {budget.cacheHitPercent !== null ? (
        <Meter
          label="Cache"
          unit="cache"
          fill={null}
          tone={null}
          value={`${Math.round(budget.cacheHitPercent)}%`}
          tooltip={
            <>
              <span className="text-foreground">
                Cache: {budget.cacheHitPercent.toFixed(1)}% of today's prompt tokens
              </span>
              <span className="text-muted-foreground">All sessions on this machine</span>
            </>
          }
        />
      ) : null}
    </>
  );
}

function SpendMeter({
  label,
  unit,
  period,
  window,
  details,
}: {
  readonly label: string;
  readonly unit: string;
  readonly period: string;
  readonly window: UsageBudgetWindow;
  readonly details: ReactNode;
}) {
  const { costUsd, softLimitUsd, hardLimitUsd } = window;
  const tone: UsageTone =
    hardLimitUsd !== null && costUsd >= hardLimitUsd
      ? "error"
      : softLimitUsd !== null && costUsd >= softLimitUsd
        ? "warning"
        : null;
  const cost = formatUsd(costUsd);
  return (
    <Meter
      label={label}
      unit={unit}
      fill={hardLimitUsd !== null ? (costUsd / hardLimitUsd) * 100 : null}
      tone={tone}
      tick={
        hardLimitUsd !== null && softLimitUsd !== null ? (softLimitUsd / hardLimitUsd) * 100 : null
      }
      hideBarWhenNarrow
      value={hardLimitUsd !== null ? `${cost}/${formatUsd(hardLimitUsd)}` : cost}
      tooltip={
        <>
          <span className="text-foreground">
            {period}: ${costUsd.toFixed(2)}
            {hardLimitUsd !== null ? ` of $${hardLimitUsd.toFixed(2)}` : ""}
          </span>
          <span className="text-muted-foreground">All sessions on this machine</span>
          {softLimitUsd !== null ? (
            <span className="text-muted-foreground">Warns at ${softLimitUsd.toFixed(2)}</span>
          ) : null}
          {details}
        </>
      }
    />
  );
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

/** A short bar, a value, and its unit; hovering or focusing it opens the details tooltip. */
function Meter({
  label,
  unit,
  fill,
  tone,
  tick = null,
  hideBarWhenNarrow = false,
  value,
  ariaValue = value,
  tooltip,
}: {
  readonly label: string;
  readonly unit?: string;
  readonly fill: number | null;
  readonly tone: UsageTone;
  readonly tick?: number | null;
  readonly hideBarWhenNarrow?: boolean;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="flex h-6 cursor-default items-center gap-1 rounded-md px-1 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        {fill !== null ? (
          <UsageBar
            fill={fill}
            tone={tone}
            tick={tick}
            muted
            className={cn("w-5", hideBarWhenNarrow && "@max-[44rem]/composer-surface:hidden")}
          />
        ) : null}
        <span className={cn("tabular-nums", usageValueTone(tone, "text-muted-foreground"))}>
          {value}
        </span>
        {unit !== undefined ? <span className="text-muted-foreground/60">{unit}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top" sideOffset={8}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
