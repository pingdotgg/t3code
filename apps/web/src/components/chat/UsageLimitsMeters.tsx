import { useMemo, useState } from "react";
import type { ProviderUsageWindow } from "@t3tools/contracts";
import {
  clampUsagePercent,
  formatUsagePercent,
  formatUsageResetLabel,
  formatUsageRingLabel,
  formatUsageUpdatedAtLabel,
  isUsageWindowCritical,
  pickWorstUsageWindow,
} from "@t3tools/client-runtime/state/provider-usage";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function UsageRing(props: { usedPercent: number }) {
  const normalized = clampUsagePercent(props.usedPercent);
  const isCritical = normalized > 90;
  const usageColor = isCritical
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const digits = formatUsageRingLabel(props.usedPercent);

  return (
    <span className="relative flex size-5 items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 size-full transform-gpu"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          stroke={usageColor}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - normalized / 100)}
          className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      {/*
        The ring leaves roughly 13px of clear space, which fits two digits
        comfortably. A literal 100 needs the tighter tracking to stay inside;
        by then the colour already says "nearly out" on its own, so slightly
        cramped digits are a cosmetic problem, not a legibility one.
      */}
      <span
        className={cn(
          "relative font-medium text-[9px] leading-none tabular-nums",
          isCritical ? "text-error" : "text-muted-foreground",
          digits.length > 2 ? "tracking-tighter" : null,
        )}
        aria-hidden="true"
      >
        {digits}
      </span>
    </span>
  );
}

function UsageWindowSummary(props: { window: ProviderUsageWindow; nowMs: number | null }) {
  // `nowMs` stays null until the popover opens. Measuring the countdown
  // against epoch zero instead would render every reset as decades past.
  const resetLabel =
    props.nowMs === null ? null : formatUsageResetLabel(props.window.resetsAt, props.nowMs);
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className="text-secondary-label">{props.window.label}</span>
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "font-medium tabular-nums",
            isUsageWindowCritical(props.window) ? "text-error" : "text-secondary-label",
          )}
        >
          {formatUsagePercent(props.window.usedPercent)}
        </span>
        {resetLabel ? <span className="text-muted-foreground">· {resetLabel}</span> : null}
      </span>
    </div>
  );
}

function UsageMeterButton(props: {
  windows: ReadonlyArray<ProviderUsageWindow>;
  ringWindow: ProviderUsageWindow;
  title: string;
  updatedAt: string | null;
  onOpen: (() => void) | undefined;
}) {
  // Stamped when the popover opens, not at render, and not on a ticker.
  //
  // The composer footer is memoised and these props barely change, so a
  // render-time `Date.now()` would be captured once and then reused for the
  // life of the mount — a countdown frozen at whatever it read hours ago. A
  // ticking timer would fix that but repaint the composer forever for labels
  // this coarse ("in 2h 15m", "as of 12m ago"). Reading the clock on open is
  // the only moment the numbers are actually looked at.
  const [openedAtMs, setOpenedAtMs] = useState<number | null>(null);
  const staleLabel =
    openedAtMs === null ? null : formatUsageUpdatedAtLabel(props.updatedAt, openedAtMs);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setOpenedAtMs(Date.now());
          props.onOpen?.();
        }
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={`${props.ringWindow.label} usage ${formatUsagePercent(
              props.ringWindow.usedPercent,
            )} used`}
          >
            <UsageRing usedPercent={props.ringWindow.usedPercent} />
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-56 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="font-medium text-muted-foreground text-xs">{props.title}</div>
          <div className="flex flex-col gap-1">
            {props.windows.map((window) => (
              <UsageWindowSummary key={window.id} window={window} nowMs={openedAtMs} />
            ))}
          </div>
          {staleLabel ? (
            <div className="text-[11px] text-muted-foreground leading-4">{staleLabel}</div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Account quota meters for the composer footer, sized to sit beside
 * `ContextWindowMeter` without looking like a different control.
 *
 * Renders nothing at all when the provider reports no windows — Cursor,
 * Grok, and OpenCode never will — so switching threads between providers
 * costs no layout shift.
 *
 * In compact mode the row collapses to a single circle showing the bucket
 * closest to running out, with the full breakdown still one hover away. The
 * container it lives in is `flex-nowrap shrink-0`, so three 28px buttons is
 * ~100px that cannot yield to the send button when the composer narrows.
 */
export function UsageLimitsMeters(props: {
  windows: ReadonlyArray<ProviderUsageWindow>;
  updatedAt: string | null;
  compact: boolean;
  providerDisplayName: string | null;
  onRequestRefresh: () => void;
}) {
  const { windows, compact } = props;
  const worstWindow = useMemo(() => pickWorstUsageWindow(windows), [windows]);
  const title = props.providerDisplayName ? `${props.providerDisplayName} usage` : "Usage";

  if (windows.length === 0 || worstWindow === null) {
    return null;
  }

  if (compact) {
    return (
      <UsageMeterButton
        windows={windows}
        ringWindow={worstWindow}
        title={title}
        updatedAt={props.updatedAt}
        onOpen={props.onRequestRefresh}
      />
    );
  }

  return (
    <>
      {windows.map((window) => (
        <UsageMeterButton
          key={window.id}
          windows={windows}
          ringWindow={window}
          title={title}
          updatedAt={props.updatedAt}
          onOpen={props.onRequestRefresh}
        />
      ))}
    </>
  );
}
