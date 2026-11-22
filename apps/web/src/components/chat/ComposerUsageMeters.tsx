import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { UsageBudgetStatus, UsageBudgetWindow } from "@t3tools/contracts";
import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useContextWindowMeter,
  UsageBar,
  usageValueTone,
  type UsageTone,
} from "./ThreadDetailsUsage";

/** The thread's context window and cache rate beside the spend of every session on this machine. */
export function ComposerUsageMeters({
  contextWindow,
  cacheHitPercent,
  budget,
}: {
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly cacheHitPercent: number | null;
  readonly budget: UsageBudgetStatus | null;
}) {
  if (contextWindow === null && cacheHitPercent === null && budget === null) return null;
  return (
    <div data-chat-composer-usage="true" className="flex shrink-0 items-center text-xs">
      {contextWindow !== null ? <ContextMeter usage={contextWindow} /> : null}
      {cacheHitPercent !== null ? <CacheMeter percent={cacheHitPercent} /> : null}
      {budget !== null ? <BudgetMeters budget={budget} /> : null}
    </div>
  );
}

function ContextMeter({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const gt = useGT();
  const meter = useContextWindowMeter(usage);
  return (
    <Meter
      label={gt("Context")}
      fill={meter.fill}
      tone={meter.tone}
      tick={meter.tick}
      value={meter.value.replaceAll(" ", "")}
      ariaValue={meter.ariaValue}
      tooltip={meter.tooltip}
    />
  );
}

function CacheMeter({ percent }: { readonly percent: number }) {
  const gt = useGT();
  const formatted = percent.toFixed(1);
  return (
    <Meter
      label={gt("Cache")}
      unit={gt("cache")}
      fill={null}
      tone={null}
      value={`${Math.round(percent)}%`}
      tooltip={
        <>
          <span className="text-foreground">
            {gt("Cache: {percent}% of this session's prompt tokens", { percent: formatted })}
          </span>
          <span className="text-muted-foreground">{gt("Current session")}</span>
        </>
      }
    />
  );
}

function BudgetMeters({ budget }: { readonly budget: UsageBudgetStatus }) {
  const gt = useGT();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const override =
    budget.overrideUntil !== null ? (
      <span className="text-muted-foreground">
        {gt("Limits overridden until {time}", {
          time: formatUpcomingTimestamp(budget.overrideUntil, timestampFormat, now),
        })}
      </span>
    ) : null;
  return (
    <>
      <SpendMeter
        label={gt("Hour")}
        unit={gt("hr")}
        period={gt("Last 60 minutes")}
        window={budget.hour}
        details={override}
      />
      <SpendMeter
        label={gt("Today")}
        unit={gt("today")}
        period={gt("Today")}
        window={budget.day}
        details={
          <>
            <span className="text-muted-foreground">
              {gt("Resets {time}", {
                time: formatUpcomingTimestamp(budget.day.resetsAt, timestampFormat, now),
              })}
            </span>
            {override}
          </>
        }
      />
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
  const gt = useGT();
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
            {hardLimitUsd !== null
              ? gt("{period}: ${cost} of ${limit}", {
                  period,
                  cost: costUsd.toFixed(2),
                  limit: hardLimitUsd.toFixed(2),
                })
              : gt("{period}: ${cost}", {
                  period,
                  cost: costUsd.toFixed(2),
                })}
          </span>
          <span className="text-muted-foreground">{gt("All sessions on this machine")}</span>
          {softLimitUsd !== null ? (
            <span className="text-muted-foreground">
              {gt("Warns at ${limit}", { limit: softLimitUsd.toFixed(2) })}
            </span>
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
